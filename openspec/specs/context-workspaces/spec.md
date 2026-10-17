# context-workspaces Specification

## Purpose
Let people and agents keep context in an explicit workspace separate from the toolkit, retrieve curated documents and skills within bounds, and capture unreviewed notes safely.

## Requirements

### Requirement: Explicit workspace selection
The system SHALL select a workspace from an explicit root, environment root, or toolkit read-only default and SHALL initialize only a new directory. An initialized workspace SHALL be an instance of the core toolkit: it SHALL pin a core version as a dependency and run the core's CLI and MCP server against itself.

#### Scenario: Create a workspace
- **WHEN** a caller initializes an absent directory
- **THEN** a valid starter hub and portable bundled-skill reference are created without changing an existing directory

#### Scenario: Run the core from an instance
- **WHEN** a caller initializes a workspace pinned to a core source and installs its dependencies
- **THEN** the workspace's own scripts list its hubs with the workspace as root, and serve MCP against it, without a path to a separate checkout

### Requirement: Bounded context retrieval
The system SHALL list hubs, retrieve curated documents and declared skills, and search literal text with bounded output. Captured notes SHALL be separate and opt-in.

#### Scenario: Read curated context
- **WHEN** a caller retrieves context without requesting inbox notes
- **THEN** only curated documents and skill references are returned

### Requirement: Append-only capture
The system SHALL capture nonempty UTF-8 text as a new unreviewed Markdown note in an explicitly selected workspace outside the toolkit checkout, without committing or pushing.

#### Scenario: Capture and find
- **WHEN** a caller captures a note and searches with inbox enabled
- **THEN** the new note is found and existing documents are unchanged

### Requirement: Path confinement
The system SHALL reject references and capture destinations escaping their allowed roots, including existing symlinks.

#### Scenario: Reject escaped inbox
- **WHEN** the inbox directory is a symlink
- **THEN** capture fails before writing any note

#### Scenario: Reject escaped document
- **WHEN** a hub lists a document outside its directory, by traversal or through a symlink
- **THEN** validation and retrieval fail without returning the outside content
