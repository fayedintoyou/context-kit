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

## Landing policy (`.context-kit/landing.json`, in the repository)

```json
{
  "expectedChecks": [
    { "name": "test", "workflow": ".github/workflows/deploy.yml" },
    { "name": "spec-links", "workflow": ".github/workflows/deploy.yml" },
    { "name": "openspec / archive-rehearsal" }
  ],
  "skippable": [{ "name": "preview", "when": "pull_request", "why": "previews deploy on push" }],
  "routine": { "paths": ["docs/**", "README.md", "*.md"], "excludePaths": ["openspec/**"] }
}
```

With no policy file, `pr land` refuses (`NO_POLICY`). It never guesses which checks matter.

## Decisions

### Collecting evidence (fail closed)

- Everything is read with `gh api --paginate`: the pull request, changed files, check runs and commit
  statuses for the head SHA, issue comments, reviews, labels, the repository's default branch and merge
  settings, and open pull requests whose base is the head ref.
- **Completeness:** the changed files must equal the pull request's `changed_files`. Over GitHub's
  3,000-file listing cap, or on any mismatch, read error or malformed response, it refuses
  (`EVIDENCE_INCOMPLETE`). Missing data never means routine or passing.

### Expected checks

- **Every expected check must have run on the head:** each must have a current run for the head SHA,
  identified by name and producing app or workflow path where the policy gives one. Duplicate names
  from other workflows don't count.
- **Current means latest:** the most recent run (or re-run) per identity. A superseded failure doesn't
  block, and a superseded success doesn't pass.
- **Only success passes:** check runs need status `completed` with conclusion `success`, and commit
  statuses need state `success`. `skipped` or `neutral` passes only if the policy lists that check as
  skippable, and its reason appears in the result. `failure`, `cancelled`, `timed_out`,
  `action_required`, `error`, pending or missing all refuse (`CHECKS_FAILED`, `CHECKS_PENDING`,
  `CHECKS_MISSING`).
- **Waiting:** `--wait` polls pending checks every 20 s until `--timeout` (default 30 minutes). A
  timeout refuses (`CHECKS_PENDING`). A self-hosted runner that's asleep stays pending and never passes.
- **`--no-checks "<alternative validation and link>"`** is allowed only when the policy has no expected
  checks for this event. It's posted on the pull request and reported.

### Substantial by default

- **Routine only by exemption:** a pull request is routine only when every changed file (including
  renamed and deleted paths, old and new) matches the policy's routine paths, and none matches its
  excluded paths.
- **Signals that override everything:** any file under `.github/`, any OpenSpec change delta, or the
  `substantial` label makes it substantial, whatever the paths and labels say. A `routine` label is
  honoured only when none of these signals is present, and the result says it was used.
- **The result names its reasons:** which files and signals made it substantial, or which exemption
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
5. **Unknown outcome:** if the merge response is lost (network or 5xx), re-read the pull request. If
   it's merged, carry on; if not, report `MERGE_UNKNOWN` and never retry automatically.

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

- **The hook:** `bin/merge-guard.mjs` is a Claude Code PreToolUse hook on `Bash`. It reads the tool
  input, and denies commands that would merge a pull request without `context-kit pr land`: `gh pr
  merge`, and `gh api` with `/pulls/<n>/merge` and a PUT method in either flag form. The message says
  why, and to use `context-kit pr land <n> --sha <tested>`. Everything else passes untouched. It's
  conservative: it matches the command tokens, and over-blocking is fixable by the user. It doesn't
  pretend to catch every bypass.
- **Installing it:** `agents install` records it as a `guard` record in Claude Code's user settings
  (`hooks.PreToolUse`), so `agents uninstall` removes exactly what it added, and leaves any other user
  hooks alone. It's reported per runtime as `installed`, `unchanged` or `unsupported` (Codex: no
  pre-command hooks).

## Testing

- **`test/e2e/landing.test.mjs`** runs the real CLI (`bin/hub.mjs pr land`) as a subprocess, with
  `PATH` led by a strict fake `gh`.
  - **The fake:** it serves fixture JSON keyed by method, endpoint and page, records every call, and
    fails on anything unexpected. `GH_TOKEN` and `HOME` are isolated, so it can never fall back to the
    real `gh` or real credentials.
  - **Response shapes:** trimmed from real room and context-kit responses.
  - **Scenarios:**
    - a routine land;
    - each refusal code, and that no merge call was made;
    - expected checks missing, duplicated across workflows, superseded, skipped (listed or not), or
      pending with `--wait` and a timeout;
    - the substantial boundaries: source-only changes, a MODIFIED delta, renamed or deleted files, and
      the labels;
    - review records: current, stale, plan-phase, changes-requested superseding an approval, and
      malformed;
    - `--skip-review` posting before the merge call;
    - evidence pagination and a truncated file list;
    - a head move before the refresh (no merge call), and after it (409, `MERGE_REJECTED`);
    - a base move;
    - a lost merge response, in both directions;
    - cleanup: a fork head, a moved ref, a shared ref, an already-deleted ref, and a dependent
      retargeted by GitHub;
    - a required merge queue;
    - the operation absent over MCP, even with writes on.
- **`test/e2e/merge-guard.test.mjs`** feeds the hook real Claude Code PreToolUse payloads: raw merges
  in every form are denied with the message, near-misses (`gh pr view`, `gh api …/pulls/1`) pass, and
  `agents install` and `uninstall` add and remove exactly the guard record.
