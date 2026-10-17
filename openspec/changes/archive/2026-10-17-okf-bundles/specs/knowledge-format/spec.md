# Spec Delta

## Purpose

Keep hub knowledge in the Open Knowledge Format so it is portable to other tools, and surface OKF provenance, trust and lifecycle signals to people and agents.

## ADDED Requirements

### Requirement: Hubs are OKF bundles
Hub validation SHALL fail unless the hub directory, excluding dot-directories, is a conformant OKF v0.2 bundle: every Markdown file other than `index.md` and `log.md` is a regular file with YAML mapping frontmatter and a non-empty string `type`; an `index.md` carries no frontmatter except `okf_version`, and only at the hub root; and every `##` heading in a `log.md` is a `YYYY-MM-DD` date. Index and log bodies are otherwise unconstrained.

#### Scenario: Concept without a type
- **WHEN** a hub contains a Markdown concept whose frontmatter is missing or has no `type`
- **THEN** validation fails with an error naming the hub and file

#### Scenario: Reserved file structure
- **WHEN** a nested `index.md` has frontmatter, or a `log.md` has a non-date `##` heading
- **THEN** validation fails naming the file

#### Scenario: Permissive consumption
- **WHEN** a hub's concepts use unknown types, unknown frontmatter keys, links to files that do not exist, no index files, and a root index declaring an unknown `okf_version`
- **THEN** validation succeeds and the declared version is reported

### Requirement: Lenient reads
Retrieval and search SHALL fail only when a curated document is not an OKF concept; other nonconformant files SHALL be reported as warnings without blocking reads.

#### Scenario: Stray file
- **WHEN** a hub contains an extra Markdown file without frontmatter that is not a curated document
- **THEN** context still returns the curated documents and reports a warning naming the file, while validation fails

### Requirement: OKF trust summaries
Retrieval and search SHALL report each document's OKF type, title, description, status and trust tier, grouped apart from Context Kit's own review status and derived only from OKF fields. No usable `verified` entry is unverified, verification only by non-`human:` actors is machine-confirmed, and any `human:` verifier is human-reviewed. A bare `verified` mapping counts as one entry. Absent status is stable.

#### Scenario: Trust tiers and staleness
- **WHEN** curated documents are respectively verified by a `human:` actor as a bare mapping with a past `stale_after`, verified only by a `process:` actor, and carrying no trust fields
- **THEN** context reports them as human-reviewed and stale, machine-confirmed and not stale, and unverified, stable and not stale

### Requirement: OKF staleness
Retrieval and search SHALL report a concept as stale when the current time is at or after its `stale_after` datetime, which must carry an explicit UTC offset; a missing or malformed value SHALL NOT be stale.

#### Scenario: Offsetless staleness
- **WHEN** a curated document's `stale_after` is a past datetime without a UTC offset
- **THEN** context reports it as not stale and warns about the malformed field

### Requirement: OKF workspace starter
Initializing a workspace SHALL produce a conformant OKF bundle whose hub-root `index.md` declares `okf_version: "0.2"` and lists the starter document.

#### Scenario: Conformant starter
- **WHEN** a caller initializes a workspace
- **THEN** its starter hub validates as an OKF bundle and its index declares the OKF version
