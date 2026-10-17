## MODIFIED Requirements

### Requirement: Routing skill guidance
The routing skill's body SHALL tell agents to work in a repository's recorded path, not to search the filesystem for it, and to offer `repos clone` or `repos locate` when it is missing. Before an agent changes a repository, the body SHALL tell it to read that checkout's `AGENTS.md` or `CLAUDE.md` and the repository's concept, giving the exact read command for each repository, and to follow the workflow they describe, because a session started outside the checkout does not load them. A workspace with no registered repositories SHALL generate no routing skill.

#### Scenario: Missing checkout guidance
- **WHEN** the skill is rendered for a repository with no recorded path
- **THEN** its body lists that repository as missing with the exact `repos clone` and `repos locate` commands for it

#### Scenario: Workflow guidance before changes
- **WHEN** the skill is rendered for two registered repositories
- **THEN** its body tells agents to read the checkout's `AGENTS.md` or `CLAUDE.md` before changing it and gives the exact concept read command for each repository

#### Scenario: No repositories
- **WHEN** a workspace has no Repository concepts
- **THEN** no routing skill is generated
