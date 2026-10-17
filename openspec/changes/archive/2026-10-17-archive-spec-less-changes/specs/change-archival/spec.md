# Spec Delta

## MODIFIED Requirements

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
