# Spec Delta

## ADDED Requirements

### Requirement: Mounted repositories
Repository concepts in fetched mounts, outside their inbox, SHALL be registered repositories identified as `<mount>:/<concept-id>`, keyed by upstream with checkouts recorded per machine. `repos`, `list_repos`, `repos locate`, `repos clone`, `repos scan` and the routing skill SHALL include them and name their mount. Commands that change a mount SHALL refresh the routing skill.

#### Scenario: One person's hub on two machines
- **WHEN** a person's laptop and desktop workspaces both mount the same hub, which registers `https://github.com/example/orders` with alias `orders`, and each machine runs `repos locate orders` at its own checkout
- **THEN** each `repos` lists `shared:/repos/orders` with that machine's path and mount `shared`, each rendered `my-repos` names `orders` with that path, and no hub or mount file changed

#### Scenario: Many people, one hub
- **WHEN** two people's separate workspaces mount the same hub at the same commit, one locates `orders` and the other has not
- **THEN** both list the same repositories, ids and aliases, the first with its path and the second with `orders` missing and the exact `repos clone` and `repos locate` commands in its `my-repos`

#### Scenario: Upgrade brings a new repository
- **WHEN** the routing skill is installed, and the mounted hub's source gains a Repository concept that the workspace pulls in with `mounts upgrade shared`
- **THEN** the installed skill names the new repository as missing, with the exact `repos clone` and `repos locate` commands for its id, without running `agents install`

### Requirement: Names across mounts
A repository name or upstream claimed in more than one place SHALL resolve by precedence: workspace hubs over mounts. A name two mounts claim, and no workspace hub, SHALL belong to neither. Each collision SHALL be a warning naming the claimants, never a `validate` failure, and every repository stays addressable by its id.

#### Scenario: Workspace keeps its alias
- **WHEN** a workspace hub and a mount each register a different repository with alias `site`, and a caller runs `repos locate site <checkout of the workspace's one>` and `validate`
- **THEN** the workspace's repository is located, `validate` passes with a warning naming both ids, and the mount's repository is still listed and locatable by its id

#### Scenario: Two mounts claim an alias
- **WHEN** two mounts each register a different repository with alias `api`, and a caller runs `repos locate api <path>`
- **THEN** it fails with `AMBIGUOUS_REPOSITORY` naming both ids, the routing skill's description omits `api`, and each repository is listed with a warning

#### Scenario: Same upstream twice
- **WHEN** a workspace hub and a mount both register the same upstream
- **THEN** `repos` lists it once under the workspace hub's id and warns naming the mount's concept

### Requirement: Routing with unavailable mounts
When a declared mount is unfetched or broken, the routing skill SHALL say so in its body with the exact `mounts fetch` command, and SHALL list the repositories of the other hubs and mounts as usual.

#### Scenario: Mount declared but not fetched
- **WHEN** a workspace declares a mount it has not fetched and registers one repository of its own, and the skill is rendered
- **THEN** its body names the mount with `mounts fetch shared` and its metadata lists the workspace's repository
