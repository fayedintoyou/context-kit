# Spec Delta

## MODIFIED Requirements

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
