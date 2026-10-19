# Proposal

## Why

The reusable `openspec` workflow runs each of its jobs on GitHub's `ubuntu-latest`. A private
repository pays for those minutes, and a caller that has moved its own CI onto a self-hosted runner
still has these jobs billed, or not started at all once its included minutes run out. The caller
needs to say where they run.

## What Changes

- The workflow takes a `runs-on` input: one runner label, or a JSON list of labels such as
  `'["self-hosted", "my-mac"]'`. Every job runs there. Without it, jobs run on `ubuntu-latest` as
  before, so existing callers are unaffected.
- `docs/delivery.md` shows the input.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-archival`: a new requirement, "Jobs where the caller runs them".

## Impact

- `.github/workflows/openspec.yml`, `docs/delivery.md`, `test/e2e/archival.test.mjs`
