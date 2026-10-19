# Proposal

## Why

Agents merge Faye's pull requests themselves, through `gh api … /pulls/<n>/merge` pinned to a tested
SHA (her working-with-agents preferences). The steps around a merge are written as prose in those
preferences:
- refresh the head and checks;
- for substantial work, require an independent review of the tested head;
- merge only into the default branch;
- afterwards confirm the merge, delete the branch and recheck dependent pull requests.

On 2026-10-19 three substantial pull requests (room #40, context-kit #42, room #50) merged without the
review the prose requires, through 21 hand-written merge calls. A late review then found real bugs in
all three. The rule existed; nothing enforced it. A reflect on that session routed this to a structural
fix: one command that does the steps and refuses when a gate isn't met.

## What Changes

- **A CLI command, `context-kit pr land <n> --sha <tested>`** (`--repo <owner/name>`, defaulting to the
  current checkout's GitHub remote). It:
  - refuses unless the pull request is open, targets the repository's default branch, and its head is
    the given SHA;
  - refuses unless every check on that head has finished and passed. `--wait` waits for pending ones,
    with a timeout;
  - for a substantial pull request, refuses unless a review record for that SHA is on the pull request,
    or `--skip-review "<reason>"` is given. A skip is posted on the pull request and reported, never
    silent. A pull request is substantial when it changes CI, deploy or workflow files, or adds or
    removes requirements in an OpenSpec change, or carries the `substantial` label. A `routine` label
    marks a pull request that only looks substantial;
  - merges with the repository's allowed method, pinned to the SHA;
  - confirms the default branch contains the merge, deletes the head branch when it's in the same
    repository, and lists open pull requests that were based on it.
- **A review record is a pull request comment** with a line `Reviewed-SHA: <sha>`, plus the reviewer
  and the outcome. The independent-review skill says to post one.
- **It's CLI-only and a write,** like `archive_ready`. MCP clients are never offered it.

## Capabilities

### New Capabilities

- `pull-request-landing`: landing a pull request only when its tested head, checks and review gate hold.

### Modified Capabilities

None. The independent-review skill gains one paragraph on posting a review record.

## Impact

- `lib/landing.mjs` (new), `lib/operations.mjs`, `bin/hub.mjs` (CLI usage), `lib/help.mjs`,
  `skills/independent-review/SKILL.md`, `skills/context-kit/references/commands.md`
- `test/e2e/landing.test.mjs` (new): drives the real CLI against a fake `gh` on `PATH` that serves
  recorded pull request, check, comment and file data, and records the calls made
- The workspace's working-with-agents preferences get one line: merge with `context-kit pr land` (a
  workspace edit after this lands)
