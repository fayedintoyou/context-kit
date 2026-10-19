# Tasks

## 1. Landing

- [ ] 1.1 `lib/landing.mjs`: read the pull request, checks, files, labels and review records through `gh`; gates in order; merge pinned; after-merge confirm, delete and dependents
- [ ] 1.2 `land_pull_request` operation (CLI-only, write) and `context-kit pr land` usage and help
- [ ] 1.3 The independent-review skill says to post `Reviewed-SHA: <sha>` with the outcome; the commands reference lists `pr land`

## 2. Tests and docs

- [ ] 2.1 E2E tests with a fake `gh` on `PATH` for each scenario; `npm test` passes
- [ ] 2.2 Independent output review of the implementation before merge
