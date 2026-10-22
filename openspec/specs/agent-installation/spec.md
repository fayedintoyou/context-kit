# agent-installation Specification

## Purpose
Install a workspace's enabled Context Kit skills and MCP server into Claude Code and Codex with one command, and keep those installs inspectable and reversible.

## Requirements

### Requirement: Install into agents
`agents install` SHALL install the enabled addons' skills into each selected harness's skill directory (Claude Code: `.claude/skills`; the others: `~/.agents/skills` at user scope, `.agents/skills` at project scope) and register an MCP server named after the workspace through the harness's CLI (Claude Code, Codex, Gemini CLI) or its config file (Copilot CLI, Cursor), with skill prompts turned off, recording every installed item.

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
When a harness that registers through its CLI (Claude Code, Codex, Gemini CLI) has no CLI on the path, the installer SHALL skip that harness's MCP registration with a clear report and still install its skills. Copilot CLI and Cursor SHALL register through their config files whether or not their executables are installed.

#### Scenario: Agent CLI missing
- **WHEN** a caller installs for an agent whose CLI is not on the path
- **THEN** skills are installed and the result reports the MCP registration as skipped for that agent

#### Scenario: Config-file harnesses need no executable
- **WHEN** a caller installs for Codex, Copilot CLI and Cursor on a machine with none of their executables on the path
- **THEN** Codex's registration is reported skipped, and Copilot CLI's and Cursor's are installed in their config files

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

### Requirement: Shared skills location
At user scope, `agents install` SHALL install skills once into `~/.agents/skills` for every selected harness that reads it, with only Agent Skills standard keys, and into Claude Code's skill directory only when Claude Code is selected, using the fewest directories that cover the selection. A shared copy SHALL be removed only when no harness still installed needs it.

#### Scenario: Claude Code with harnesses that share
- **WHEN** a caller installs for Claude Code, Codex and Gemini CLI at user scope
- **THEN** the skills are in Claude Code's skill directory and once in `~/.agents/skills`, and nothing is written to `$CODEX_HOME/skills` or `~/.gemini/skills`

#### Scenario: Cursor with or without Claude Code
- **WHEN** a caller installs for Cursor alone, and separately for Claude Code and Cursor
- **THEN** the first installs into `~/.agents/skills` only, and the second into Claude Code's skill directory only

#### Scenario: Selective uninstall of shared copies
- **WHEN** a caller installs for Codex and Gemini CLI, uninstalls `--agent codex`, then uninstalls `--agent gemini`
- **THEN** the copies in `~/.agents/skills` remain after the first uninstall and status still reports them for Gemini CLI, and the second uninstall removes them

### Requirement: Copies a harness may see twice
When the selection makes a harness read the same skill from two directories it reads, and its documentation gives no precedence between them, `agents install` SHALL report a warning naming that harness, the skill and both paths. Generated skills SHALL be byte-identical in both directories.

#### Scenario: Cursor sees both directories
- **WHEN** a caller installs for Claude Code, Codex and Cursor
- **THEN** the result warns that Cursor reads `my-repos` from both Claude Code's skill directory and `~/.agents/skills`, and the two `my-repos` copies are identical

### Requirement: Codex skills move to the shared location
Reinstalling for Codex SHALL move each skill recorded in its legacy directory (the recorded `$CODEX_HOME/skills` path) to `~/.agents/skills`, removing a legacy copy only after its replacement is installed and matches its source. A legacy copy that was edited, or whose replacement failed or conflicts, SHALL be kept with its record and reported.

#### Scenario: Upgrade an existing Codex install
- **WHEN** a workspace's records hold Codex skills under `$CODEX_HOME/skills`, one of them edited, and a caller installs for Codex again
- **THEN** the unchanged copies are removed from `$CODEX_HOME/skills` after their replacements are in `~/.agents/skills`, and the edited one is kept and reported

#### Scenario: Destination blocked
- **WHEN** `~/.agents/skills` holds a foreign skill of the same name, a copy edited since install, or is not writable, and a caller installs for Codex again
- **THEN** each affected legacy copy and its record are kept, the result names the conflict or failure, and unaffected skills move

#### Scenario: Codex home changed since install
- **WHEN** Codex skills were installed with `CODEX_HOME` set to one directory and a caller installs again with `CODEX_HOME` unset
- **THEN** the legacy copies are removed from the recorded directory, not from `~/.codex/skills`

