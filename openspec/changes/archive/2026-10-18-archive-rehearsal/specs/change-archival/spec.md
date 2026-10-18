# Spec Delta

## ADDED Requirements

### Requirement: Archive rehearsal
The CLI SHALL provide `specs archive --rehearse [--store <id>]` that applies every active change of the workspace repository or the selected store, in archive order and regardless of readiness, to a scratch copy, validates the resulting canonical specs strictly, and reports each change with the issues it introduces and any issues already present as `baseline`. It SHALL change nothing in the repository, and SHALL exit non-zero when a change introduces an issue.

#### Scenario: A change that would not archive cleanly
- **WHEN** an active change, with unticked tasks, would leave a canonical requirement over OpenSpec's length limit, and a caller runs `specs archive --rehearse`
- **THEN** the result names that change, the spec and the requirement with the issue, the command exits non-zero, and no file in the repository changes

#### Scenario: A clean rehearsal
- **WHEN** every active change would archive into canonical specs that validate strictly
- **THEN** the result lists each change with no issues, the command exits zero, and no file changes

#### Scenario: Issues already in the canonical specs
- **WHEN** a canonical spec already has a strict validation issue and no active change adds one
- **THEN** the issue is reported under `baseline` and the command exits zero

## MODIFIED Requirements

### Requirement: Archive after merge
The toolkit SHALL ship a reusable GitHub workflow that, on a push to the default branch, runs `specs archive --ready`, runs the repository's test command, and commits and pushes the archive only when something was archived and the tests pass. On pull requests, it SHALL fail a check that edits `openspec/specs/` directly unless the pull request carries the `canonical-edit` label, and SHALL fail a check when `specs archive --rehearse` reports an issue a change introduces.

#### Scenario: Archived on merge
- **WHEN** the last piece of a change with every task ticked reaches the default branch of a repository that calls the workflow
- **THEN** a tested commit archiving the change is pushed, and a failing test leaves the branch unchanged

#### Scenario: Canonical edit in a pull request
- **WHEN** a pull request edits a file under `openspec/specs/` without the `canonical-edit` label
- **THEN** the guard check fails and names the file

#### Scenario: Rehearsal in a pull request
- **WHEN** a pull request adds or edits an active change that would not archive into strictly valid canonical specs
- **THEN** the rehearsal check fails and names the change and the requirement, before anything merges
