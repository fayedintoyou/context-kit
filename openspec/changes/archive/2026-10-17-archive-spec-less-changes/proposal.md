# Proposal

## Why

A change that declares `skip_specs: true` (deployment, tooling, docs) has no deltas.
OpenSpec archives it, but leaves `totals` out of its JSON reply, and the adapter
rejects that reply as `ADAPTER_FORMAT`. `specs archive --ready` then fails after the
change has already moved, so the archive-after-merge workflow fails on every push of
any repository that finishes such a change. Found in lineage, whose `publish-the-game`
change is spec-less.

## What Changes

- The adapter accepts an archive reply without `totals` and reports empty totals.
- `specs archive --ready` archives a ready spec-less change like any other, reporting
  `specsUpdated: false` and leaving the canonical specs unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-archival`: "Archive ready changes" gains a scenario for a change without spec
  deltas.

## Impact

- `lib/specs/openspec.mjs` (archive reply schema), `test/e2e/archival.test.mjs`.
- Repositories pinning an earlier commit keep failing on spec-less changes until they
  move their pin.
