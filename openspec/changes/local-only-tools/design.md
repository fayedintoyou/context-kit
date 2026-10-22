# Design

## Context

`lib/mcp/server.mjs` builds one server for both transports, and `list_repos`
returns `path` the same way on both. Operations already carry `cliOnly` and `write`
flags, which `operations()` uses to decide what a caller is offered. The registry's
`checkout()` accepts any path that is the top of its own checkout,
`remoteKeys()` normalizes remotes as `locate` does, and `mainWorktree()` (added
by `machine-setup`'s `setup-flow`) reads the main worktree from `git worktree
list --porcelain -z` with reasons for bare, deleted and non-checkout mains.
`repos which` reuses `checkout()` and `mainWorktree()` rather than adding a second
worktree reader. A call to an operation a caller isn't offered already fails with
`UNKNOWN_OPERATION` (as `cliOnly` operations do over MCP), so local-only tools use
the same code, as `repo-context` expects. This was planned in
`machine-setup` and split out unchanged (see its design for the routing skill and
launcher).

## Goals / Non-Goals

**Goals:**
- Paths from this machine never reach an HTTP client unlabeled.
- One rule, declared where each tool is defined, that later changes join without
  editing this one.
- A deterministic answer to "which of my repositories is this directory?".

**Non-Goals:**
- What opening a repository returns (`repo-context`).
- Selective exposure of hubs or mounts to some clients.

## Decisions

### `repos which` and `which_repo`

A pure lookup: `realpath` the input, take `git rev-parse --show-toplevel` from it,
which is the innermost checkout (a submodule's own top inside its parent), and
match its remotes, normalized as in `locate`, against the registry. It never
retries from the parent directory: an unrelated repository nested in one of yours
is "not yours", not yours by inheritance. If several remotes match different
registered repositories, `origin` decides. Without an `origin` match, the result
is `ambiguous` with the candidates in id order, and an exit status of 0. Status is
`recorded` (the top equals the recorded path), `worktree` (the main worktree from
`git worktree list --porcelain` is the recorded path), or `unrecorded`. A bare or
missing main gives `worktree` with `main: null` and a reason. A path inside `<workspace>/hubs/<hub>` reports the
hub. Anything else reports `{repository: null}` with exit 0, because "not one of
mine" is an answer, not an error. `which_repo` takes an absolute path and is offered
only over stdio: over HTTP the path would be the client's, which the server can't
see (below).

### Remote path honesty (this change owns the remote policy)

`serverFactory` already knows its transport (`bin/mcp.mjs` picks one). It passes
`transport: 'http'` in the selection, plus `machine` from `--machine-name` or
`os.hostname()`. Operations gain a `localOnly: true` flag beside `cliOnly`, and
`operations()` drops every local-only tool over HTTP, so a call to one is an
unknown tool. This generic foundation (the flag, transport
filtering and `which_repo` as its first user) is the dependency-free `local-only`
slice, so `repo-context`'s open slice can build on it early. `servingMachinePath`
follows in `remote-paths`. The rule is "tools that resolve a path or checkout on this machine
are local-only". `which_repo` is the first. `repo-context`'s `open_repo` and
`context_pack` declare the flag in that change; this one doesn't depend on their
names. `list_repos` over HTTP returns `machine` and `servingMachinePath`, and its
description says so. Renaming the key, rather than adding a label beside `path`,
means a client that reads `path` gets nothing instead of a wrong directory.
Omitting paths was considered, but the owner on another device sometimes wants to
know where a checkout lives on the home machine.

This MODIFIES `remote-access / HTTP transport` and its parity scenario, and ADDs
`Local-only tools` and `Serving machine paths` to `remote-access`. Tying the
behavior to an option (`--machine-name`) would have kept strict parity, but an HTTP
server started without it would silently send unlabeled paths, which is the
failure this fixes. **Ordering:** `remote-access` became canonical when `remote-mcp-access`
archived at b02d3ee, so the gate (task 0.1) is cleared. The canonical
`repository-registry / Read-only repository listing over MCP` requirement also
says `list_repos` returns `repos`' local paths, so it is MODIFIED to point at the
HTTP labeling.


### Delivery

Two slices, merged to `main` one at a time (the gate has cleared):
- `local-only`, with no dependencies: the flag, transport filtering, and `repos
  which`/`which_repo` as its first user. `repo-context`'s open slice builds on it.
- `remote-paths`, after `local-only`: `servingMachinePath` and `--machine-name`.

**Landing order across the sibling plans** (coordinator, 2026-10-22):
1. `machine-setup` (landed and archived) and this change's `local-only` slice;
2. `repo-context`'s open/routing slices;
3. `hub-federation`'s `mounted-repositories`.

### Testing

End to end, as in `machine-setup`. `repos which` uses git fixtures: nested
subdirectories, a registered submodule, an unrelated inner repository, linked
worktrees (including of a bare or deleted main), symlinked paths, and two
registered remotes with and without `origin`. Local-only and labeled paths are
compared between a stdio client and an HTTP client (`test/e2e/remote.test.mjs`
harness) started with the same workspace and options.

## Risks / Trade-offs

- [A future tool returns local paths but forgets the flag] → the scenario "Every
  local-only tool is withheld" compares the HTTP list with every flagged
  operation. Review of new tools checks for the flag.
- [Clients that read `path` over HTTP break] → intended: they get no path instead
  of a wrong one. The description names the replacement key.
- [Other tools also return the serving machine's paths over HTTP] → the #33
  connector check showed ChatGPT the workspace `root`, which several results carry.
  This change labels `list_repos` only. Whether other results' `root` fields should
  be labeled or withheld over HTTP is an open question for a follow-up.

## Migration Plan

Additive for stdio clients. HTTP clients of `list_repos` read `servingMachinePath`
and `machine`.
