# agent-installation Specification

## Purpose
Install a workspace's enabled Context Kit skills and MCP server into Claude Code and Codex with one command, and keep those installs inspectable and reversible.

## Requirements

### Requirement: Install into agents
`agents install` SHALL install the enabled addons' skills into each selected agent's skill directory (Claude Code: `.claude/skills`; Codex: `$CODEX_HOME/skills` for user scope or `.agents/skills` for project scope) and register an MCP server named after the workspace through that agent's own CLI, with skill prompts turned off because the skills are installed natively, recording every installed item.

#### Scenario: Install for Claude Code and Codex
- **WHEN** a caller installs for both agents at user scope
- **THEN** each agent's skill directory contains the enabled skills, Codex copies omit `disable-model-invocation`, each agent CLI is called to register the workspace's MCP server, and status reports every item as installed

### Requirement: Scopes
User scope SHALL register MCP for the user. Project scope SHALL install skills under the project directory, register Claude Code's server at its private local scope rather than a shared project file, and register Codex's server, which has no project scope, only when the caller passes `--global-mcp`.

#### Scenario: Project scope
- **WHEN** a caller installs at project scope without `--global-mcp`
- **THEN** skills land under the project, Claude Code's server is registered at local scope, no project `.mcp.json` is written, and Codex's MCP registration is reported as skipped

### Requirement: Reconciling installs
Running `agents install` again SHALL reconcile: install newly enabled skills, update unchanged installed copies whose source changed, remove unchanged installed skills whose addon was disabled, and re-register servers it registered. `agents status` SHALL report each item as installed, changed, stale (source changed) or missing.

#### Scenario: Disable an addon and reinstall
- **WHEN** a caller installs, disables an addon, edits the source of a copied skill, and installs again
- **THEN** the disabled addon's skills are removed, the edited skill's copy is updated, and status reports the copy stale before the reinstall

### Requirement: Linked skills
With `--link`, installed skills SHALL be symbolic links to their sources, so edits to a skill being iterated on take effect without reinstalling.

#### Scenario: Iterate on a linked skill
- **WHEN** a workspace addon's skill is installed with `--link` and its source is then edited
- **THEN** the installed skill shows the edit

### Requirement: Safe reinstall and uninstall
The installer SHALL NOT overwrite or remove a skill directory it did not install, or one whose contents changed since it installed it, unless forced; `agents uninstall` SHALL remove exactly the recorded items that are unchanged and report the rest.

#### Scenario: Foreign and edited skills are preserved
- **WHEN** a skill directory with the same name already exists that the installer did not create, and an installed skill is edited before uninstall
- **THEN** install skips the existing directory with a conflict naming it and how to force, and uninstall keeps the edited skill and reports it while removing everything else it installed

### Requirement: Missing agents
When a selected agent's CLI is not available, the installer SHALL skip that agent's MCP registration with a clear report and still install its skills.

#### Scenario: Agent CLI missing
- **WHEN** a caller installs for an agent whose CLI is not on the path
- **THEN** skills are installed and the result reports the MCP registration as skipped for that agent

### Requirement: One-command setup
`setup <dir>` SHALL create a workspace instance pinned to a core commit, install its dependencies, and install it into the selected agents.

#### Scenario: Set up a workspace
- **WHEN** a caller runs setup for a new directory with a local core source and selected addons
- **THEN** the instance pins that core, enables those addons, and its agents install has run
