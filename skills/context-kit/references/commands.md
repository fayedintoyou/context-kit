# Commands and tools

CLI: `context-kit [--root <dir>] <command>`; inside a workspace, `npm run hub --
<command>` (the workspace is the root). Every result is JSON on stdout; errors are
`{"error": {"code", "message"}}` on stderr with a nonzero exit.

| CLI command | MCP tool | Does |
|---|---|---|
| `help [topic]` | `help` | Lists help topics, or shows one |
| `init <dir>` | | Creates a workspace (`--kit`, `--addons`) |
| `setup <dir>` | | Creates, installs and installs into agents |
| `agents install` / `agents status` / `agents uninstall` | | Manages agent installs |
| `addons` | `list_addons` | Available and enabled addons |
| `list` | `list_hubs` | Hubs |
| `validate` | `validate_hubs` | Checks every hub strictly |
| `context <hub>` | `get_context` | A hub's curated documents (`--inbox`) |
| `browse <hub> [dir]` | `browse_hub` | One directory (`--offset`, `--inbox`) |
| `read <hub> <concept-id>` | `read_concept` | One concept (`--frontmatter`, `--inbox`) |
| `search <text>` | `search_context` | Text across concepts (`--inbox`) |
| `capture <hub> <title>` | `capture_note` | New unreviewed note from stdin (`--by`) |
| `repos add <hub> [<upstream>]` | `add_repo` | Registers a repository in a hub (`--path`, `--alias`, `--title`, `--concept`, `--description`); MCP needs `--allow-write` and takes no path |
| `repos` | `list_repos` | Registered repositories and local checkouts |
| `repos locate <repo> <path>` | | Records an existing checkout (CLI only) |
| `repos clone <repo> [<path>]` | | Clones and records a repository (CLI only) |
| `repos scan <directory>` | | Records matching checkouts down to `--depth` levels (default 1, at most 6; CLI only) |
| `repos setup` | | Sets up a new machine: scans (`--scan`, `--depth`), clones only what `--clone` names or a prompt approves (`--ask`), refreshes the skill (CLI only) |
| `repos sync` | | Rebuilds the `my-repos` skill from Repository concepts (CLI only) |
| `mounts` | `list_mounts` | Mounted hubs from other repositories: pin, status and trust counts (see `mounts`) |
| `mounts add <name> <source>` | | Pins and fetches a hub from another repository (`--ref`, `--path`; CLI only) |
| `mounts fetch [<name>]` | | Fetches mounts at their pinned commits (CLI only) |
| `mounts remove <name>` | | Removes a mount and its fetched content (CLI only) |
| `skills` | `list_skills` | Declared skills |
| `read-skill <hub> <reference>` | `read_skill` | A skill or its files (`--file`) |
| `specs stores` | `list_spec_stores` | Readable shared stores (specs addon) |
| `specs list` | `list_specs` | Canonical specs (`--store`) |
| `specs read <id>` | `read_spec` | One spec (`--store`) |
| `specs audit` | `audit_specs` | Structural audit (`--store`) |
| `specs garden` | `garden_specs` | Spec gardening signals (`--store`) |
| `specs parties --store <id>` | `list_parties` | A store's parties and contracts |
| `specs status <change>` | `change_status` | Derived slice and requirement progress of a change (`--store`) |
| `specs next <change>` | `next_slices` | Work packets for slices ready to start (`--store`) |
| `specs slice <change> <slice>` | `read_slice` | One slice's packet and review inputs (`--store`) |
| `specs reconcile <change>` | `reconcile_change` | Facts for checking a change against what was built (`--store`) |
| `specs archivable` | `archivable_changes` | Which active changes are ready to archive, or their blockers (`--store`) |
| `specs archive --ready` | — | Archive ready changes and validate (CLI only, no commit; `--store`) |
| `specs archive --rehearse` | — | Archive every active change into a scratch copy and report what would fail validation (CLI only, changes nothing, non-zero on an issue; `--store`) |
| `pr land <n> --sha <sha>` | — | Lands a pull request through its gates, merging pinned to the tested SHA (CLI only, never over MCP; `land_pull_request`) |

## Landing a pull request

`context-kit pr land <n> --sha <tested-sha> [--repo owner/name] [--wait] [--timeout <minutes>]
[--method squash|rebase|merge] [--skip-review "<reason>"] [--no-checks "<reason>"] [--bootstrap-policy]`

It runs from anywhere: the repository is `--repo`, or the `origin` remote of the
checkout in the current directory, and every GitHub call goes through `gh api` with
that repository named explicitly. A `GH_REPO` naming another repository refuses
(`REPO_AMBIGUOUS`). The workspace root plays no part.

**The policy** is `.context-kit/landing.json`, read from the default branch's tip
(never the local checkout or the pull request's head, so a pull request can't loosen
its own gate); the result names its branch and SHA. No policy refuses (`NO_POLICY`);
the pull request that adds the first one lands with `--bootstrap-policy`, which uses
the head's policy only while the default branch has none. Unknown keys or bad JSON
refuse (`INVALID_POLICY`).

```json
{
  "expectedChecks": [
    { "name": "test", "app": "github-actions", "workflow": ".github/workflows/checks.yml", "event": "pull_request" },
    { "name": "preview", "app": "github-actions", "workflow": ".github/workflows/deploy.yml", "event": "pull_request",
      "skippable": "previews deploy only when the branch has changes" },
    { "kind": "status", "context": "ci/legacy", "creator": "legacy-bot" }
  ],
  "routine": { "paths": ["docs/**", "README.md"], "excludePaths": ["openspec/**"] }
}
```

