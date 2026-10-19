# Design

## Context

- **No GitHub client in the toolkit.** `change_status` already uses `gh` when it's available (pull
  requests for slices). Context Kit doesn't depend on a GitHub client library.
- **Writes are explicit:** `write: true` operations need `--allow-write`, or are CLI-only
  (`archive_ready`, the repository recording commands).
- **The procedure exists only as prose:** pinned SHA, default branch only, checks green on the tested
  head, independent review for substantial work, and confirm, delete and recheck afterwards (the
  workspace's working-with-agents preferences).

## Decisions

- **`gh` as the transport.** Each step is one `gh api` (or `gh pr`) call, so it inherits the user's
  `gh auth`, and it can be tested with a fake `gh` on `PATH`. A missing or unauthenticated `gh` is a
  clear error (`GH_UNAVAILABLE`). Nothing is attempted half-way.
- **Order of checks:** everything that can refuse runs before the merge, in this order:
  1. the pull request is open;
  2. its base is the default branch;
  3. its head equals `--sha`;
  4. its mergeable state isn't conflicting;
  5. its checks are complete and green (with `--wait`, poll every 20 s up to `--timeout`, default 30
     minutes);
  6. the review gate.

  Just before merging, head and checks are refreshed once more. If the head moved, it refuses
  (`HEAD_MOVED`).
- **Checks:** check runs and commit statuses on the head SHA. Every one must have concluded `success`,
  `neutral` or `skipped`. `failure`, `cancelled`, `timed_out` and `action_required` refuse, and so does
  an empty set of checks unless `--no-checks "<reason>"` is given (reported).
- **Substantial, by evidence:** any changed path under `.github/`, `deploy`, or `wrangler` config, or an
  OpenSpec change delta with `## ADDED`, `## REMOVED` or `## RENAMED` requirements, or the
  `substantial` label. A `routine` label overrides the path rule, never the label rule. The result
  names the reasons.
- **Review record:** a pull request comment, or review body, containing `Reviewed-SHA: <40-hex sha>`.
  It counts only when that SHA equals the head. The command reports the record's URL. A record for an
  older SHA is reported as stale, and doesn't count.
- **Skipping:** `--skip-review "<reason>"` (substantial work) posts a comment, `Review skipped for <sha>:
  <reason>`, before merging, and the result carries the skip. There's no silent path.
- **Merge:** the method is the repository's allowed one, preferring squash, then rebase, then merge,
  unless `--method` is given. `PUT …/merge` with `sha` pinned.
- **After the merge:**
  - re-read the default branch;
  - check the merge commit is reachable;
  - delete the head ref if the head repo is this repo;
  - list open pull requests whose base is the deleted branch, so the caller can retarget them.
- **Output:** JSON like every CLI operation:
  `{ repo, number, sha, merged: { sha, method }, checks, substantial: { is, reasons }, review: { record | skipped }, branchDeleted, dependents }`.
  Refusals use `fail(CODE, message)` with codes `NOT_OPEN`, `NOT_DEFAULT_BASE`, `HEAD_MISMATCH`,
  `HEAD_MOVED`, `CONFLICTING`, `CHECKS_PENDING`, `CHECKS_FAILED`, `NO_CHECKS`, `REVIEW_MISSING`,
  `GH_UNAVAILABLE`.
- **CLI only, a write:** `land_pull_request` is `cliOnly: true, write: true`. Like `archive_ready`, it's
  never an MCP tool, because merging publishes.

## Risks

- **GitHub API shapes:** check runs vs statuses, review vs comment bodies, paging. The fake `gh` serves
  the real response shapes, recorded from fayedintoyou/room and context-kit pull requests, trimmed.
- **Agents could still call `gh api … /merge` directly.** A Claude Code PreToolUse hook that blocks raw
  merge calls is a separate backlog item. This command is the path that makes the gate cheap to follow.
- **Detection of "substantial" can be wrong both ways.** Labels are the escape hatch, and the result
  states its reasons, so a reviewer can see why.

## Testing

`test/e2e/landing.test.mjs` runs `bin/hub.mjs pr land` as a subprocess with `PATH` led by a fake `gh`.
The fake serves fixture JSON per scenario and records every call. Assertions:
- each refusal: the code, and that no merge call was made;
- a routine pull request with green checks: merged with the pinned SHA, the branch deleted, dependents
  listed;
- a substantial one without a record: refused;
- with a current record: merged, the record cited;
- with a stale record: refused, the staleness reported;
- with `--skip-review`: a skip comment is posted before the merge call;
- the head moving between the first read and the merge: refused.
