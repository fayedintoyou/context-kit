# Design

## Context

- **No GitHub client library.** `change_status` already uses `gh` when it's available, but only as
  optional enrichment: on failure it returns `not_collected`. That's unsuitable for a gate, which
  must fail closed.
- **Writes are explicit.** Merging publishes, so `land_pull_request` is `cliOnly: true, write: true`,
  like `archive_ready`. It's never offered over MCP, even with writes enabled. These flags control
  exposure, not authorization: the CLI already runs with writes allowed, and the trust model says what
  this does and doesn't stop.
- **`agents install` already manages records by kind:** skills, MCP servers, and git pull hooks in the
  workspace checkout.

## Trust model and residual bypasses

The command makes the gated path the easy path. The tripwire catches the habitual raw path in Claude
Code. They don't stop:
- an agent that disables the hook or calls the API another way (`curl`, a script);
- runtimes without pre-command hooks;
- a skip reason the agent writes itself (though it's posted publicly on the pull request);
- a review record the agent posts itself.

`gh` comments carry the merging user's identity, so authorship can't prove independence. A record is
audit evidence, and the stronger guarantee would need a trusted producer, out of scope here. The docs
and the command's help say this plainly.

## Which repository, and which policy

- **One repository identity** decides both the policy and every GitHub call: `--repo owner/name` if
  given, otherwise the `origin` remote of the git checkout in the current directory. If `GH_REPO` is
  set and names another repository, it refuses (`REPO_AMBIGUOUS`). Every call names
  `repos/<owner>/<name>/…` explicitly, so `gh`'s own inference never applies. The workspace `--root`
  plays no part in landing.
- **The policy comes from the default branch,** read through the contents API at the default branch's
  current tip SHA (`.context-kit/landing.json`). Not the local working tree, so dirty or stale local
  files don't matter, and not the pull request's head, so a pull request can't loosen its own gate. The
  result reports the provenance: path, branch and SHA. A base that moves after this read refuses at the
  refresh (`BASE_MOVED`).
- **No policy:** `pr land` refuses (`NO_POLICY`); it never guesses which checks matter.
- **Bootstrap:** the pull request that first adds the policy lands with `--bootstrap-policy`, accepted
  only when the default branch has no policy and the head adds one. The head's policy is then used,
  and the pull request is substantial (it touches `.context-kit/`), so it needs a review or a posted
  skip.

## Landing policy (`.context-kit/landing.json`)

```json
{
  "expectedChecks": [
    { "name": "test", "app": "github-actions", "workflow": ".github/workflows/deploy.yml", "event": "pull_request" },
    { "name": "preview", "app": "github-actions", "workflow": ".github/workflows/deploy.yml", "event": "pull_request",
      "skippable": "previews deploy only when the branch has changes" },
    { "name": "openspec / archive-rehearsal", "app": "github-actions", "workflow": ".github/workflows/openspec.yml", "event": "pull_request" },
    { "context": "ci/legacy", "kind": "status" }
  ],
  "routine": { "paths": ["docs/**", "README.md"], "excludePaths": ["openspec/**"] }
}
```

The schema is validated strictly; unknown keys or a malformed file refuse (`INVALID_POLICY`).
- **A check run** (`kind` `check_run`, the default) is identified by all of `name`, `app` (the
  producing GitHub App's slug) and, when the app is `github-actions`, `workflow` (the workflow file
  path) and `event` (the event that triggered the run). All four are required for Actions checks;
  for other apps, `name` and `app` are required.
- **A commit status** (`kind` `status`) is identified by its `context`, optionally with the `creator`
  login.
- **`skippable`** is a reason on one exact entry, so a skip only ever exempts that producer.
- **`expectedChecks: []`** is allowed, but then landing requires `--no-checks "<alternative validation
  and link>"`, which is posted on the pull request. With expected checks present, `--no-checks` is
  refused (`INVALID_INPUT`).

## Decisions

### Collecting evidence (fail closed)

- Everything is read with `gh api --paginate`: the pull request, changed files, check runs and commit
  statuses for the head SHA, the Actions workflow runs for the head SHA, issue comments, reviews,
  labels, the repository's default branch and merge settings, and open pull requests whose base is the
  head ref.
- **Completeness:** the changed files must equal the pull request's `changed_files`. Over GitHub's
  3,000-file listing cap, or on any mismatch, read error or malformed response, it refuses
  (`EVIDENCE_INCOMPLETE`). Missing data never means routine or passing.

### Expected checks

- **How workflow identity is known:** a check run carries `app.slug` and `check_suite.id`. For
  `github-actions`, it is joined to the workflow run (`/actions/runs?head_sha=<sha>`) with the same
  `check_suite_id`, which gives `path` and `event`. The join is used only for identity, which doesn't
  change between attempts; nothing is ordered by `run_attempt`, which restarts at 1 for every new
  workflow run. GitHub may report `path` with a ref suffix (`.github/workflows/deploy.yml@main`): the
  suffix is dropped before comparing with the policy's bare path. A check run that can't be joined
  doesn't count for any Actions entry. Same-named checks from other workflows, events or apps never
  match.
- **Current means latest:** among the check runs matching one entry, the one created last wins, by
  check run `id` (GitHub assigns ids in creation order; a queued run has no `started_at`, so time isn't
  used). A re-run attempt and a new workflow run both create new check runs, so either supersedes what
  came before: an older run's success on its third attempt doesn't outweigh a newer run that failed or
  is pending. A superseded failure doesn't block, and a superseded success doesn't pass. Commit statuses use GitHub's latest state per context.
- **Only success passes:** check runs need status `completed` with conclusion `success`, and commit
  statuses need state `success`. `skipped` or `neutral` passes only for an entry with `skippable`, and
  its reason appears in the result. `failure`, `cancelled`, `timed_out`, `action_required`, `error`,
  pending or missing all refuse (`CHECKS_FAILED`, `CHECKS_PENDING`, `CHECKS_MISSING`), naming the
  entry.
- **Waiting:** `--wait` polls pending checks every 20 s until `--timeout` (default 30 minutes). A
  timeout refuses (`CHECKS_PENDING`). A self-hosted runner that's asleep stays pending and never passes.
- **No checks expected:** without `--no-checks`, refuses (`CHECKS_NONE_EXPECTED`).

### Substantial by default

- **Routine only by path exemption:** a pull request is routine only when every changed file
  (including renamed and deleted paths, old and new) matches the policy's routine paths and none
  matches its excluded paths. No label can make a pull request routine.
- **Signals that override everything:** any file under `.github/` or `.context-kit/`, any OpenSpec
  change delta, or the `substantial` label makes it substantial, whatever the paths say.
- **The result names its reasons:** which files and signals made it substantial, or the exemption that
  made it routine.

### Review record

A pull request comment (or review body) containing this block:

```
<!-- context-kit:review -->
Reviewed-SHA: <40-hex sha>
Phase: output
Reviewer: <model or person, and run id>
Outcome: approved | approved-with-deferrals | changes-requested
Findings: <material found / resolved / deferred, one line>
Evidence: <link to the review run or transcript>
```

- **What counts:** only records whose `Reviewed-SHA` is the head, `Phase` is `output` and `Outcome` is
  `approved` or `approved-with-deferrals`.
- **`approved-with-deferrals`** means the reviewer found no unresolved material blocker; only
  non-blocking findings are deferred. A record can't prove that, so the command takes it as the
  reviewer's attestation, as the independent-review skill already defines it.
- **Newest wins:** for that SHA, the newest record decides, so a later `changes-requested` supersedes
  an earlier approval.
- **Other records are reported, not counted:** a record for another SHA is reported as stale, and a
  plan-phase record as not applicable.
- **Missing fields:** a record missing any field is reported as malformed and doesn't count.
- **What the result cites:** the record's URL and its reviewer.

### Skipping review

`--skip-review "<reason>"` posts `<!-- context-kit:review-skipped --> Review skipped for <sha>: <reason>`
before merging. The result carries the skip, and the merge report repeats it.

### Order, and the race

1. **Read everything once.** Snapshot the dependent pull requests now, before any merge, because
   repository auto-deletion could retarget them afterwards.
2. **Gates, in order:**
   1. `NOT_OPEN`
   2. `NOT_DEFAULT_BASE`
   3. `MERGE_QUEUE_UNSUPPORTED`: the repository or a ruleset requires a merge queue.
   (`REPO_AMBIGUOUS`, `NO_POLICY` and `INVALID_POLICY` come before all of these.)
   4. `HEAD_MISMATCH`
   5. `CONFLICTING`
   6. `EVIDENCE_INCOMPLETE`
   7. the checks codes
   8. `REVIEW_MISSING`
3. **Refresh immediately before merging:** open state, base, head, and the checks on the head. Movement
   here refuses with no merge call (`HEAD_MOVED`, `BASE_MOVED`, `CHECKS_CHANGED`).
4. **Merge:** `PUT …/merge` with `sha` pinned, and the method allowed by the repository (squash, then
   rebase, then merge, unless `--method` is given). If the head moved after the refresh, GitHub rejects
   with 409, reported as `MERGE_REJECTED`; this attempt is the atomic guarantee. Check and base
   observations keep a small window, documented, that only server-side enforcement could close.
5. **Unknown outcome:** if the merge response is lost (network or 5xx), re-read the pull request. It
   counts as this landing only if it's merged and its head is still the requested SHA; then carry on.
   Otherwise (not merged, or merged at another head) report `MERGE_UNKNOWN` with what was seen, and
   never retry automatically.

### After the merge

- **Confirm:** the default branch contains the merge commit.
- **Delete the head ref only when all of these hold:**
  - it's in this repository, not a fork;
  - it still points at the merged SHA;
  - no other open pull request uses it as its head.

  Otherwise it says why it didn't. An already-deleted ref is noted.
- **Dependents:** re-read the snapshotted dependent pull requests, and report each one's old and new
  base, and that it needs revalidating.
- **Result:** `{ status: merged | merged_cleanup_incomplete, repo, number, sha, merge: { sha, method },
  checks, substantial, review, branch: { deleted | kept: reason }, dependents, warnings }`. Refusals
  use `fail(CODE, message)` and make no merge call. `MERGE_REJECTED` and `MERGE_UNKNOWN` say a merge
  call was made.

### Tripwire

- **The hook:** `bin/merge-guard.mjs` is a Claude Code PreToolUse hook on `Bash`. It denies a command
  that would merge a pull request directly, and says to use `context-kit pr land <n> --sha <tested>`.
  `pr land` calls `gh` itself, not through the Bash tool, so it never needs an exemption, and nothing
  else in a command exempts a raw merge.
- **What it matches (a bounded contract, not a shell):**
  - the command is split into segments at `;`, `&&`, `||`, `|`, `&`, newlines, and inside `$(…)` and
    backticks;
  - each segment is tokenised with single and double quotes and backslash escapes, and leading
    `NAME=value` assignments and the wrappers `env`, `command` and `time` are dropped;
  - a segment is a raw merge when its program is `gh` (or a path ending in `/gh`) and either:
    - its subcommand is `pr merge`, global flags such as `-R owner/name` allowed before it; or
    - its subcommand is `api`, with an endpoint `[/]repos/<o>/<r>/pulls/<n>/merge`, and the method PUT,
      given as `-X PUT`, `-XPUT`, `--method PUT` or `--method=PUT`, in any case and flag order.
  - Out of scope, and named in the docs as residual bypasses: `sh -c` or `eval` strings, aliases,
    scripts, and other clients such as `curl`.
- **Denying:** it prints Claude Code's PreToolUse decision on stdout,
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`,
  and exits 0. Any other command produces no output and exits 0. An unreadable payload fails open
  (exit 0, a note on stderr), in keeping with the trust model.
- **Where it's installed follows the install's scope:** user scope writes Claude Code's user settings
  (`$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`); project scope writes that
  project's `.claude/settings.local.json`, so it never reaches other projects. Codex is reported
  `unsupported`.
- **Lifecycle:**
  - The managed entry is one `hooks.PreToolUse` item, matcher `Bash`, with one command hook:
    `node "<absolute path of this workspace's bin/merge-guard.mjs>"`. A `guard` record in
    `.state/agents.json` stores the agent, scope, settings path, project and that exact entry.
  - **Ownership:** an entry belongs to this workspace when one of its command hooks contains this
    workspace's absolute `merge-guard.mjs` path. That path is the only selector; array position is
    never used. Entries are classified as:
    - `installed`: an entry identical to the recorded one;
    - `edited`: no identical entry, but one or more entries this workspace owns;
    - `missing`: no entry this workspace owns. That includes an edit that removed the path, which can't
      be told apart from a foreign hook, so it is left alone.
  - **Install:** writes are atomic (temporary file, then rename) and keep every other key and hook. An
    identical entry is `unchanged`; a repeated install adds nothing. A missing settings file is
    created. Malformed settings JSON refuses for that runtime and writes nothing
    (`SETTINGS_MALFORMED`).
  - **An edited entry** is left alone and reported `edited`. `--force` replaces exactly the entries this
    workspace owns with the recorded one. Every entry it can't identify, including foreign hooks and
    other workspaces' guards, stays as it is. A `missing` guard is added afresh, with or without
    `--force`.
  - **Several workspaces** each own their own entry, by their own path; one never touches another's.
  - **Status:** `agents status` reports each guard as `installed`, `missing` or `edited`.
  - **Uninstall** removes exactly the recorded entry if it's still as written, keeps an edited one and
    reports it, and leaves the rest of the file as it was.

## Testing

- **`test/e2e/landing.test.mjs`** runs the real CLI (`bin/hub.mjs pr land`) as a subprocess, with
  `PATH` led by a strict fake `gh`.
  - **The fake:** it serves fixtures keyed by method, endpoint and page. A key can hold an ordered
    sequence of responses, so state can change between calls: a head that moves at the refresh, a check
    that goes from pending to success, or a pull request that is open and then merged. A response can
    also be a nonzero exit or a dropped connection (the lost merge response). The fake records every
    call, and fails on any call it doesn't expect, or that runs past the end of a sequence. `GH_TOKEN` and `HOME` are isolated, so it can never fall back to the
    real `gh` or real credentials.
  - **Response shapes:** trimmed from real room and context-kit responses.
  - **Scenarios:**
    - a routine land;
    - each refusal code, and that no merge call was made;
    - expected checks missing, duplicated across workflows, superseded, skipped (listed or not), or
      pending with `--wait` and a timeout;
    - check identity: a same-named check from another workflow, event or app; a check run that can't be
      joined to a workflow run; a workflow path with an `@ref` suffix; a re-run attempt superseding a
      failure; an older run's success on attempt 3 followed by a newer run that failed, and one that's
      pending; a skippable entry that's
      skipped, and a non-skippable one that is;
    - no expected checks, with and without `--no-checks`; `--no-checks` with checks expected;
    - repository and policy: `--repo`, the origin remote, a conflicting `GH_REPO`, running from another
      directory, a policy that differs locally or on the head (the default branch's wins), a missing or
      invalid policy, and `--bootstrap-policy`;
    - the substantial boundaries: source-only changes (also with a `routine` label), docs-only changes,
      a MODIFIED delta, `.github/` and `.context-kit/` files, renamed or deleted files, and the
      `substantial` label;
    - review records: current, stale, plan-phase, changes-requested superseding an approval, and
      malformed;
    - `--skip-review` posting before the merge call;
    - evidence pagination and a truncated file list;
    - a head move before the refresh (no merge call), and after it (409, `MERGE_REJECTED`);
    - a base move;
    - a lost merge response: merged at the requested head, not merged, and merged at another head;
    - cleanup: a fork head, a moved ref, a shared ref, an already-deleted ref, and a dependent
      retargeted by GitHub;
    - a required merge queue;
    - the operation absent over MCP, even with writes on.
- **`test/e2e/merge-guard.test.mjs`** runs the hook as a subprocess with real Claude Code PreToolUse
  payloads, and asserts the exact deny JSON and exit code:
  - denied: `gh pr merge` with and without `-R` and flags, each spelling of the PUT method in either
    order, quoted endpoints, `&&`/`;`/`|` chains, `$(…)`, environment prefixes, and a chain that also
    mentions `context-kit pr land`;
  - allowed: `gh pr view`, `gh api …/pulls/1`, a GET of the merge endpoint, the words in an `echo`, and
    an unreadable payload (fails open).
- **The guard's install lifecycle,** through the real `agents install`, `status` and `uninstall` with
  an isolated `HOME`/`CLAUDE_CONFIG_DIR`: user and project scope writing the right file, foreign keys
  and hooks preserved, repeated installs unchanged, malformed settings refused untouched, an edited
  entry kept and reported (and with `--force`, an edited command among reordered foreign hooks and a
  second workspace's guard: only this workspace's entry is replaced), two workspaces' entries
  independent, and Codex reported
  unsupported.