### Requirement: Supported harnesses
`--agent` SHALL accept `claude`, `codex`, `gemini` (Gemini CLI), `copilot` (GitHub Copilot CLI), `cursor` and `all`, defaulting to `claude,codex`, and SHALL fail naming the supported harnesses for any other name. `agents status` and `agents uninstall` SHALL cover every harness.

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
For Copilot CLI (`mcp-config.json` in `$COPILOT_HOME`, default `~/.copilot`) and Cursor (`~/.cursor/mcp.json`), `agents install` SHALL add one server entry under `mcpServers` and keep every other key, refuse a file that is not plain JSON without writing, keep an entry edited since install unless forced, and uninstall SHALL remove only its own entry.

#### Scenario: Other servers are kept
- **WHEN** each config file already lists another MCP server and a caller installs for Copilot CLI and Cursor, then uninstalls
- **THEN** each file gains the workspace's server in that harness's shape after install, and after uninstall holds exactly what it held before

#### Scenario: Unreadable config
- **WHEN** Copilot CLI's config contains comments and Cursor's is not valid JSON, and a caller installs for both
- **THEN** both registrations are reported refused with the file's path, both files are unchanged, and the skills are still installed

#### Scenario: Edited entry
- **WHEN** the workspace's entry in Cursor's config was edited after install, and a caller installs again, then uninstalls
- **THEN** install and uninstall keep the edited entry and report it `edited`

### Requirement: Project scope for more harnesses
At project scope, Gemini CLI, Copilot CLI and Cursor SHALL get skills under the project's `.agents/skills`, and their MCP registration SHALL be reported skipped with the reason.

#### Scenario: Project install for Cursor
- **WHEN** a caller installs for Cursor at project scope
- **THEN** the skills are under the project's `.agents/skills`, `~/.cursor/mcp.json` is unchanged, and the registration is reported skipped

### Requirement: Harness discovery checks
Each supported harness SHALL have a discovery check: after `agents install`, a session of that harness started outside every checkout lists the routing skill. The checks for Claude Code and Codex SHALL be end-to-end tests that run when `CONTEXT_KIT_HARNESS_SMOKE=1` and the real CLI is available; the others SHALL be manual checks listed in `test/manual-checks.md`.

#### Scenario: Routing skill is discovered
- **WHEN** a workspace with a registered repository is installed for a harness and a session of that harness is started in a temporary directory outside any checkout
- **THEN** the session's skill listing includes `my-repos` with a description naming the repository

### Requirement: Launcher
`agents install` SHALL write a managed `context-kit` launcher into `$XDG_BIN_HOME`, or `~/.local/bin` without it, that runs this workspace's pinned core against its root from any directory. It SHALL not overwrite a file it did not write unless forced, SHALL report whether that directory is on `PATH`, and uninstall SHALL remove it when unchanged.

#### Scenario: Run from anywhere
- **WHEN** agents are installed and a caller runs the launcher with `repos` from an unrelated directory
- **THEN** it lists the workspace's repositories, and status reports the launcher installed and whether its directory is on `PATH`

#### Scenario: Foreign launcher
- **WHEN** a `context-kit` file that Context Kit did not write is already in that directory
- **THEN** install leaves it unchanged and reports a conflict naming it and how to force, and uninstall leaves it

### Requirement: One workspace per user
When this machine's launcher or user-scope generated skills belong to another workspace, `agents install` SHALL fail with `WORKSPACE_CONFLICT` naming that workspace before writing anything, unless `--force`, which takes over the launcher and generated skills and leaves the other workspace's other items alone.

#### Scenario: Second workspace
- **WHEN** one workspace is installed, then a second workspace with registered repositories runs `agents install`, then `agents install --force`
- **THEN** the first attempt fails with `WORKSPACE_CONFLICT` naming the first workspace and writes nothing, and the forced one leaves the launcher and `my-repos` pointing at the second workspace

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

### Requirement: Replaced skill copies
Each skill record SHALL identify the copy it installed. A recorded path now holding another copy SHALL be reported `replaced`, keep its record, and be left by uninstall and cleanup. One with the installed content SHALL be taken back by the workspace that owns the launcher, or with `--adopt`; other content stays foreign (`SKILL_REPLACED`). A replaced legacy Codex copy SHALL be left in place and its record dropped.

#### Scenario: Restored copies taken back
- **WHEN** Codex skills installed by the workspace that owns the launcher are replaced by copies with the installed content, by a restore or by a dotfile manager's symlinks
- **THEN** status reports them `replaced`, the next install reports them `unchanged` and readopted, and later syncs and uninstall treat them as installed

