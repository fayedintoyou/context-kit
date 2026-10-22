# Spec Delta

## MODIFIED Requirements

### Requirement: Install into agents
`agents install` SHALL install the enabled addons' skills into each selected agent's skill directory (Claude Code: `.claude/skills`; Codex: `~/.agents/skills` for user scope or `.agents/skills` for project scope) and register an MCP server named after the workspace through that agent's own CLI, with skill prompts turned off because the skills are installed natively, recording every installed item.

#### Scenario: Install for Claude Code and Codex
- **WHEN** a caller installs for both agents at user scope
- **THEN** each agent's skill directory contains the enabled skills, Codex copies omit `disable-model-invocation`, each agent CLI is called to register the workspace's MCP server, and status reports every item as installed

## ADDED Requirements

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
`agents install`, `agents uninstall` and `repos sync` SHALL each take an exclusive lock per workspace, taking over the lock of a holder that is no longer running, and SHALL fail with `AGENTS_BUSY`, writing nothing, after waiting for a live holder.

#### Scenario: Concurrent installs take turns
- **WHEN** two installs of one workspace for Cursor run at once
- **THEN** both succeed, one installs the registration and the other finds it unchanged, and exactly one record holds it

#### Scenario: Busy workspace
- **WHEN** a live process holds the workspace's lock and a caller installs with a short wait, then the holder is a process that is gone
- **THEN** the first install fails with `AGENTS_BUSY` and writes no records, and the second takes the lock over and succeeds

### Requirement: Checked config edits
A config-file edit SHALL replace the file only while it still holds what the edit was computed from, recomputing from a changed file a bounded number of times. An edit that can't apply cleanly SHALL leave the file as the other writer left it and report `MCP_CONFLICT`. Accepted residual: a harness that replaces the file by its own rename between the last check and Context Kit's rename loses that change.

#### Scenario: Harness writes meanwhile
- **WHEN** a writer changes Cursor's config before an install's edit is captured, and in place during the swap of a later install and an uninstall
- **THEN** the first install applies its entry to the writer's content, and the others leave the file byte-identical to what the writer left and report `MCP_CONFLICT`

#### Scenario: Edit that can't apply
- **WHEN** a writer changes the file before every attempt, or leaves content that is not JSON
- **THEN** install reports `MCP_CONFLICT`, saying nothing was written, and the file holds exactly the writer's bytes

### Requirement: Previous versions of config files
A config file Context Kit replaced or deleted SHALL be kept beside it as a previous version, which a later install or uninstall deletes once it is an hour old and still holds what it held; one that changed SHALL be kept as a displaced copy and reported. Accepted residual: a write landing between that check and the delete is lost.

#### Scenario: Unchanged previous versions swept
- **WHEN** a config file's leftovers include a recent previous version that still holds what it held, and a caller installs now and again an hour later
- **THEN** the first install keeps it and the later one deletes it

#### Scenario: Late write displaced
- **WHEN** a harness writes through an open descriptor to the file an install replaced or an uninstall deleted
- **THEN** that write stays on disk, and the run that cleans it up moves it to a displaced copy and reports it
