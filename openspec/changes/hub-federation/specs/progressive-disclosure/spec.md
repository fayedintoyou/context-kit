# Spec Delta

## MODIFIED Requirements

### Requirement: Classified links
Each link SHALL be classified from loaded file sets, without probing other paths: `concept` with its hub and ID, `directory`, `file` for other hub files, `external` for URLs, `outside` when it resolves beyond the hub and no mount covers it, or `missing`. Root-relative links resolve from the hub root and others from the concept's directory; a `<mount>:/<concept-id>` link resolves in that mount. Broken links SHALL NOT be errors.

#### Scenario: Follow links
- **WHEN** a caller reads a concept linking to a concept by a root-relative path, to a missing relative path, to a hub file, to a directory, to an external URL and beyond the hub
- **THEN** the links are classified as concept with hub and ID, missing, file, directory, external and outside, and reading the linked ID returns that concept

#### Scenario: Link into a mount
- **WHEN** a workspace concept links to `shared:/tables/orders`, to `shared:/tables/absent`, and to `other:/x` where no mount is named `other`
- **THEN** the links are classified as concept with hub `shared`, its ID and `ref`, missing, and external, and reading the first link's `ref` returns that concept

#### Scenario: Outside link a mount covers
- **WHEN** two mounts share a source repository at paths `hubs/data` and `hubs/platform`, and a concept in the first links to `../platform/deploy.md`
- **THEN** the link is classified as concept with hub set to the second mount and ID `deploy`, and the same link with no second mount declared is outside

#### Scenario: Link into an unfetched mount
- **WHEN** a workspace concept links to `shared:/tables/orders` and `shared` is declared but not fetched
- **THEN** the link is classified as missing with mount `shared` and reason `unfetched`, and the read succeeds
