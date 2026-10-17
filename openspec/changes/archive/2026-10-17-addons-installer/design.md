# Design

## Context

Research on Claude Code 2.1 and Codex 0.163 (2026-10-17): both register stdio MCP servers non-interactively (`claude mcp add -s <scope>`, `codex mcp add`) and honor isolated configuration directories (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Claude Code reads skills from `~/.claude/skills` and `.claude/skills`; Codex from `$CODEX_HOME/skills` and `.agents/skills`, and its skill validator accepts only `name`, `description`, `license`, `allowed-tools` and `metadata`. Both have plugin marketplaces, and Codex also reads Claude-format marketplaces, but installed plugins must be self-contained, which would force bundling the shared core into every plugin.

## Decisions

- **An npx installer over native plugins, for now.** The core installs once into the workspace instance, which already pins it; every addon runs on that one copy, and the installer wires skills and one MCP server into each agent. Native marketplaces remain an option for distributing to others.
- **Addons are declared, not discovered by convention.** Kit addons live in `addons/<name>/addon.json` and name kit skills and an internal operation group. Workspace addons may only carry skills: executing workspace code would contradict the boundary set in the MVP.
- **Gating at the operation layer.** `operations()` filters by enabled addons, so CLI and MCP agree. With no `context-kit.json`, all kit addons are enabled, which keeps existing workspaces and the toolkit checkout working.
- **Agent CLIs do the config writing.** Registering MCP through `claude mcp` and `codex mcp` avoids editing their files and follows their own scoping. The MCP command uses the absolute Node path and the core's absolute `bin/mcp.mjs`, because MCP clients started outside a shell may not see nvm's PATH.
- **Install records live in the workspace** at `.state/agents.json` (ignored by git), with a content hash per copied skill. Install never overwrites, and uninstall never removes, a directory that is unrecorded or changed, unless `--force`.
- **Scopes.** User scope writes to the home locations. Project scope writes skills under a project directory (default: the current directory) and registers Claude Code's server at `local` scope, which is private to that project, because `project` scope writes a shared `.mcp.json` with this machine's absolute paths. Codex has no project-scoped MCP, so registration needs `--global-mcp`.
- **Skills call tools, not paths.** Installed copies cannot resolve the core's location, so bundled skills reach Context Kit through its MCP tools, with the instance's `npm run hub --` as the CLI fallback.
- **No duplicate surfaces.** The installer registers the MCP server with `--no-skill-prompts`, since the skills are installed natively. Skill listings and prompts include bundled skills only from enabled addons.
- **Per-agent frontmatter.** Sources keep `disable-model-invocation` for Claude Code. Codex copies strip keys outside its allowed set; linking a skill that needs stripping into Codex is refused in favor of copying.
- **Install is a sync.** Records hold each copy's source and installed hashes (links hold their target). Re-running install adds, updates unchanged stale copies, removes unchanged copies of disabled addons and re-registers owned servers; `status` reports installed, changed, stale or missing. Copies are written to a temporary directory and renamed into place. The server is named after the workspace directory.
- **Bootstrap.** `setup` resolves a commit for the core (the checkout's HEAD, `git ls-remote` for a remote, or `--kit`), runs `init`, `npm install` and `agents install`. No separate shell installer.
- **Testing.** Fake `claude` and `codex` executables on PATH record their arguments, so every scenario asserts exact agent calls in CI; a real-CLI test against temporary configuration directories also runs where the CLIs are installed. The MCP server reads enabled addons at startup, so agents must restart it after a configuration change.

## Risks / Trade-offs

- [Agent CLIs change flags] → Calls are isolated in one module and covered by the real-CLI tests; failures are reported per agent.
- [Symlinked skills may not be followed by every agent] → Linking is opt-in; copying is the default.
