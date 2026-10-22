# Spec Delta

## MODIFIED Requirements

### Requirement: Hubs are OKF bundles
Hub validation SHALL fail unless each workspace hub's directory, excluding dot-directories, is a conformant OKF v0.2 bundle: every Markdown file other than `index.md` and `log.md` is a regular file with YAML mapping frontmatter and a non-empty string `type`; an `index.md` carries no frontmatter except `okf_version`, and only at the hub root; and every `##` heading in a `log.md` is a `YYYY-MM-DD` date. Index and log bodies are otherwise unconstrained.

#### Scenario: Concept without a type
- **WHEN** a hub contains a Markdown concept whose frontmatter is missing or has no `type`
- **THEN** validation fails with an error naming the hub and file

#### Scenario: Reserved file structure
- **WHEN** a nested `index.md` has frontmatter, or a `log.md` has a non-date `##` heading
- **THEN** validation fails naming the file

#### Scenario: Permissive consumption
- **WHEN** a hub's concepts use unknown types, unknown frontmatter keys, links to files that do not exist, no index files, and a root index declaring an unknown `okf_version`
- **THEN** validation succeeds and the declared version is reported

## ADDED Requirements

### Requirement: Mounted bundles are checked leniently
Validation SHALL check a fetched mount with the lenient read rules: its nonconformant files SHALL be `validate` warnings naming the mount and file, never failures, since the workspace cannot fix them.

#### Scenario: Nonconformant mount
- **WHEN** a fetched mount has a non-curated Markdown file without frontmatter and a `log.md` with a non-date heading, and the workspace's own hubs are conformant
- **THEN** `validate` passes with warnings naming `shared` and each file
