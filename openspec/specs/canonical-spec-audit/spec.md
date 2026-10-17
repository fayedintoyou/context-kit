# canonical-spec-audit Specification

## Purpose
Read canonical OpenSpec specs from a repository or from shared stores used across repositories, with provenance, and produce honest structural audits that leave semantic compliance to evidence-based review.

## Requirements

### Requirement: Spec source boundary
The system SHALL expose canonical spec listing, reading and strict validation through an internal adapter boundary; the first adapter SHALL use pinned OpenSpec for the explicitly selected repository.

#### Scenario: Reject inherited root
- **WHEN** OpenSpec resolves a parent repository or a store rather than the selected repository
- **THEN** the adapter refuses the result

### Requirement: Shared spec stores
The system SHALL read canonical specs from a registered OpenSpec store only when a workspace hub declares that store or the workspace repository references it, and SHALL label every spec result with its source so shared specs are never merged with specs that live in the selected repository.

#### Scenario: Read a declared store
- **WHEN** a caller lists specs from a store declared by a hub
- **THEN** the result identifies the store and its resolved root, and repository specs are not included

#### Scenario: Read a referenced store
- **WHEN** a caller reads a spec from a store that the repository references but no hub declares
- **THEN** the spec is returned labeled with that store as its source

#### Scenario: Reject an undeclared store
- **WHEN** a caller selects a store that no hub declares and the repository does not reference, or OpenSpec resolves a different store
- **THEN** the request fails without reading specs

### Requirement: Canonical inventory
The adapter SHALL distinguish canonical specifications from pending change deltas.

#### Scenario: Pending-only repository
- **WHEN** a repository has pending changes but no canonical specs
- **THEN** an audit reports no_canonical_specs rather than passing

### Requirement: Honest audit snapshot
The system SHALL produce a bounded audit containing strict structural results, adapter version, HEAD, dirty state, a canonical content hash, and stable requirement keys. Semantic status SHALL remain not_assessed.

#### Scenario: Audit current code
- **WHEN** an audit collects a stable repository snapshot
- **THEN** the report contains requirement checks awaiting implementation evidence and does not claim semantic compliance

### Requirement: Repeatable audits
The project SHALL provide automated structural checks and a documented skill for auditing canonical requirements against implementation after relevant changes and during periodic reviews.

#### Scenario: Semantic review
- **WHEN** an agent audits a canonical requirement
- **THEN** it records evidence, gaps or uncertainty against the reported snapshot and proposes corrections rather than silently changing canonical intent

### Requirement: Referenced store discovery
The system SHALL report the shared stores that the selected repository declares as references, one level deep, with each store's identifier and health. An unregistered or unhealthy referenced store SHALL be reported as a warning rather than failing the request.

#### Scenario: Repository references a registered store
- **WHEN** a repository declares a reference to a registered, healthy store
- **THEN** the result lists that store as available and does not list stores that the store itself references

#### Scenario: Referenced store is missing
- **WHEN** a repository declares a reference to a store that is not registered on this machine
- **THEN** the result lists the store with a warning and still returns the repository's own specs

### Requirement: Separate referenced specs
The system SHALL return specs from referenced stores separately from the repository's own specs and SHALL label each with its source, never merging specs that share an identifier.

#### Scenario: Same identifier in repository and store
- **WHEN** the repository and a referenced store both define a spec with the same identifier
- **THEN** both are returned as distinct entries with different sources

### Requirement: Reference-aware repository audit
A repository audit SHALL include requirements from healthy referenced stores in a separate checklist keyed by store, each marked with applicability not_assessed and semantic status not_assessed, and SHALL record each store's strict structural result and canonical content hash.

#### Scenario: Audit a repository with references
- **WHEN** an audit runs on a repository that references a healthy store
- **THEN** the report contains the repository's own checklist and a separate referenced checklist whose items await applicability and implementation evidence

#### Scenario: Referenced store changes during audit
- **WHEN** a referenced store's canonical specs change while an audit collects its snapshot
- **THEN** the audit fails with a snapshot-changed error

### Requirement: Store audit scope
An audit of a store SHALL remain structural and SHALL state that semantic review of its requirements starts from each repository that references it.

#### Scenario: Audit a store directly
- **WHEN** a caller audits a declared store
- **THEN** the report has semantic status not_assessed and names repository audits as the place for implementation evidence
