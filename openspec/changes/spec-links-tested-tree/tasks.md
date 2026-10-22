# Tasks

## 1. Name a landing the tree has no record of

- [x] 1.1 `lib/specs/landing.mjs`: `behindSlices` names landed slices whose trailer commits and merged pull requests' merge commits HEAD doesn't reach; `lib/specs/links.mjs` reports a scenario required only by those as having no landing record, still failing; `scripts/spec-links.mjs` marks it
- [x] 1.2 `docs/testing.md` and `docs/delivery.md`: the report, and updating open branches after a slice lands

## 2. Tests

- [x] 2.1 `test/e2e/spec-links.test.mjs`: "Branch behind a landed slice", "Landing rewritten out of a branch" and "Squashed landing without a merge commit" against temporary git repositories, with a fake `gh` for the squash; `npm test` passes
- [x] 2.2 Output review of the implementation before merge (self-review; no independent reviewer was run)
