## ADDED Requirements

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

#### Scenario: Codex
- **WHEN** agents are installed for Codex
- **THEN** the tripwire is reported unsupported
