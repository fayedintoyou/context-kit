# Tasks

## 1. Landing

- [x] 1.1 `lib/landing.mjs`: one repository identity, the policy from the default branch (and `--bootstrap-policy`), evidence collected completely through `gh` (fail closed), expected checks matched by producer, workflow and event, substantial by default (paths only), review records, gates in order, refresh, pinned merge and outcomes, safe cleanup and dependents
- [x] 1.2 `land_pull_request` (CLI-only, write), `context-kit pr land` usage, value flags in `lib/arguments.mjs`, help
- [x] 1.3 The tripwire: `bin/merge-guard.mjs` (the bounded matching contract and Claude Code's deny output), and the `guard` record in `agents install` / `status` / `uninstall`, following the install's scope (Claude Code; Codex reported unsupported)
- [x] 1.4 The independent-review skill describes posting a review record; the commands reference and `docs/delivery.md` describe `pr land`, its policy file and the trust model

## 2. Tests and review

- [x] 2.1 E2E tests with a strict fake `gh`, and the guard's tests, for every scenario in design.md; `npm test` passes
- [ ] 2.2 Independent output review of the implementation before merge
