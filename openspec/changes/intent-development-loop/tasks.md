# Tasks

## 1. Pilot evidence and scope check

- [ ] 1.1 Confirm the application pilot has one actual roadmap revision and one feedback disposition linked through selected work and an observed result; retain evidence in its private/project source and write only anonymized reusable lessons here. Verify the lessons cite what happened rather than a fictional walkthrough or passing software test. Leave this task unticked until that evidence exists; this gate does not block application gameplay or refactors.
- [ ] 1.2 Compare those lessons with this plan and existing skill routing, then independently review the minimal packaged method before implementation. Verify each retained field/trigger has a concrete use and any change in scope is reflected in proposal/design/tasks; do not add CLI/MCP behavior to this documentation change.

## 2. Portable method and fictional walkthrough

- [ ] 2.1 Author `skills/product-development/SKILL.md` with narrow triggers and handoffs to existing OpenSpec/review workflows. Add experiment/refactor reference templates, preserving the distinction between intent, acceptance, delivery and evaluation. Verify a manual walkthrough chooses the right path for a gameplay idea, a behavior repair and a pure refactor without inventing specs or approving work.
- [ ] 2.2 Add a conformant fictional `examples/product-development/` hub and walkthrough with two views, competing hypotheses, a selected experiment and a behavior-preserving refactor. Verify links and field usage through `node bin/hub.mjs validate`, browse/read operations and a dry-run handoff that keeps unselected ideas as seeds. Label invented observations fictional and inspect every source/path for private material.
- [ ] 2.3 Register the skill in the existing specs addon and example manifest, update discovery/help references and describe the method before/after accepted delivery in docs. Run existing `test/e2e/skills.test.mjs`, `test/e2e/addons.test.mjs` and relevant agent-installation fixture coverage; verify discovery/read/install/remove through the real interfaces in isolated fixtures. Add or extend a test only where an actual discovery/installation regression is otherwise uncovered; do not claim a new scenario when no contract changes.

## 3. Compatibility and readiness

- [ ] 3.1 Check the final state of cross-repo delivery PR #24 before documenting any multi-repository example. Verify references reuse its actual party/identity/evidence/archival contract if available, or explicitly keep the walkthrough repository-local. No changes to its implementation, slices or trailer format are included here.
- [ ] 3.2 Run strict OpenSpec validation, hub validation and `npm test` with fictional/isolated fixtures. Independently review the finished skill/templates/example, resolve material findings, and verify no user workspace/addons/credentials were modified or globally installed.

## Workflow follow-up

- This is a documentation/skill change with `skip_specs: true`; leave the skipped spec artifact absent. A future deterministic operation requires a new behavior change with CLI/MCP-observable scenarios and linked end-to-end tests.
- Merge only within the user's authorization; archive through the repository workflow after implementation tasks are complete. User workspaces adopt a landed toolkit commit deliberately through their existing upgrade/sync process.
