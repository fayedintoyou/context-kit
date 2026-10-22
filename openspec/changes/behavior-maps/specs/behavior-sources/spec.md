# Spec Delta

## Purpose

Read where a repository's or hub's behavioral truth lives, whatever method keeps it (OpenSpec specs, linked-intent development specs, hub concepts), as behaviors with stable IDs and fingerprints that maps and other tools can cite, without executing anything from the repository or hub.

## ADDED Requirements

### Requirement: Behavior source boundary
The system SHALL read behaviors only through kit-owned sources chosen by name from a closed set (`openspec`, `lid`, `hub`). Each behavior SHALL have a source-native ID, a kind, a title, its text, the file it comes from and a fingerprint of its normalized text. An unknown source name SHALL fail with `INVALID_INPUT`, and no source SHALL run code from the repository or hub it reads.

#### Scenario: Unknown source
- **WHEN** a caller lists behaviors from a source named `jira`
- **THEN** the request fails with `INVALID_INPUT` naming the supported sources

### Requirement: OpenSpec behaviors
The `openspec` source SHALL list the canonical requirements of the workspace repository, or of a store chosen under the spec store rule, as `<capability> / <requirement>` and their scenarios as `<capability> / <scenario>`, each scenario naming its requirement. Pending change deltas SHALL NOT be listed.

#### Scenario: List OpenSpec behaviors
- **WHEN** a repository has a canonical capability with two requirements and three scenarios, and a pending change adds a fourth scenario
- **THEN** `maps behaviors --source openspec` and `list_behaviors` list the two requirements and three scenarios with fingerprints, and not the pending one

#### Scenario: Undeclared store
- **WHEN** a caller lists `openspec` behaviors from a store no hub declares and the repository does not reference
- **THEN** the request fails with `UNKNOWN_STORE` without reading specs

### Requirement: Linked-intent behaviors
The `lid` source SHALL list each `**<ID>**:` entry in `docs/intent/**/*-specs.md` and `docs/specs/*.md` of the workspace repository, with its text and marker: `implemented` for `[x]`, `gap` for `[ ]`, `deferred` for `[D]`, and `none` without one. An ID defined twice SHALL fail with `INVALID_SOURCE` naming both files.

#### Scenario: List linked-intent behaviors
- **WHEN** a repository's specs file defines `TIP-001` marked `[x]`, `TIP-002` marked `[ ]` and `TIP-003` marked `[D]`
- **THEN** `maps behaviors --source lid` lists the three IDs with markers `implemented`, `gap` and `deferred` and the file they come from

#### Scenario: Duplicate linked-intent ID
- **WHEN** two specs files both define `TIP-001`
- **THEN** the request fails with `INVALID_SOURCE` naming `TIP-001` and both files

### Requirement: Hub behaviors
The `hub` source SHALL list a hub's concepts as `<hub-id>:/<concept-id>` with their title, OKF trust summary and freshness action, and with inbox notes only when the inbox is requested. Its fingerprint SHALL cover the concept file's full content.

#### Scenario: List hub behaviors
- **WHEN** a hub has a human-reviewed concept, a stale concept and an inbox note
- **THEN** `maps behaviors --source hub --hub <id>` lists the two concepts with their trust and freshness action and omits the note unless `--inbox` is given

### Requirement: Stable fingerprints
A behavior's fingerprint SHALL depend only on its normalized text (Unicode NFKC, line endings and trailing whitespace normalized), so it is identical across runs and machines and changes when the text changes.

#### Scenario: Fingerprint follows the text
- **WHEN** behaviors are listed twice, a scenario's line endings are changed to CRLF, they are listed again, then the scenario's THEN line is edited
- **THEN** the first three listings give the scenario the same fingerprint and the last gives a different one
