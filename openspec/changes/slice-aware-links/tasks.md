# Tasks

## 1. Slice-aware links

- [x] 1.1 `lib/specs/links.mjs`: for each active change with a slice plan, derive slice states with the progress modules (`loadPlan`, `landing`, `deriveStatus`) and the slices on HEAD (`headSlices`), and list scenarios of unstarted slices as pending; fail closed with a note when progress can't be read
- [x] 1.2 `scripts/spec-links.mjs` takes an optional root and prints pending scenarios and notes; `test/spec-links.test.mjs` shows the notes on failure
- [x] 1.3 `checks` workflow fetches full history; `docs/testing.md` and `docs/delivery.md` describe the rule

## 2. Tests

- [x] 2.1 `test/e2e/spec-links.test.mjs` drives `scripts/spec-links.mjs` against temporary git repositories with trailer commits, linked to every scenario above; `npm test` passes
- [x] 2.2 Independent output review of the implementation before merge