#### Scenario: Other content stays foreign
- **WHEN** a replaced copy holds other content and a caller installs with and without `--adopt`, then runs `uninstall --force`
- **THEN** each install reports it `SKILL_REPLACED` and keeps its record, and uninstall leaves the copy

#### Scenario: Adopt without the launcher
- **WHEN** the launcher has been replaced by another file and installed skills were restored, one with other content
- **THEN** install reports them `SKILL_REPLACED` naming `--adopt`, and `install --adopt` takes back only the copies with the installed content and leaves the launcher

#### Scenario: Another workspace's identical copies
- **WHEN** a workspace's copies are deleted, a second workspace installs identical ones with `--force`, and the first uninstalls
- **THEN** the first skips them as `SKILL_REPLACED` and the second still reports them installed

#### Scenario: Replaced legacy Codex copy
- **WHEN** a legacy Codex copy was recreated since install and a caller installs for Codex with and without `--force`
- **THEN** the copy stays in place and its record is dropped

### Requirement: One install at a time
`agents install`, `agents uninstall` and `repos sync` SHALL each take an exclusive lock per workspace, taking over the lock of a holder that is no longer running, and SHALL fail with `AGENTS_BUSY`, writing nothing, after waiting for a live holder. The holder SHALL remove `.state` temporaries a killed save left, by exact name, once their process is gone or they are over an hour old. Uninstall SHALL stop with `AGENTS_BUSY` before its next removal once it no longer holds the lock.

#### Scenario: Concurrent installs take turns
- **WHEN** two installs of one workspace for Cursor run at once
- **THEN** both succeed, one installs the registration and the other finds it unchanged, and exactly one record holds it

#### Scenario: Busy workspace
- **WHEN** a live process holds the workspace's lock and a caller installs with a short wait, then the holder is a process that is gone
- **THEN** the first install fails with `AGENTS_BUSY` and writes no records, and the second takes the lock over and succeeds

#### Scenario: Temporaries a killed save left
- **WHEN** `.state` holds record and leftovers temporaries of a dead process and an hour-old one of a live process, plus a live process's recent one and files with similar names, and a caller installs
- **THEN** the dead process's and the hour-old ones are removed and the others are kept

#### Scenario: Uninstall loses the lock
- **WHEN** another command takes the lock over after an uninstall's first removal
- **THEN** that uninstall fails with `AGENTS_BUSY` having removed nothing more, leaves the other holder's lock, and the next uninstall removes the rest

### Requirement: Checked config edits
An edit to Copilot CLI's or Cursor's MCP config file SHALL replace it only while it still holds what the edit was computed from, recomputing from a changed file a bounded number of times. An edit that can't apply cleanly SHALL leave the file as the other writer left it and report `MCP_CONFLICT`. Accepted residual: a harness that replaces the file by its own rename between the last check and Context Kit's rename loses that change.

#### Scenario: Harness writes meanwhile
- **WHEN** a writer changes Cursor's config before an install's edit is captured, and in place during the swap of a later install and an uninstall
- **THEN** the first install applies its entry to the writer's content, and the others leave the file byte-identical to what the writer left and report `MCP_CONFLICT`

#### Scenario: Edit that can't apply
- **WHEN** a writer changes the file before every attempt, or leaves content that is not JSON
- **THEN** install reports `MCP_CONFLICT`, saying nothing was written, and the file holds exactly the writer's bytes

### Requirement: Previous versions of config files
A Copilot CLI or Cursor MCP config file that Context Kit replaced or deleted SHALL be kept beside it as a previous version, which a later install, uninstall or `repos sync` deletes once it is an hour old and still holds what it held; one that changed SHALL be kept as a displaced copy and reported (not from the pull hooks, whose output is discarded). Accepted residual: a write landing between that check and the delete is lost.

#### Scenario: Unchanged previous versions swept
- **WHEN** a config file's leftovers include a recent previous version that still holds what it held, and a caller installs now and again an hour later
- **THEN** the first install keeps it and the later one deletes it

#### Scenario: Late write displaced
- **WHEN** a harness writes through an open descriptor to the file an install replaced or an uninstall deleted
- **THEN** that write stays on disk, and the run that cleans it up moves it to a displaced copy and reports it

#### Scenario: Sync sweeps previous versions
- **WHEN** an install and uninstall for Cursor leave a previous version and a caller runs `repos sync` now and an hour later, then another install and uninstall leave one that is then changed, and a caller syncs an hour later
- **THEN** the first sync keeps it, the second deletes it and the directory the install created, and the last reports the changed one as a displaced `leftover` holding the change
