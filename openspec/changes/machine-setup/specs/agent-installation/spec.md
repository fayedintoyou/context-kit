# Spec Delta

## MODIFIED Requirements

### Requirement: Install into agents
`agents install` SHALL install the enabled addons' skills into each selected agent's skill directory (Claude Code: `.claude/skills`; Codex: `~/.agents/skills` for user scope or `.agents/skills` for project scope) and register an MCP server named after the workspace through that agent's own CLI, with skill prompts turned off because the skills are installed natively, recording every installed item.

#### Scenario: Install for Claude Code and Codex
- **WHEN** a caller installs for both agents at user scope
- **THEN** each agent's skill directory contains the enabled skills, Codex copies omit `disable-model-invocation`, each agent CLI is called to register the workspace's MCP server, and status reports every item as installed

## ADDED Requirements

### Requirement: Shared skills location
At user scope, `agents install` SHALL install skills once into `~/.agents/skills` for every selected harness that reads it, with only Agent Skills standard frontmatter keys, and into Claude Code's skill directory only when Claude Code is selected, using the fewest directories that cover every selected harness.

#### Scenario: Claude Code with harnesses that share
- **WHEN** a caller installs for Claude Code, Codex and Gemini CLI at user scope
- **THEN** the skills are in Claude Code's skill directory and once in `~/.agents/skills`, and nothing is written to `$CODEX_HOME/skills` or `~/.gemini/skills`

#### Scenario: Harnesses that read either
- **WHEN** a caller installs for Cursor alone, and separately for Claude Code and Cursor
- **THEN** the first installs into `~/.agents/skills` only, and the second into Claude Code's skill directory only

### Requirement: Codex skills move to the shared location
Reinstalling for Codex at user scope SHALL remove the unchanged skills it recorded under `$CODEX_HOME/skills`, keep and report any edited since install, and install the skills into `~/.agents/skills`.

#### Scenario: Upgrade an existing Codex install
- **WHEN** a workspace's records hold Codex skills under `$CODEX_HOME/skills`, one of them edited, and a caller installs for Codex again
- **THEN** the unchanged copies are removed from `$CODEX_HOME/skills`, the edited one is kept and reported, and every skill is installed in `~/.agents/skills`

### Requirement: Supported harnesses
`--agent` SHALL accept `claude`, `codex`, `gemini` (Gemini CLI), `copilot` (GitHub Copilot CLI), `cursor`, `opencode` and `all`, defaulting to `claude,codex`, and SHALL fail naming the supported harnesses for any other name. `agents status` and `agents uninstall` SHALL cover every harness.

#### Scenario: Unknown harness
- **WHEN** a caller installs with `--agent claude,windsurf`
- **THEN** the command fails with `INVALID_INPUT` naming every supported harness, and nothing is written

#### Scenario: Every harness
- **WHEN** a caller installs with `--agent all` on a machine with fake harness CLIs and then uninstalls
- **THEN** status reports skills and an MCP registration for each harness, and uninstall removes them all

### Requirement: Gemini CLI registration
For Gemini CLI, `agents install` SHALL register the workspace's MCP server with `gemini mcp add` at user scope and remove it with `gemini mcp remove` at user scope, treating a missing CLI as for other agents.

#### Scenario: Register with Gemini CLI
- **WHEN** a caller installs and then uninstalls for Gemini CLI with a fake `gemini` CLI on the path
- **THEN** the CLI was called to add the server at user scope with the workspace's MCP command, status reports it installed, and uninstall called it to remove the server at user scope

### Requirement: Registration through config files
For Copilot CLI (`mcp-config.json` in `$COPILOT_HOME`, default `~/.copilot`), Cursor (`~/.cursor/mcp.json`) and OpenCode (`~/.config/opencode/opencode.json`), `agents install` SHALL add one server entry and keep every other key, refuse a file that is not plain JSON without writing, keep an entry edited since install unless forced, and uninstall SHALL remove only its own entry.

#### Scenario: Other servers are kept
- **WHEN** each config file already lists another MCP server and a caller installs for Copilot CLI, Cursor and OpenCode, then uninstalls
- **THEN** each file gains the workspace's server in that harness's shape after install, and after uninstall holds exactly what it held before

#### Scenario: Unreadable config
- **WHEN** OpenCode's config contains comments, or Cursor's is not valid JSON, and a caller installs for both
- **THEN** both registrations are reported refused with the file's path, both files are unchanged, and the skills are still installed

#### Scenario: Edited entry
- **WHEN** the workspace's entry in Cursor's config was edited after install, and a caller installs again, then uninstalls
- **THEN** install and uninstall keep the edited entry and report it `edited`

### Requirement: Project scope for more harnesses
At project scope, Gemini CLI, Copilot CLI, Cursor and OpenCode SHALL get skills under the project's `.agents/skills`, and their MCP registration SHALL be reported skipped with the reason.

#### Scenario: Project install for Cursor
- **WHEN** a caller installs for Cursor at project scope
- **THEN** the skills are under the project's `.agents/skills`, `~/.cursor/mcp.json` is unchanged, and the registration is reported skipped

### Requirement: Launcher
`agents install` SHALL write a managed `context-kit` launcher into `$XDG_BIN_HOME`, or `~/.local/bin` without it, that runs this workspace's pinned core against its root from any directory. It SHALL not overwrite a file it did not write unless forced, SHALL report whether that directory is on `PATH`, and uninstall SHALL remove it when unchanged.

#### Scenario: Run from anywhere
- **WHEN** agents are installed and a caller runs the launcher with `repos` from an unrelated directory
- **THEN** it lists the workspace's repositories, and status reports the launcher installed and whether its directory is on `PATH`

#### Scenario: Foreign launcher
- **WHEN** a `context-kit` file that Context Kit did not write is already in that directory
- **THEN** install leaves it unchanged and reports a conflict naming it and how to force, and uninstall leaves it

### Requirement: Moved workspace
After a workspace directory moves, `agents status` from its new location SHALL report each MCP registration, launcher and generated skill that names the old location as `moved`; the old launcher SHALL fail with a coded error naming the missing workspace; and `agents install` SHALL repair them.

#### Scenario: Move and repair
- **WHEN** a workspace is installed, renamed to another directory, and a caller runs `agents status` there, then the launcher, then `agents install`, then the launcher again
- **THEN** status reports the MCP registrations, launcher and routing skill `moved`, the first launcher run fails naming the old path, and after the install the launcher lists repositories and status reports every item installed

### Requirement: Optional global rule
With `--global-rule`, `agents install` SHALL write a Context Kit-owned rule file into Claude Code's user rules directory saying the user's repositories resolve from any directory and how, without listing them. Later installs SHALL keep it until `--no-global-rule` or uninstall; an edited one is kept unless forced. Harnesses without a rules directory SHALL report it unsupported.

#### Scenario: Opt in
- **WHEN** a caller installs for Claude Code and Codex with `--global-rule`
- **THEN** Claude Code's user rules directory holds the rule file, which names the resolve operation and no repository title, and Codex reports the rule unsupported

#### Scenario: Off unless asked
- **WHEN** a caller installs without `--global-rule`, then with it, then again without it, then with `--no-global-rule`
- **THEN** no rule file exists after the first install, it exists after the second and third, and it is removed after the last

#### Scenario: Edited rule
- **WHEN** the installed rule file was edited and a caller installs with `--no-global-rule`, then uninstalls
- **THEN** the edited file is kept and reported `edited` both times
