# change-archival Specification

## Purpose
Archive a change as soon as all of its work has merged, from deterministic readiness rather than memory, and keep canonical specs changing only through archived changes.

## Requirements

### Requirement: Archive readiness
The `specs` addon SHALL provide a read-only `specs archivable` operation, `archivable_changes` over MCP, that reports each active change of the workspace repository as ready to archive or lists its blockers: `no_tasks` when it has no tasks, `tasks_incomplete` when any task is unticked, and `slices_unlanded` when its slice plan has slices that have not landed on the base branch.

#### Scenario: Finished change
- **WHEN** a change has every task ticked and no slice plan
- **THEN** it is reported ready with its task counts

#### Scenario: Held open
- **WHEN** one change has an unticked task and another has no tasks
- **THEN** neither is ready, and their blockers are `tasks_incomplete` and `no_tasks`

#### Scenario: Slices not landed
- **WHEN** a change has every task ticked but a slice in its plan has not landed
- **THEN** it is not ready and its blocker is `slices_unlanded`, naming the slice

#### Scenario: Readiness over MCP
- **WHEN** an MCP client calls `archivable_changes` in a workspace with the `specs` addon enabled
- **THEN** it returns the same result as the CLI, and the tool is absent when the addon is disabled

### Requirement: Archive ready changes
The CLI SHALL provide `specs archive --ready`, never offered over MCP, that archives exactly the ready changes through the pinned OpenSpec CLI, then validates the canonical specs strictly. It SHALL report the changes archived and those skipped with their blockers, and SHALL NOT commit. Without `--ready` it SHALL refuse.

#### Scenario: Archive what is finished
- **WHEN** one change is ready and another has an unticked task
- **THEN** the ready change moves to the archive with its deltas merged into canonical specs, the other stays active, and the result names both

#### Scenario: Archive a change without spec deltas
- **WHEN** a ready change declares `skip_specs: true` and has no deltas
- **THEN** it moves to the archive, the canonical specs are unchanged, and the result reports it with `specsUpdated` false and empty totals

#### Scenario: Nothing ready
- **WHEN** no change is ready
- **THEN** no file changes and the result has no archived changes

#### Scenario: Archive refused without the flag
- **WHEN** a caller runs `specs archive` without `--ready`
- **THEN** it fails with `INVALID_INPUT` and archives nothing

### Requirement: Archive after merge
The toolkit SHALL ship a reusable GitHub workflow that, on a push to the default branch, runs `specs archive --ready`, runs the repository's test command, and commits and pushes the archive only when something was archived and the tests pass. On pull requests, it SHALL fail a check that edits `openspec/specs/` directly unless the pull request carries the `canonical-edit` label.

#### Scenario: Archived on merge
- **WHEN** the last piece of a change with every task ticked reaches the default branch of a repository that calls the workflow
- **THEN** a tested commit archiving the change is pushed, and a failing test leaves the branch unchanged

#### Scenario: Canonical edit in a pull request
- **WHEN** a pull request edits a file under `openspec/specs/` without the `canonical-edit` label
- **THEN** the guard check fails and names the file
