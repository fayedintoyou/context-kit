# Proposal

## Why

A personal or team workspace is an instance of the Context Kit core, but `init` only writes hubs, so the instance reaches the core through a machine-specific checkout path and has no record of which core version it uses.

## What Changes

- `init` also writes a `package.json` that pins the core toolkit as a dependency and adds scripts that run the core's CLI and MCP server against that workspace.
- The core declares `context-kit` and `context-kit-mcp` executables so an instance can run them from its own dependencies.
- `init --kit <npm-spec>` chooses the core source. By default it uses the core's repository at its current commit.
- `init` does not install anything; it reports the next step.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `context-workspaces`: workspace initialization produces an instance that pins the core toolkit.

## Impact

`lib/workspace.mjs`, `bin/hub.mjs` (`--kit`), `package.json` (`bin`, `repository`), README, e2e tests. No new dependencies. Existing workspaces keep working through `--root`.
