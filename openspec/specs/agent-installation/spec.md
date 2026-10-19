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

### Requirement: Generated skills
`agents install` SHALL install the workspace's generated skills (the `my-repos` routing skill) alongside addon skills, always as copies even with `--link`, record them like other skills, and remove an unchanged installed generated skill when the workspace no longer generates it.

#### Scenario: Install the routing skill
- **WHEN** a workspace registers a repository and a caller runs `agents install --link` for both agents
- **THEN** each agent's skill directory has a copied `my-repos` skill, and status reports it installed

#### Scenario: Last repository removed
- **WHEN** the workspace's only Repository concept is deleted and a caller installs again
- **THEN** the installed `my-repos` skill is removed

### Requirement: Regenerate on demand
`repos sync` SHALL rebuild the routing skill from the workspace's Repository concepts (titles, aliases, upstreams) and this machine's checkouts, update every installed unchanged copy without registering MCP servers, report edited copies, and report where the skill is not installed yet.

#### Scenario: Sync after editing repositories
- **WHEN** the routing skill is installed and a caller adds an alias to a Repository concept and runs `repos sync`
- **THEN** the installed skill's description contains the new alias, status reports it installed, and no agent CLI was called

#### Scenario: Sync before any install
- **WHEN** a workspace registers a repository but has never installed agents, and a caller runs `repos sync`
- **THEN** the rendered skill exists in the workspace and the result says to run `agents install`

### Requirement: Sync after pulls
When the workspace is a git checkout, `agents install` SHALL install `post-merge` and `post-rewrite` hooks in that checkout's hooks directory that run `repos sync` and never fail the git command. It SHALL not overwrite a hook it did not install unless forced, `agents status` SHALL report the hooks, and `agents uninstall` SHALL remove them when unchanged.

#### Scenario: A pull rebuilds the skill
- **WHEN** a workspace checkout has the routing skill and sync hooks installed, and a pull brings in a new Repository concept
- **THEN** after the pull the installed skill names the new repository, without running `agents install`

#### Scenario: Existing hooks are kept
- **WHEN** the checkout already has a `post-merge` hook that Context Kit did not install
- **THEN** install leaves it unchanged and reports a conflict naming it, and uninstall removes only the hooks it installed

### Requirement: Generated skills stay current
`agents status` SHALL report an installed generated skill as `stale` when rendering it now would differ from what was installed, such as after hub edits or a pull that change repositories, and `agents install` SHALL update it. `repos locate`, `repos clone` and `repos scan` SHALL update an installed, unchanged routing skill in every place it is installed, and SHALL leave one edited since install alone and say so.

#### Scenario: Pulled hub changes
- **WHEN** the routing skill is installed and a new Repository concept is then added to a hub
- **THEN** status reports the skill stale, and after `agents install` its description names the new repository

#### Scenario: Locating refreshes the skill
- **WHEN** the routing skill is installed and a caller locates a missing repository
- **THEN** the installed skill's metadata gives the new local path without running `agents install`

### Requirement: The merge tripwire
`agents install` SHALL add the merge tripwire to Claude Code in the install's scope: user settings for user scope, the project's `.claude/settings.local.json` for project scope. It SHALL keep other settings and hooks, refuse malformed settings without writing, leave an edited entry unless forced, report it in `agents status`, remove only its own entry on uninstall, and report Codex unsupported.

#### Scenario: Scoped to the project
- **WHEN** agents are installed with `--scope project`
- **THEN** the tripwire is in that project's `.claude/settings.local.json`, and Claude Code's user settings are unchanged

#### Scenario: Other hooks are kept
- **WHEN** the tripwire is installed twice into settings that already hold other keys and hooks, then uninstalled
- **THEN** the second install reports it unchanged, and after uninstall the settings are exactly as before

#### Scenario: Malformed or edited settings
- **WHEN** the settings file isn't valid JSON, or the tripwire entry was edited after install
- **THEN** a malformed file is refused and left untouched, and an edited entry is kept and reported `edited` by install, status and uninstall

#### Scenario: Forcing past an edit
- **WHEN** the tripwire's command was edited, the hooks were reordered, and another workspace's tripwire and a foreign hook are present, and agents are installed with `--force`
- **THEN** only this workspace's entry is replaced, and the other hooks are unchanged

#### Scenario: Codex
- **WHEN** agents are installed for Codex
- **THEN** the tripwire is reported unsupported
