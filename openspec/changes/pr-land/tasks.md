# Tasks

## 1. Landing

- [ ] 1.1 `lib/landing.mjs`: policy, evidence collected completely through `gh` (fail closed), expected checks, substantial by default, review records, gates in order, refresh, pinned merge and outcomes, safe cleanup and dependents
- [ ] 1.2 `land_pull_request` (CLI-only, write), `context-kit pr land` usage, value flags in `lib/arguments.mjs`, help
- [ ] 1.3 The tripwire: `bin/merge-guard.mjs`, and the `guard` record in `agents install` / `uninstall` (Claude Code; Codex reported unsupported)
- [ ] 1.4 The independent-review skill describes posting a review record; the commands reference and `docs/delivery.md` describe `pr land`, its policy file and the trust model

## 2. Tests and review

- [ ] 2.1 E2E tests with a strict fake `gh`, and the guard's tests, for every scenario in design.md; `npm test` passes
- [ ] 2.2 Independent output review of the implementation before merge
