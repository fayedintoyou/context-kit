# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit workspace selection
The system SHALL select a workspace from an explicit root, environment root, or toolkit read-only default and SHALL initialize only a new directory. An initialized workspace SHALL be an instance of the core toolkit: it SHALL pin a core version as a dependency and run the core's CLI and MCP server against itself.

#### Scenario: Create a workspace
- **WHEN** a caller initializes an absent directory
- **THEN** a valid starter hub and portable bundled-skill reference are created without changing an existing directory

#### Scenario: Run the core from an instance
- **WHEN** a caller initializes a workspace pinned to a core source and installs its dependencies
- **THEN** the workspace's own scripts list its hubs with the workspace as root, and serve MCP against it, without a path to a separate checkout
