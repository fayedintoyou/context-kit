# Spec Delta

## MODIFIED Requirements

### Requirement: Append-only capture
The system SHALL capture nonempty UTF-8 text as a new unreviewed Markdown note in an explicitly selected workspace outside the toolkit checkout, without committing or pushing. Each note SHALL be an OKF `Note` concept with status draft and no verification, recording the capturing actor and time. MCP captures SHALL name the connected client as `<name>/<version>` and SHALL NOT produce a `human:`, `process:` or `team:` actor; CLI captures SHALL default to the toolkit's own actor and accept a valid `--by` actor.

#### Scenario: Capture and find
- **WHEN** a caller captures a note and searches with inbox enabled
- **THEN** the new note is found and existing documents are unchanged

#### Scenario: Captured note records its author
- **WHEN** an MCP client or a CLI caller with `--by human:<id>` captures a note
- **THEN** the note is a draft `Note` concept, unverified, with `generated.by` naming that client or actor

#### Scenario: Actor cannot be forged
- **WHEN** an MCP client declares a name such as `human:alice`, or a CLI caller passes a malformed `--by`
- **THEN** the MCP note's actor is not a `human:` actor, and the CLI capture fails with a coded error before writing
