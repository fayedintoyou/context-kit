# Tasks

## 1. Addons

- [x] 1.1 Define kit addons (core, specs, reflect, review), workspace skill-only addons and `context-kit.json`, with CLI `addons`, and verify with e2e tests linked to "List addons" and "Invalid configuration"
- [x] 1.2 Gate operations by enabled addons in CLI and MCP, and verify with the e2e test linked to "Core only"
- [x] 1.3 Check bundled skill frontmatter, gate skill listings and prompts by addon, point skills at MCP tools, and verify with tests linked to "Bundled skills conform"

## 2. Installer

- [x] 2.1 Implement `agents install|status|uninstall` as a reconciling sync with copy and link modes, scopes, records and conflict handling, and verify with e2e tests linked to "Linked skills", "Foreign and edited skills are preserved", "Disable an addon and reinstall", "Project scope" and "Agent CLI missing"
- [x] 2.2 Register MCP through the Claude Code and Codex CLIs, and verify with the real-CLI e2e test linked to "Install for Claude Code and Codex"
- [x] 2.3 Add `setup`, the `agents` script and `context-kit.json` to `init`, and README/docs, and verify with the e2e test linked to "Set up a workspace"

## 3. Integration

- [x] 3.1 Run `npm test`, spec links and `openspec validate addons-installer --strict`, then install into the user's workspace and agents
