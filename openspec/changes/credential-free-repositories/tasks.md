# Tasks

## 1. Clean resources

- [x] 1.1 `lib/repos.mjs`: `cleanUpstream` derives the clean form with the same identity; `registry` lists it as `upstream` and reports an unclean `resource`
- [x] 1.2 `addRepository` stores, indexes and returns only the clean form, reports `removed`, and never echoes the input in an error
- [x] 1.3 `redact()` scans userinfo in linear time with the same results

## 2. Tests

- [x] 2.1 `test/e2e/repos.test.mjs` drives the CLI and MCP with fake secrets against temporary workspaces and real git, linked to every scenario above; `npm test` passes
- [x] 2.2 Independent output review of the implementation before merge
