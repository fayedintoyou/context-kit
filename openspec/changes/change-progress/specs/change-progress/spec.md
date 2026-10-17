# Spec Delta

## Purpose

Deliver an accepted change as independently mergeable slices: plan them in the change, derive which have landed from commit trailers and pull requests, hand out self-contained work packets, and check what was built against the change before archive.

## ADDED Requirements

### Requirement: Slice plan
An active change MAY include `slices.yaml` dividing it into slices. Each slice SHALL have an id, the change requirements it implements as `<capability> / <requirement name>`, the slices it depends on, and optional path globs. The plan MAY name a base branch and SHALL hold no status.

#### Scenario: Valid plan
- **WHEN** a change has a plan whose slices cover its requirements with acyclic dependencies
- **THEN** `specs status` lists every slice and requirement without error

### Requirement: Slice plan validation
A plan with a duplicate or invalid slice id, an unknown or cyclic dependency, an implemented requirement absent from the change's deltas, or a path that leaves the repository SHALL fail with `INVALID_CONFIG` naming the file and the problem.

#### Scenario: Invalid plan
- **WHEN** a plan has a dependency cycle, or implements a requirement the change's deltas do not contain
- **THEN** the operation fails with `INVALID_CONFIG` naming `slices.yaml` and the cycle or requirement

### Requirement: Slice landing
The `specs` addon SHALL provide a read-only `specs status <change>` operation, `change_status` over MCP, that derives each slice's state from commits carrying `OpenSpec-Change` and `OpenSpec-Slice` trailers: `landed` when such a commit is reachable from the base branch, `in_progress` when one exists only on other branches, `ready` when every dependency has landed, and otherwise `blocked`.

#### Scenario: Partly delivered change
- **WHEN** one slice's trailer commit is merged into the base branch, a second slice's trailer commit exists only on a feature branch, and a third slice depends on the second
- **THEN** status reports the slices `landed`, `in_progress` and `blocked`, names the feature branch, and counts one of three slices landed

#### Scenario: Status over MCP
- **WHEN** an MCP client calls `change_status` in a workspace with the `specs` addon enabled
- **THEN** it returns the same result as the CLI, and the tool is absent when the addon is disabled

### Requirement: Requirement progress
Status SHALL report each requirement in the change's deltas as `landed` when all its covering slices have landed, `partial` when some have, `in_progress` when none has but one is in progress, `unstarted`, or `unplanned` when no slice covers it. Change totals SHALL be derived from these states and never stored.

#### Scenario: Requirement covered by two slices
- **WHEN** a requirement is implemented by two slices and only one has landed
- **THEN** the requirement is `partial` and the change is not ready to reconcile

#### Scenario: No plan
- **WHEN** an active change has no `slices.yaml`
- **THEN** status reports the plan `absent` and every requirement `unplanned`

### Requirement: Pull request enrichment
When the GitHub CLI is available, status SHALL name the pull requests that carry a slice's trailers and SHALL treat an open one as `in_progress` and a merged one as `landed`. When it is unavailable or fails, pull requests SHALL be reported `not_collected` with the reason, and git evidence alone SHALL decide each state.

#### Scenario: Open pull request
- **WHEN** `gh` reports an open pull request whose description carries a slice's trailers and no local branch has its commits
- **THEN** the slice is `in_progress` and names the pull request

#### Scenario: GitHub CLI missing
- **WHEN** `gh` is not on the path
- **THEN** pull requests are `not_collected` and landed slices are still reported from git

### Requirement: Next slices
The system SHALL provide `specs next <change>`, `next_slices` over MCP, returning a packet for every `ready` slice, and `specs slice <change> <slice>`, `read_slice` over MCP, returning the packet for any slice. Neither SHALL write anything.

#### Scenario: Parallel ready slices
- **WHEN** two slices depend only on a landed slice and neither has trailer commits
- **THEN** `specs next` returns packets for both, each with its requirements, the landed dependency's commit and its trailers

#### Scenario: Nothing ready
- **WHEN** every unlanded slice is in progress or blocked
- **THEN** `specs next` returns no packets and says why

### Requirement: Slice packet
A packet SHALL contain the change, the slice, the base branch and commit, each implemented requirement's delta text and scenarios with the canonical text it modifies, the dependencies with their landing commits, the declared paths, and the trailers to use. For a landed or in-progress slice, it SHALL also contain the commits, branches or pull requests to review.

#### Scenario: Packet for a modified requirement
- **WHEN** a slice implements a requirement the change modifies
- **THEN** its packet contains both the delta text and the canonical text it replaces

### Requirement: Reconcile report
The system SHALL provide a read-only `specs reconcile <change>`, `reconcile_change` over MCP, that reports, with the change's status:
- per slice, files its trailer commits changed outside its declared paths, or `unchecked` when it declares none
- files changed by more than one slice
- trailer commits naming an unknown slice of the change
- requirements no slice implements
- scenarios of the change that no test links, or `not_collected` when the repository has no test links

#### Scenario: Out-of-scope file
- **WHEN** a landed slice declares `src/search/**` and its trailer commit also changes `src/ingest/retry.mjs`
- **THEN** the report lists `src/ingest/retry.mjs` as out of scope for that slice

#### Scenario: Stray trailer
- **WHEN** a commit carries this change's trailer with a slice id the plan does not contain
- **THEN** the report lists the commit and the unknown slice id

#### Scenario: Untested change scenario
- **WHEN** every requirement has landed but one of the change's scenarios has no linked test
- **THEN** the report lists that scenario as untested

### Requirement: Delivery skills
The toolkit SHALL bundle `slice-change` and `reconcile-change` skills in the `specs` addon. `slice-change` SHALL write only a slice plan for an accepted change, made of independently mergeable slices, and validate it with `specs status`.

#### Scenario: Specs addon lists the delivery skills
- **WHEN** a caller lists addons in a workspace with the `specs` addon enabled
- **THEN** the `specs` entry lists `slice-change` and `reconcile-change` with the audit and garden skills

### Requirement: Reconcile without absorbing scope
`reconcile-change` SHALL judge an implementation against its change from the reconcile report and evidence, resolve divergence by recommending a proposal amendment or a separate change rather than absorbing scope, and review a single slice's pull request through `independent-review` with the slice packet as the brief.

#### Scenario: Divergence is surfaced, not absorbed
- **WHEN** an agent reconciles a change whose landed slice added behavior outside the change's requirements
- **THEN** it reports the divergence with evidence and recommends amending the proposal or a separate change, and edits neither the deltas nor canonical specs
