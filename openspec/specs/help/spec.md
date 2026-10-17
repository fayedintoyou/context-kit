# help Specification

## Purpose
Teach people and agents how to use Context Kit from the tool itself, through one set of help topics that stays complete as the tool changes.

## Requirements

### Requirement: Help topics
The system SHALL list help topics with a title and summary, and return one topic's text, through the CLI (`help [topic]`) and the MCP `help` tool with equal results; an unknown topic SHALL fail with `UNKNOWN_TOPIC` naming the available topics. Help SHALL work even when the workspace's addon configuration is invalid.

#### Scenario: Read help
- **WHEN** a caller lists help topics and reads one over the CLI and over MCP, including in a workspace whose `context-kit.json` is invalid
- **THEN** both return the same topics and text, and an unknown topic fails with `UNKNOWN_TOPIC`

### Requirement: Core help skill
The always-on core addon SHALL provide a `context-kit` skill whose help topics are its reference files and whose topic table names exactly those files; new workspaces SHALL declare it and agent installs SHALL include it.

#### Scenario: Help ships with core
- **WHEN** a core-only workspace is created and installed into an agent
- **THEN** its hub declares `kit:context-kit` and the agent's skill directory contains it with its references

### Requirement: Complete help
The help SHALL mention every CLI command, every MCP tool and every error code the system can return.

#### Scenario: Help covers the tool
- **WHEN** the CLI usage, the MCP tool list and the error codes in the source are compared with the help topics
- **THEN** none is missing
