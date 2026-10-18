# Proposal

## Why

The archive after merge validates the merged canonical specs strictly, but nothing
runs that check before merge. `openspec validate --strict` on a change validates its
deltas, not the canonical specs they produce. A requirement that grows past
OpenSpec's 500-character limit, for example, only fails once the change is on the
default branch. Then the archive job fails, and a follow-up pull request has to fix
the active change before it can archive. It has happened three times in two days
(room #11 and #18, Context Kit #34). Each cost a pull request, two CI runs and a
failed job on the default branch.

## What Changes

- New `specs archive --rehearse [--store <id>]`: apply every active change's deltas,
  in the order the archive would, to a scratch copy of the root. Validate the
  resulting canonical specs strictly and report the issues of each change. Readiness
  is ignored, because a rehearsal asks whether the change *will* archive cleanly,
  not whether it is finished. Nothing in the repository changes.
- The reusable `openspec.yml` workflow gains a pull-request job that runs the
  rehearsal and fails when the result would not validate. It names the change and
  the requirement.
- `docs/delivery.md` explains the check and how to fix what it reports.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `change-archival`: archive rehearsal, and the workflow checks it on pull requests.

## Impact

- `lib/specs/archival.mjs`: a rehearsal next to `archiveReady`, sharing its OpenSpec
  calls, with the scratch copy in a temp directory.
- `lib/operations.mjs`: an `archive_rehearse` operation. Like `archive_ready` it is
  CLI-only, but read-only.
- `.github/workflows/openspec.yml`: an `archive-rehearsal` job on pull requests.
- Callers that pin the workflow get the check when they bump the pin.
