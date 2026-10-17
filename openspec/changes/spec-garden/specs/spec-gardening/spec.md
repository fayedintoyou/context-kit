# Spec Delta

## Purpose

Keep canonical specs well organized over time: report deterministic signals about their shape (size, history, locks, overlap, trace, taxonomy) and turn evidence-based maintenance into ordinary reviewed changes, never direct rewrites.

## ADDED Requirements

### Requirement: Garden report
The `specs` addon SHALL provide a read-only `specs garden` operation, `garden_specs` over MCP, that reports the shape of a repository's or a declared store's canonical specs against a stable snapshot (HEAD, dirty state, canonical content hash). It SHALL fail with `SNAPSHOT_CHANGED` when the snapshot moves during collection, and it SHALL report `no_canonical_specs` when only pending changes exist.

#### Scenario: Garden a repository
- **WHEN** a caller gardens a repository with canonical specs
- **THEN** the report carries the snapshot and, per spec, its line, requirement and scenario counts, with requirement keys equal to those `audit_specs` returns

#### Scenario: Garden over MCP
- **WHEN** an MCP client calls `garden_specs` in a workspace with the `specs` addon enabled
- **THEN** it returns the same report as the CLI, and the tool is absent when the addon is disabled

#### Scenario: Pending changes only
- **WHEN** a repository has active changes but no canonical specs
- **THEN** the report status is `no_canonical_specs`

#### Scenario: Gardening writes nothing
- **WHEN** a caller gardens a repository
- **THEN** no file in the repository is created, modified or removed

### Requirement: Size limits
The report SHALL flag a spec as `oversized` when its requirement count or line count exceeds the applicable limit, and SHALL list requirements that have no scenarios. Limits SHALL come from the domain's override in the taxonomy, then the taxonomy's defaults, then built-in defaults, and the report SHALL state the limits it applied.

#### Scenario: Oversized spec
- **WHEN** a spec has more requirements than the applicable limit
- **THEN** the spec is flagged `oversized` and the report names the limit used

#### Scenario: Domain override
- **WHEN** the taxonomy raises the requirement limit for one domain
- **THEN** that spec is not flagged at its size while another spec of the same size is

### Requirement: Requirement history
The report SHALL list, for each canonical requirement, the archived changes whose deltas added, modified or renamed it, with each archive date, carrying history across renames. A requirement with no archived history SHALL have an empty history, not an inferred one.

#### Scenario: History across a rename
- **WHEN** one archived change added a requirement and a later one renamed it
- **THEN** the renamed requirement's history lists both changes in date order

#### Scenario: Written without a change
- **WHEN** a canonical requirement appears in no archived delta
- **THEN** its history is empty

### Requirement: Locks from active changes
The report SHALL mark a requirement as locked by every active change whose delta modifies, removes or renames it, and SHALL mark a spec as touched by every active change with a delta for that capability.

#### Scenario: Requirement under active change
- **WHEN** an active change modifies a canonical requirement
- **THEN** that requirement's `lockedBy` names the change and other requirements in the spec are not locked

### Requirement: Lexical overlap
The report SHALL list pairs of requirements, within and across specs, whose normalized wording overlaps at or above the applicable threshold, each with its score and the method `lexical`, and SHALL state when it truncated the list to fit the output budget.

#### Scenario: Near-duplicate requirements
- **WHEN** two specs contain requirements that differ only in a few words
- **THEN** the pair is reported with method `lexical` and a score at or above the threshold, and an unrelated requirement pair is not

### Requirement: Scenario trace
When the repository links tests to scenarios with `// spec: <capability> / <scenario>` comments, the report SHALL list each requirement's scenarios that no test links, using the same parsing as the project's link check. When no such links exist, trace SHALL be `not_collected` and no scenario SHALL be reported untested.

#### Scenario: Unlinked scenario
- **WHEN** a repository links tests to all but one scenario
- **THEN** the report lists that scenario as untested under its requirement

#### Scenario: No link convention
- **WHEN** a repository has no `// spec:` links
- **THEN** trace is `not_collected` and every requirement's `untested` is null

### Requirement: Spec taxonomy
A repository or store MAY declare its intended capability domains, default limits and retired names in `openspec/taxonomy.yaml`. When present, the report SHALL list canonical specs the taxonomy does not declare, declared domains with no spec, and retired names that still exist as specs. When absent, domain checks SHALL be reported as `unchecked`. A malformed taxonomy SHALL fail with `INVALID_CONFIG` naming the problem.

#### Scenario: Taxonomy drift
- **WHEN** the taxonomy declares a domain with no spec, omits an existing spec, and retires a name that is still a spec
- **THEN** the report lists each under `empty`, `undeclared` and `retiredInUse`

#### Scenario: No taxonomy
- **WHEN** a repository has no taxonomy file
- **THEN** taxonomy status is `absent`, each spec's domain is `unchecked`, and the other signals are still reported

#### Scenario: Malformed taxonomy
- **WHEN** the taxonomy file is not valid YAML or declares a domain with an invalid identifier
- **THEN** gardening fails with `INVALID_CONFIG` naming the file and the problem

### Requirement: Maintenance through changes
The toolkit SHALL bundle a `garden-canonical-specs` skill in the `specs` addon that interprets the garden report with evidence from specs, code, tests and history, and expresses accepted structural maintenance only as an ordinary change for review. It never edits canonical specs directly, never touches locked requirements, and retires a requirement only after the user confirms it.

#### Scenario: Specs addon lists the gardener
- **WHEN** a caller lists addons in a workspace with the `specs` addon enabled
- **THEN** the `specs` entry lists `audit-canonical-specs` and `garden-canonical-specs`

#### Scenario: Gardening proposes, never rewrites
- **WHEN** an agent gardens a tree with an oversized spec and a likely obsolete requirement
- **THEN** it creates a single change that moves requirements with unchanged text, asks the user about the retirement instead of removing it, and leaves `openspec/specs/` untouched