- A check run is named by `name` and `app` (the GitHub App's slug), and for
  `github-actions` also `workflow` (the file path) and `event`. A same-named check
  from another workflow, event or app never counts. Among matching runs the newest
  (highest id) decides, so a re-run or newer workflow run supersedes older ones. A
  commit status is named by `context`, optionally `creator`.
- Only success passes; `skipped` or `neutral` passes only for an entry with a
  `skippable` reason. Otherwise `CHECKS_FAILED`, `CHECKS_MISSING` or
  `CHECKS_PENDING`, naming the checks. A matching check run whose workflow run
  GitHub hasn't indexed yet is `CHECKS_UNTRACEABLE`, never a pass. `--wait` polls
  pending and untraceable checks every 20 seconds until `--timeout` (default 30
  minutes).
- `expectedChecks: []` refuses (`CHECKS_NONE_EXPECTED`) unless `--no-checks
  "<alternative validation and link>"`, which is posted on the pull request; with
  checks expected, `--no-checks` is `INVALID_INPUT`.
- Work is **substantial** unless every changed path, old and new, matches
  `routine.paths` and none matches `routine.excludePaths`. Files under `.github/`
  or `.context-kit/`, OpenSpec change deltas and the `substantial` label always
  make it substantial; no label makes it routine. Substantial work needs a review
  record (below) approving the head, or `--skip-review "<reason>"`, posted on the
  pull request before the merge. Otherwise `REVIEW_MISSING`, naming the files.

**Review records** are pull request comments or review bodies holding:

```
<!-- context-kit:review -->
Reviewed-SHA: <40-hex sha>
Phase: output
Reviewer: <model or person, and run id>
Outcome: approved | approved-with-deferrals | changes-requested
Findings: <material found / resolved / deferred, one line>
Evidence: <link to the review run or transcript>
```

Only `output` records for the head count, and the newest decides, so a later
`changes-requested` supersedes an approval. Records for another SHA (stale),
plan-phase records and ones missing a field (malformed) are reported, not counted.

**The gates**, in order: `NOT_OPEN`, `NOT_DEFAULT_BASE`, `MERGE_QUEUE_UNSUPPORTED`
(a ruleset requires a merge queue), `HEAD_MISMATCH`, `CONFLICTING`,
`EVIDENCE_INCOMPLETE` (any read failed, a response didn't match its endpoint's
strict schema or listed the same item twice, a listing came up short of the pull
request's own count or over GitHub's 300-file compare cap (the changed files come from
the compare of the base with the pinned head SHA), or a newer same-named check run
can't be traced to its workflow), the checks, then `REVIEW_MISSING`. A failed post
is `POST_FAILED`. Immediately before merging it runs every gate again on fresh reads
of the pull request, the default branch, the checks and the review records: movement
refuses with `HEAD_MOVED`, `BASE_MOVED` or `CHECKS_CHANGED`, and anything else with its
gate's code. None of these makes a merge call.

It merges with `sha` pinned, using the method given or the first the repository
allows (squash, rebase, merge). GitHub rejecting it, such as a head that moved after
the refresh, is `MERGE_REJECTED`. A lost response is re-read: merged at the
requested head counts; anything else is `MERGE_UNKNOWN`, with what was seen. Both
say a merge call was made, and it is never retried. Afterwards it confirms the
default branch contains the merge, deletes the head branch only when that is
confirmed and the branch is this repository's, unmoved (re-read just before the
delete) and no other open pull request's head, and reports the pull
requests that were based on it with their old and new base, to revalidate. The
status is `merged`, or `merged_cleanup_incomplete` with the reason.

**What it does and doesn't stop.** Agents are assumed to act in good faith and
forget: this makes the gated path the easy one, and `agents install` puts a tripwire
on raw `gh pr merge` and `gh api … /pulls/<n>/merge` in Claude Code. It does not
stop an agent that disables the hook or merges another way (`curl`, a script, `sh
-c`), runtimes without pre-command hooks (Codex), a skip reason the agent writes
itself, or a review record the agent posts itself: comments carry the merging
user's identity, so a record is audit evidence, not proof of independence. Check
and base observations keep a small window before the merge, and the branch delete a
sub-second one after its final re-read, that only server-side enforcement could close.

MCP server (stdio): `context-kit-mcp --root <workspace> [--allow-write] [--no-skill-prompts]`
(`npm run mcp` in a workspace). Its root is fixed at startup; tools cannot change it.

Over HTTP: `CONTEXT_KIT_MCP_TOKEN=<32+ characters> context-kit-mcp --root <workspace>
--http <port> [--host <address>] [--public-host <host>]... [--allow-origin <origin>]...
[--max-sessions <n>] [--session-idle <seconds>]`. It serves `/mcp` with the same tools,
prompts and coded errors, requires `Authorization: Bearer <token>` (the token is only
ever read from the environment) and listens on `127.0.0.1` unless `--host` says
otherwise; `--http 0` picks a free port, reported as one JSON line on stderr. A request
whose `Host` is neither the server's own address nor a `--public-host`, or whose
`Origin` is not an `--allow-origin`, gets 403 before the token is checked. Sessions
(default 16, idle 1800 seconds) keep each client's name for captures; `GET /mcp` is 405.
