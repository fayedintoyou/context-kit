# Spec Delta

## Purpose

Let a workspace choose which Context Kit functionality it uses: an always-on core for OKF knowledge plus optional addons, all running on one shared core.

## ADDED Requirements

### Requirement: Addon catalog
The system SHALL list available addons, the always-on `core`, the kit's addons and any skill-only addons defined in the workspace under `addons/<name>/addon.json`, each with name, description, skills, source and whether it is enabled.

#### Scenario: List addons
- **WHEN** a workspace defines its own skill-only addon and a caller lists addons
- **THEN** the list contains core, the kit addons and the workspace addon with its skills

### Requirement: Enabled addons
A workspace's `context-kit.json` SHALL name its enabled addons, and new workspaces SHALL be created with one; when it is absent (older workspaces), every addon SHALL be enabled. Skill listings and skill prompts SHALL include a bundled skill only when an enabled addon provides it. An unknown addon name, or a workspace addon declaring executable operations, SHALL be a configuration error naming the problem.

#### Scenario: Core only
- **WHEN** a workspace enables no addons
- **THEN** core operations work, spec operations are refused with `ADDON_DISABLED` by the CLI and absent from the MCP tool list, and bundled skills are absent from skill listings and prompts

#### Scenario: Invalid configuration
- **WHEN** `context-kit.json` names an unknown addon
- **THEN** commands fail with `INVALID_CONFIG` naming the addon

### Requirement: Agent-compatible skills
Every bundled skill SHALL have a `name` matching its directory and a `description`, and use only frontmatter keys accepted by Codex (`name`, `description`, `license`, `allowed-tools`, `metadata`) plus `disable-model-invocation`, which Claude Code honors and installs for Codex SHALL strip.

#### Scenario: Bundled skills conform
- **WHEN** the bundled skills are checked
- **THEN** each has a name matching its directory, a description, and no other top-level keys
