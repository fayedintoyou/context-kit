## ADDED Requirements

### Requirement: Jobs where the caller runs them
The reusable workflow SHALL run every one of its jobs on the runner its caller names, given as one label or as a JSON list of labels, and on GitHub's `ubuntu-latest` when the caller names none.

#### Scenario: A caller's own runner
- **WHEN** a repository calls the workflow naming its self-hosted runner's labels, and another calls it naming none
- **THEN** every job of the first caller's run asks for those labels, and every job of the second's asks for `ubuntu-latest`
