# Tasks

## 0. Landing gate

- [x] 0.1 Before any part of this change (plan or slice) merges to `main`, confirm `remote-mcp-access` is archived (`openspec/specs/remote-access/spec.md` exists on `main`) and `node bin/hub.mjs --root . specs archive --rehearse` reports no issue for `local-only-tools`; until then this change's `remote-access` delta makes the rehearsal fail. Done 2026-10-22: `remote-mcp-access` archived on `main` at b02d3ee (`openspec/specs/remote-access/spec.md` canonical); its ChatGPT and Claude connector checks are recorded on #33 (via #75); the rehearsal reports no issue for `local-only-tools`

## 1. Local-only tools (slice `local-only`, no dependencies)

- [x] 1.1 Add `repos which [<path>]` and stdio `which_repo` (innermost checkout via `git rev-parse --show-toplevel`, main worktree via `git worktree list --porcelain`, realpath-normalized, no fallback to an enclosing checkout, `origin` breaking ties, else `ambiguous`); verify `test/e2e/repos.test.mjs` linked to `repository-registry / Nested subdirectory`, `Linked worktree`, `Unrecorded checkout`, `Innermost checkout decides`, `Several registered remotes`, `Not a repository of the user's` and `Agent asks where it is`
- [x] 1.2 Add the `localOnly` operation flag (set on `which_repo`), pass the transport into the selection, and withhold local-only tools over HTTP, so `repo-context` can flag its tools on top; verify `test/e2e/remote.test.mjs` linked to `remote-access / Same tools over HTTP`, `Local-only tools stay local` and `Every local-only tool is withheld`
- [x] 1.3 Document `which` and the local-only rule in `repositories.md`, `remote.md`, `commands.md` and the `bin/hub.mjs` usage; verify `test/e2e/help.test.mjs` passes

## 2. Serving-machine paths (slice `remote-paths`, after `local-only`)

- [x] 2.1 Over HTTP, return `machine` (`--machine-name`, default the host name) and `servingMachinePath` from `list_repos`, with the HTTP description; verify `test/e2e/remote.test.mjs` linked to `remote-access / Remote client sees whose paths they are` and `test/e2e/repos.test.mjs` linked to `remote-access / Local clients unchanged` and `repository-registry / List over MCP`
- [x] 2.2 Declare every operation's local-path result fields (workspace `root`, checkout paths, file paths) and have the HTTP adapter omit or rename them with the `servingMachine` prefix and add `machine`; verify `test/e2e/remote.test.mjs` linked to `remote-access / Remote client sees no unlabelled paths`, which calls every tool the HTTP server lists and sweeps each result for the fixture's absolute paths, and fails when a new operation leaks one
- [x] 2.3 Document labeled paths in `skills/context-kit/references/remote.md`; verify `node bin/hub.mjs validate`

## 3. Integration

- [ ] 3.1 After the last slice lands, run `npm test`, `node bin/hub.mjs validate`, `npx openspec validate local-only-tools --strict` and `specs archive --rehearse` on `main`

## Workflow follow-up

- Once every slice and task has landed, the openspec workflow archives the change on `main`.
