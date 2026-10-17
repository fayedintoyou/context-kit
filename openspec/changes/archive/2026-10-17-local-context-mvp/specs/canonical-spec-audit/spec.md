# canonical-spec-audit

## Purpose
Provide reliable canonical spec audit behavior for people and agents using the Context Kit toolkit.

## ADDED Requirements

### Requirement: Spec source boundary
The system SHALL expose canonical spec listing, reading and strict validation through an internal adapter boundary; the first adapter SHALL use pinned OpenSpec for the explicitly selected repository.

#### Scenario: Reject inherited root
- **WHEN** OpenSpec resolves a parent repository or a store rather than the selected repository
- **THEN** the adapter refuses the result

### Requirement: Shared spec stores
The system SHALL read canonical specs from a registered OpenSpec store only when a workspace hub declares that store, and SHALL label every spec result with its source so shared specs are never merged with specs that live in the selected repository.

#### Scenario: Read a declared store
- **WHEN** a caller lists specs from a store declared by a hub
- **THEN** the result identifies the store and its resolved root, and repository specs are not included

#### Scenario: Reject an undeclared store
- **WHEN** a caller selects a store that no hub declares, or OpenSpec resolves a different store
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
