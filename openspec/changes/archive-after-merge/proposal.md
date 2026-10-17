# Proposal

## Why

Archiving is the step that turns a finished change into canonical truth, and in
practice it gets forgotten. `repo-registry` and `spec-garden` merged into
Context Kit with every task ticked and were never archived. `room`'s
`richer-room-and-phone-view` has all 35 tasks done and is still active. Until
archive, the canonical specs describe the system as it was before those
changes, and gardening, auditing and every agent reading the specs see stale
truth.

Archiving inside a PR doesn't fix this. With slices, no single PR knows it's the
last one. Archiving early also writes canonical specs before the code they
describe is on `main`. Archive belongs after merge, as a mechanical step on
`main`: the deltas were already reviewed in their PRs.

The reverse leak exists too. `room` currently has hand edits to
`openspec/specs/site/spec.md`. Canonical specs should change only through
archived changes, otherwise deltas, history and garden signals stop meaning
anything.

## What Changes

- **New read-only `specs archivable`** (MCP `archivable_changes`). Each active
  change gets `ready` or its blockers, from OpenSpec's own task counts and,
  when it has a slice plan, `change-progress` status:
  - `no_tasks`: the change has no tasks.
  - `tasks_incomplete`: some tasks are unticked. Leaving one unticked is also
    how you hold a change open on purpose.
  - `slices_unlanded`: the slice plan has slices that haven't landed.
- **New CLI-only `specs archive --ready`.** It archives exactly the ready
  changes through the pinned OpenSpec CLI, validates the canonical specs
  strictly, and reports what it archived and what it skipped with each blocker.
  It doesn't commit or push.
- **A reusable GitHub workflow** `.github/workflows/openspec.yml`
  (`workflow_call`) with two jobs:
  - `archive`: on a push to the default branch, run `specs archive --ready`,
    run the repository's own test command, and if anything was archived,
    commit `Archive <changes> after merge` as `github-actions[bot]` and push.
    If tests fail, nothing is pushed and the job fails.
  - `canonical-guard`: on pull requests, fail when the PR edits
    `openspec/specs/**`, unless it carries the `canonical-edit` label.

  Context Kit calls it on itself. `room` gets a small caller workflow that pins
  Context Kit by commit.
- **Process, written where agents read it.** Each repository's
  `openspec/config.yaml` context (which OpenSpec injects into every artifact
  and skill) and `docs/delivery.md` say:
  - Tick tasks as you go, and don't archive in PRs.
  - The workflow archives after merge.
  - To hold a change open, leave a task unticked.
  - Never edit `openspec/specs/` directly.

  The `reconcile-change` skill stops suggesting a manual archive where the
  workflow is installed.

## Capabilities

### New Capabilities
- `change-archival`: archive readiness, archiving ready changes, and the
  after-merge workflow and canonical guard.

### Modified Capabilities
- None. `change-progress` is still an active change, so its skill text is
  updated in place.

## Impact

- `lib/specs/openspec.mjs` gains `changes()` (wrapping `openspec list --json`)
  and `archive(name)` (wrapping `openspec archive --yes --json`).
- New `lib/specs/archival.mjs`. `lib/operations.mjs` and `bin/hub.mjs` gain
  `archivable_changes` and the CLI-only `archive_ready`.
- New `.github/workflows/openspec.yml` (reusable) and
  `.github/workflows/archive.yml` (this repository's caller).
- `room`: a caller workflow, an `openspec/config.yaml` context, and an
  `AGENTS.md` line. Its finished change gets archived by the first run.
- No new dependencies. The workflow uses the `gh`-free `git push` with the
  job's `GITHUB_TOKEN` and `contents: write`. A push made with that token does
  not trigger other workflows, so the archive commit cannot loop or redeploy.
