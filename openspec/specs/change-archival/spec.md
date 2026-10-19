# change-archival Specification

## Purpose
Archive a change as soon as all of its work has merged, from deterministic readiness rather than memory, and keep canonical specs changing only through archived changes.

## Requirements

### Requirement: Archive readiness
The `specs` addon SHALL provide a read-only `specs archivable` operation, `archivable_changes` over MCP, that reports each active change of the workspace repository, or of the store selected with `--store` (`store` over MCP), as ready to archive or lists its blockers: `no_tasks` (no tasks), `tasks_incomplete` (a task is unticked), `slices_unlanded` (a planned slice has not landed on its base branch) and `evidence_missing` (a party slice is `unknown`).

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

#### Scenario: Party evidence missing
- **WHEN** a store change has every task ticked and a `game` slice whose party has no recorded checkout
- **THEN** `specs archivable --store <id>` and `archivable_changes` with that store report it not ready with blocker `evidence_missing`, naming the slice and party

### Requirement: Archive ready changes
The CLI SHALL provide `specs archive --ready [--store <id>]`, never offered over MCP, that archives exactly the ready changes of the workspace repository or the selected store through the pinned OpenSpec CLI, then validates that root's canonical specs strictly. It SHALL report the changes archived and those skipped with their blockers, and SHALL NOT commit. Without `--ready` it SHALL refuse.

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

#### Scenario: Archive a finished store change
- **WHEN** every slice of a store change has landed in its party checkout and every task is ticked, and a caller runs `specs archive --ready --store <id>` from the workspace
- **THEN** the change moves to the store's archive with its contract merged into the store's canonical specs, and no file outside the store's `openspec/` changes

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

### Requirement: Jobs where the caller runs them
The reusable workflow SHALL run every one of its jobs on the runner its caller names, given as one label or as a JSON list of labels, with or without whitespace around it, and on GitHub's `ubuntu-latest` when the caller names none.

#### Scenario: A caller's own runner
- **WHEN** a repository calls the workflow naming its self-hosted runner's labels, once with a space or line break before the list, and another calls it naming none
- **THEN** every job of the first caller's run asks for those labels, and every job of the second's asks for `ubuntu-latest`
