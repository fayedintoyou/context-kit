# Tasks

## 1. Cleaner URLs

- [x] 1.1 `cleanUpstream` keeps only a well-known SSH login and keeps scp-like form; `normalizeUpstream` accepts a login-free scp-like `host:path` whose host holds a dot or is `[IPv6]`
- [x] 1.2 `validate` names the clean form of an unclean `resource`

## 2. Tests

- [x] 2.1 `test/e2e/repos.test.mjs` covers each scenario, including a fake `GIT_SSH_COMMAND` that records the path git asks for; `npm test` passes
