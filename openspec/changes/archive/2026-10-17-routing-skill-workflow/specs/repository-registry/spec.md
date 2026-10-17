## ADDED Requirements

### Requirement: Read a repository's instructions before changing it
The routing skill's body SHALL tell agents, before changing a repository, to read that checkout's `AGENTS.md` or `CLAUDE.md` and the repository's concept, and to follow the workflow they describe, because a session started outside the checkout does not load them. It SHALL give the exact concept read command for each repository.

#### Scenario: Workflow guidance before changes
- **WHEN** the skill is rendered for two registered repositories
- **THEN** its body tells agents to read the checkout's `AGENTS.md` or `CLAUDE.md` before changing it and gives the exact concept read command for each repository
