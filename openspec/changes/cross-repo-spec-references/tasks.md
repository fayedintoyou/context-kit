# Tasks

## 1. Reference discovery

- [ ] 1.1 Add an adapter call that reads a repository's declared references from `openspec context --json` with a strict schema, and verify with a test fixture that a healthy, a missing and a nested reference are reported as available, warning and absent respectively
- [ ] 1.2 Return referenced store specs from `list_specs` for a repository as a separate, source-labeled `references` field, and verify a test where the repository and store share a spec identifier returns both entries

## 2. Reference-aware audits

- [ ] 2.1 Collect each healthy referenced store in the audit snapshot with its own hash and a store-prefixed checklist marked applicability not_assessed, and verify keys are distinct from repository keys in a test
- [ ] 2.2 Fail the audit with `SNAPSHOT_CHANGED` when a referenced store changes between collections, and verify with a test that edits the store mid-audit
- [ ] 2.3 Add the store-audit scope note to store audit reports, and verify the store audit test asserts it
- [ ] 2.4 Update `skills/audit-canonical-specs/SKILL.md` to explain reviewing referenced requirements for applicability from the referencing repository, and verify the CLI examples in it run as written

## 3. Integration

- [ ] 3.1 Run the full test suite and `openspec validate cross-repo-spec-references --strict`, and verify both pass

## Workflow follow-up

- Archive `local-context-mvp` before archiving this change, so `canonical-spec-audit` exists as a canonical spec.
