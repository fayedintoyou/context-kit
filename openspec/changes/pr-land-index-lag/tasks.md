# Tasks

## 1. Untraced checks

- [x] 1.1 `lib/landing.mjs`: classify a named, untraceable check run with no traced match as `untraced`; refuse `CHECKS_UNTRACEABLE`; poll it under `--wait` like a pending check
- [x] 1.2 `skills/context-kit/references/commands.md` names the refusal code

## 2. Tests

- [x] 2.1 `test/e2e/landing.test.mjs`: "A workflow run indexed late" and "An untraced check without waiting", driven through the fake `gh`; "A check that never ran" still refuses `CHECKS_MISSING`; `npm test` passes
- [x] 2.2 Independent output review of the implementation before merge (self-review; no independent reviewer was run)
