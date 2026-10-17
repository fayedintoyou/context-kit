# Proposal

## Why

Context Kit ships everything together, and wiring it into agents is manual (`claude mcp add`, editing Codex config, copying skills). People should be able to take just the core OKF knowledge tooling, add optional functionality such as spec audits or a skill being iterated on, and install the result into Claude Code and Codex with one command, all running on one shared core.

## What Changes

- **Addons.** Functionality is grouped into addons: `core` (always on: hubs, browse, read, search, capture, skills) and kit addons `specs` (OpenSpec operations and the audit skill), `reflect` and `review` (skills). A workspace can define its own skill-only addons under `addons/<name>/`.
- **Enabled addons per workspace.** `context-kit.json` lists the enabled addons; without it, all kit addons are enabled. Operations of disabled addons are absent from MCP and refused by the CLI. `addons` lists available addons and which are enabled.
- **Agent installer.** `agents install` puts the enabled addons' skills into Claude Code and Codex skill directories (user or project scope; copied, or linked for live iteration) and registers one MCP server per agent through each agent's own CLI. It records what it installed so `agents status` and `agents uninstall` are exact and never remove or overwrite files it did not create.
- **npx bootstrap.** `npx github:fayedintoyou/context-kit setup <dir>` creates a pinned instance, installs it and installs it into agents; instances get an `agents` script.
- **Agent-compatible skills.** Bundled skill frontmatter stays within the keys Codex accepts plus Claude Code's `disable-model-invocation`, which Codex installs strip.
- Out of scope: native plugin marketplaces (a later option; Codex also reads Claude-format marketplaces), workspace addons with executable operations, and publishing to npm.

## Capabilities

### New Capabilities
- `addons`: addon definitions, enabling addons per workspace and gating operations.
- `agent-installation`: installing skills and the MCP server into Claude Code and Codex, with status and uninstall.

### Modified Capabilities
None.

## Impact

New `addons/`, `lib/addons.mjs`, `lib/install.mjs`; changes to `lib/operations.mjs`, `bin/hub.mjs`, `bin/mcp.mjs`, `lib/workspace.mjs` (init), `skills/reflect`, README, docs, e2e tests (real `claude` and `codex` CLIs against isolated config directories when available). No new dependencies.
