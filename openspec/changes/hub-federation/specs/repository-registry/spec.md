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

### Requirement: One repository per upstream
When a mount's concept shares an upstream with another concept, they SHALL be one repository: its id is the first by precedence (workspace hubs, then mounts by name, each by concept ID) and the others are its `alternateIds`, which every `repos` command SHALL accept. A shared upstream SHALL NOT be a name collision.

#### Scenario: Same upstream twice
- **WHEN** a workspace hub and a mount both register `https://github.com/example/orders` with title `orders`, and a caller runs `repos`, `repos locate shared:/repos/orders <checkout>` and `validate`
- **THEN** `repos` lists one repository under the workspace hub's id with `alternateIds` naming `shared:/repos/orders`, the locate records the checkout for it, and `validate` passes without a collision warning

### Requirement: Names across mounts
When different upstreams claim one title or alias and a mount is among the claimants, a workspace hub's claim SHALL win, and a name claimed only by several mounts SHALL belong to none, so their repositories need their ids. Each such collision SHALL be a `validate` warning naming the claimants. Claims among workspace hubs alone SHALL fail `validate` as before.

#### Scenario: Workspace keeps its alias
- **WHEN** a workspace hub and a mount each register a different repository with alias `site`, and a caller runs `repos locate site <checkout of the workspace's one>` and `validate`
- **THEN** the workspace's repository is located, `validate` passes with a warning naming both ids, and the mount's repository is still listed and locatable by its id

#### Scenario: Two mounts claim an alias
- **WHEN** two mounts each register a different repository with alias `api`, and a caller runs `repos locate api <path>`, then `repos locate shared:/repos/api <path>`
- **THEN** the first fails with `AMBIGUOUS_REPOSITORY` naming both ids and records nothing, the second records the path, and each repository is listed with a warning

#### Scenario: Workspace duplicates still fail
- **WHEN** a workspace that also has a mount has two workspace hubs whose Repository concepts share an alias
- **THEN** `validate` fails naming both concepts and the alias, as without the mount

### Requirement: Effective trigger names
A repository's effective names SHALL be its title and aliases minus names disputed across mounts. Keywords SHALL be triggers only, never identifiers, shared ones deduplicated; one equal to another repository's name, with a mount involved, SHALL be dropped with a warning, workspace hubs first. Renderers SHALL trigger only on these, filtered before any description budget; a disputed name SHALL appear only in the body with its qualified ids.

#### Scenario: Ambiguous names leave the triggers
- **WHEN** two mounts each register a different repository with alias `api` and distinct titles, and the skill is rendered
- **THEN** its description contains both titles but not `api`, and its body says `api` may mean either qualified id and to use the id

#### Scenario: Disputed names filtered before the budget
- **WHEN** a workspace's effective names fill the routing skill's description budget, and two mounts also claim the alias `api`
- **THEN** the description holds every effective name it held without the mounts' dispute, never `api`, and `api` is not reported as a skipped alias

#### Scenario: Keywords across mounts
- **WHEN** a workspace repository and a mounted repository both have keyword `billing`, and the mounted one also has keyword `site`, which is a workspace repository's alias, and a caller renders the skill, runs `validate` and `repos locate billing <path>`
- **THEN** the description contains `billing` once and `site` only for the workspace repository, `validate` passes with a warning naming the dropped keyword, and the locate fails with `UNKNOWN_REPOSITORY`

### Requirement: Context from the canonical concept
When concepts share an upstream, the repository's `context` SHALL come only from its canonical concept, with relative refs resolving in that concept's hub; alternate concepts' `context` SHALL be ignored with a warning naming them.

#### Scenario: Open through an alternate id
- **WHEN** mounts `data` and `shared` both register `https://github.com/example/orders`, each with a `context` that refers to `/guides/deploy` in its own hub, and a caller runs `repos open shared:/repos/orders`
- **THEN** it opens `data:/repos/orders` with the `data` concept's context, its ref given as `data:/guides/deploy`, and a warning naming `shared:/repos/orders`

## MODIFIED Requirements

### Requirement: Routing skill guidance
The routing skill's body SHALL tell agents to work in a repository's recorded path, not to search the filesystem for it, to offer `repos clone` or `repos locate` when it is missing, and to fetch each unfetched or broken mount with the exact `mounts fetch` command through the skill's portable entry point, never by changing into the workspace. A workspace with no registered repositories SHALL generate no routing skill unless a mount is unavailable.

#### Scenario: Missing checkout guidance
- **WHEN** the skill is rendered for a repository with no recorded path
- **THEN** its body lists that repository as missing with the exact `repos clone` and `repos locate` commands for it

#### Scenario: No repositories
- **WHEN** a workspace has no Repository concepts and declares no mounts
- **THEN** no routing skill is generated

#### Scenario: Mount declared but not fetched
- **WHEN** a workspace declares a mount it has not fetched and registers one repository of its own, and the skill is rendered
- **THEN** its body names the mount with the exact `mounts fetch shared` command and its metadata lists the workspace's repository

#### Scenario: Only unfetched mounts
- **WHEN** a workspace with no Repository concepts of its own declares an unfetched mount, and a caller in an unrelated directory runs `context-kit --root <workspace> agents install` for both agents
- **THEN** each agent gets a `my-repos` skill whose body gives the exact `mounts fetch shared` command through the portable entry point, with no `cd` into the workspace

#### Scenario: Recovery from an unrelated directory
- **WHEN** a caller in an unrelated directory runs the fetch command exactly as that skill's body gives it, then `repos sync` the same way
- **THEN** the mount is fetched in the workspace, nothing is written to the unrelated directory, and the installed skill names the mount's repositories
