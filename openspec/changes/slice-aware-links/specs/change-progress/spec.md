## ADDED Requirements

### Requirement: Test links wait for a slice
For an active repository change with a slice plan, the link check (`npm run spec-links`, run by `npm test`) SHALL require a linked test for a scenario only when a slice implementing its requirement has landed or has a trailer commit on HEAD that is not on the plan's base. Its other scenarios SHALL be listed as pending with their change and slices and SHALL NOT fail the check. Requirements no slice implements, and changes without a plan, SHALL stay required.

#### Scenario: Unstarted slices are pending
- **WHEN** change `deliver` plans slices `storage` and `api`, neither has trailer commits, and no test links their scenarios
- **THEN** the link check passes and lists both scenarios as pending, naming `deliver` and each scenario's slice

#### Scenario: Slice on the current branch
- **WHEN** HEAD has a commit with `OpenSpec-Change: deliver` and `OpenSpec-Slice: storage` that is not on `main`, another branch has the `api` slice's trailer commit, and no test links either slice's scenario
- **THEN** the link check fails naming the `storage` scenario, and the `api` scenario is still pending

#### Scenario: Landed slice
- **WHEN** the `storage` slice's trailer commit is merged into `main`, HEAD is `main`, and no test links its scenario
- **THEN** the link check fails naming that scenario, and passes once a test links it

#### Scenario: Requirement no slice implements
- **WHEN** a planned change has a requirement no slice implements, or a change has no `slices.yaml`, and no test links their scenarios
- **THEN** the link check fails naming each of those scenarios

### Requirement: Test links fail closed
When a planned change's progress can't be read, as in a shallow clone, outside git, with an invalid plan or for a store's change, the link check SHALL require every scenario of the change and say why. Pending scenarios SHALL still be listed untested by `specs reconcile`, and a change with an unlanded slice SHALL NOT be archivable, so a change archives only with every scenario linked.

#### Scenario: Shallow clone
- **WHEN** a planned change with no started slice is checked in a shallow clone, or its `slices.yaml` is invalid
- **THEN** the link check fails naming every scenario of the change, and its output names the change and the reason

#### Scenario: Archive needs every link
- **WHEN** a planned change's scenarios are pending
- **THEN** `specs reconcile` lists them as untested and `specs archivable` reports the change's slices unlanded, and once every slice has landed the link check requires all of them
