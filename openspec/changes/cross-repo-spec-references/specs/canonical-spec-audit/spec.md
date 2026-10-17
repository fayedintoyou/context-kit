# Spec Delta

## ADDED Requirements

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
A repository audit SHALL include requirements from healthy referenced stores in a separate checklist keyed by store, each marked with applicability not_assessed and semantic status not_assessed, and SHALL record each store's canonical content hash in the snapshot.

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
