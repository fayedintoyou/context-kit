# Spec Delta

## Purpose

Let people and agents discover hub knowledge step by step: list what a directory holds, open one concept by its OKF ID, and follow its links, instead of loading everything at once.

## ADDED Requirements

### Requirement: Browse a directory
The system SHALL list one hub directory as separate arrays of immediate child concepts (ID, OKF type, title, description, status, trust, staleness, whether curated or inbox) and immediate subdirectories (ID, concept count, index title). It SHALL include the directory's `index.md` body, or `null` when absent, and only warnings for files in that directory.

#### Scenario: Browse with and without an index
- **WHEN** a caller browses a hub root that has an `index.md` and then a subdirectory that has none
- **THEN** the root listing includes the index body and its entries, and the subdirectory listing has a `null` index with entries built from concept frontmatter

#### Scenario: Unknown or escaping directory
- **WHEN** a caller browses a path that does not exist (`UNKNOWN_PATH`), is a file (`UNKNOWN_PATH`), contains a dot or traversal segment (`INVALID_PATH`), or is a symlink (`PATH_ESCAPE`)
- **THEN** the request fails with that code and lists nothing

### Requirement: Bounded listings
Listings SHALL sort entries by code point, cap descriptions at 300 characters and index bodies at 16 KiB, return at most 200 entries per array starting at a caller-supplied offset, and report totals and `truncated` when more entries exist.

#### Scenario: Page a large directory
- **WHEN** a directory holds more than 200 concepts and a caller browses it, then browses again with offset 200
- **THEN** the first listing has 200 concepts, the total and `truncated`, and the second continues in the same order with the rest

### Requirement: Read a concept
The system SHALL return one concept addressed by its OKF concept ID, the path within the hub without `.md`, with its OKF summary, body, warnings and outgoing inline Markdown links outside code, and its full frontmatter only when requested. IDs ending in `.md` are invalid input; reserved and nonconformant files are `NOT_A_CONCEPT`; unknown IDs are `UNKNOWN_CONCEPT`.

#### Scenario: Not a concept
- **WHEN** a caller reads a reserved file, a nonconformant file, an unknown ID, a traversal path or an ID ending in `.md`
- **THEN** the request fails with `NOT_A_CONCEPT`, `UNKNOWN_CONCEPT`, `INVALID_PATH` or `INVALID_INPUT` respectively

### Requirement: Classified links
Each link SHALL be classified from the hub's own file set, without probing other paths: `concept` with its hub and ID, `directory`, `file` for other hub files, `external` for URLs, `outside` when it resolves beyond the hub, or `missing`. Root-relative links resolve from the hub root and others from the concept's directory. Broken links SHALL NOT be errors.

#### Scenario: Follow links
- **WHEN** a caller reads a concept linking to a concept by a root-relative path, to a missing relative path, to a hub file, to a directory, to an external URL and beyond the hub
- **THEN** the links are classified as concept with hub and ID, missing, file, directory, external and outside, and reading the linked ID returns that concept

### Requirement: Discoverable entry point
Search SHALL cover every concept in a hub, reporting each match's concept ID and whether it is curated or an inbox note, and retrieving a hub's context SHALL name where to start browsing it.

#### Scenario: Find what browse shows
- **WHEN** a hub has a concept that is not in its curated selection and a caller searches for its text and retrieves the hub's context
- **THEN** search returns that concept's ID marked not curated, and the context names the hub root as the place to browse

### Requirement: Inbox stays opt-in
Browse, read and search SHALL exclude inbox notes unless the caller requests them, and SHALL mark them as inbox notes when included.

#### Scenario: Inbox requested
- **WHEN** a hub has a captured note and a caller browses, reads and searches without and then with inbox requested
- **THEN** the note is hidden and unreadable at first, then listed, readable and found as an inbox note
