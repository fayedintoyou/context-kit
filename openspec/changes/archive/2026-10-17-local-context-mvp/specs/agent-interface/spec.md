# agent-interface

## Purpose
Provide reliable agent interface behavior for people and agents using the Context Kit toolkit.

## ADDED Requirements

### Requirement: Shared operations
CLI and MCP SHALL execute the same validated application operations and return structured results with the resolved root.

#### Scenario: Equivalent context
- **WHEN** CLI and MCP retrieve the same hub in the same workspace
- **THEN** their application results are equivalent

### Requirement: MCP access scope
The MCP server SHALL fix its root at startup and SHALL expose capture only when writes are explicitly enabled.

#### Scenario: Read-only server
- **WHEN** a client lists tools on a default server
- **THEN** capture is absent and tool arguments cannot choose a new root

### Requirement: Actionable failures
The system SHALL report invalid inputs, missing resources and size violations as structured errors without corrupting protocol stdout.

#### Scenario: Invalid CLI request
- **WHEN** an unsupported command is provided
- **THEN** the CLI exits nonzero and writes a coded error to stderr
