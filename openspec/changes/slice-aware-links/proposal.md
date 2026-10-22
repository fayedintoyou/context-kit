# Proposal

## Why

`npm test` fails when any scenario of any active change has no linked test. `docs/delivery.md`
delivers a large change in slices, one pull request per slice, and a change is accepted on the
default branch before its slices are built. From then on every scenario of every slice not yet
built fails the link check, so the first slice can't land green. Three sliced plans
(hub-federation, repo-context, machine-setup) are about to hit this.

## What Changes

- For an active repository change with a `slices.yaml`, the link check requires a scenario's test
  only once a slice implementing its requirement has started: it has landed, by the same git
  evidence `specs status` uses (the `OpenSpec-Change` / `OpenSpec-Slice` trailers, and merged pull
  requests when `gh` is available), or it has a trailer commit on HEAD that is not on the plan's
  base, so the slice's own pull request must link its tests.
- Scenarios of unstarted slices are reported as pending, with their change and slices, in
  `npm run spec-links` output. They don't fail the check.
- Nothing slips through: a requirement no slice names stays required; a scenario that also appears
  in the canonical specs or in another change stays required; when progress can't be read (a
  shallow clone, no git, an invalid plan, a store's change) every scenario of the change stays
  required and the output says why.
- Archive is unchanged and still needs every scenario linked: `specs archivable` needs every slice
  landed, at which point nothing is pending; `specs reconcile` still lists every unlinked scenario;
  and the archive job tests the archived tree, where the scenarios are canonical.
- Changes without `slices.yaml`, and the canonical specs, behave as today.
- The `checks` workflow fetches full history, so the link check can read landing evidence instead
  of falling back to requiring everything in a shallow clone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-progress`: new requirements "Test links wait for a slice" and "Test links fail closed".

## Impact

- `lib/specs/links.mjs`, `lib/specs/landing.mjs` (`headSlices`, `shallow`), `scripts/spec-links.mjs`
  (an optional root, pending output), `test/spec-links.test.mjs`
- `.github/workflows/checks.yml` (`fetch-depth: 0`), `docs/testing.md`, `docs/delivery.md`
- `test/e2e/spec-links.test.mjs` (new)
