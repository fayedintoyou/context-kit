# Proposal

## Why

Some MCP tools answer with this machine's paths. Over HTTP, the client runs
somewhere else, so those paths can send it to a directory that doesn't exist where
it runs. Today `list_repos` over HTTP returns the serving machine's checkout paths
unlabeled. The `repo-context` change will add tools that open a local checkout,
which have the same problem. Separately, agents started outside a checkout have no
way to ask which of the user's repositories a directory belongs to, whether from a
nested subdirectory, a submodule or a linked worktree.

This was split out of `machine-setup`, which the owner accepted on 2026-10-22, so
that change's other slices don't wait on the `remote-access` spec becoming
canonical.

## What Changes

- **Local-only tools.** A tool that resolves a path or checkout on this machine
  declares itself local-only. It is offered over stdio and never over HTTP, where a
  call to it fails as an unknown tool. This amends `remote-access / HTTP transport`
  parity. `which_repo` is the first such tool; `repo-context`'s open tools follow
  the same rule by declaring the flag.
- **Serving-machine paths.** Over HTTP, `list_repos` names the serving machine
  (`--machine-name`, default its host name) and returns `servingMachinePath`
  instead of `path`. Over stdio nothing changes.
- **`repos which [<path>]`** and stdio `which_repo` map a path to the repository its
  innermost git checkout belongs to. Linked worktrees are resolved through `git
  worktree list --porcelain`. The lookup never falls back to an enclosing checkout,
  and among several matching remotes `origin` wins, otherwise the result is
  `ambiguous`.
- **Landing gate.** `remote-access` becomes canonical only when `remote-mcp-access`
  archives (its last task is the owner's live deploy check). Until then this
  change's `remote-access` delta can't archive, so no part of it merges to `main`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-access`: MODIFIES `HTTP transport` (parity except local-only tools and
  labeled paths); ADDs `Local-only tools` and `Serving machine paths`.
- `repository-registry`: ADDs `Which repository is this` and `Which repository
  over MCP`.

## Impact

- `lib/operations.mjs` (`localOnly` flag, `which_repo`, transport-aware
  `list_repos`), `lib/mcp/server.mjs`, `lib/mcp/http.mjs`, `bin/mcp.mjs`
  (`--machine-name`), `lib/repos.mjs` (`whichRepository`), `bin/hub.mjs`
  (`repos which`).
- Docs: `skills/context-kit/references/repositories.md`, `remote.md`,
  `commands.md`.
- Tests: `test/e2e/repos.test.mjs`, `test/e2e/remote.test.mjs`.
- Related: `machine-setup` (routing skill, launcher, setup) doesn't depend on this
  change. `repo-context`'s open slice depends on its `local-only` slice.
