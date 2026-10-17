# skill-library Specification

## Purpose
Ship reusable methods as skills that people and agents can list, read in full and invoke directly, so the toolkit's own methods, such as reflection on finished work, travel with it.

## Requirements

### Requirement: Bundled reflect skill
The toolkit SHALL bundle a `reflect` skill whose instructions and every prompt reference they name are readable through Context Kit.

#### Scenario: Read reflect and its references
- **WHEN** a hub declares `kit:reflect` and a caller reads the skill and each reference file it names
- **THEN** every read succeeds and returns the file's content

### Requirement: Read skill files
Reading a declared skill SHALL return its `SKILL.md` by default, or a named Markdown file inside the skill's directory. Files outside the directory, dot or traversal segments, and non-Markdown files SHALL be rejected.

#### Scenario: Confined skill files
- **WHEN** a caller reads a skill file by a traversal path, a dot segment, a non-Markdown file or a missing file
- **THEN** the request fails with `INVALID_PATH`, `INVALID_PATH`, `INVALID_PATH` or `NOT_FOUND` and returns no content

### Requirement: List skills
The system SHALL list the skills declared by a workspace's hubs once each, with reference, name, description and the hubs declaring them, through both CLI and MCP.

#### Scenario: Shared skill listed once
- **WHEN** two hubs declare the same skill and one declares another
- **THEN** the listing has two skills, the shared one naming both hubs

### Requirement: Skills as MCP prompts
The MCP server SHALL offer each listed skill as a prompt named after the skill, whose content is the skill's `SKILL.md` followed by how to read its other files through Context Kit.

#### Scenario: Invoke a skill as a prompt
- **WHEN** an MCP client lists prompts and gets the `reflect` prompt
- **THEN** the prompt list includes `reflect` with its description, and the prompt content is the skill text with instructions for reading its references
