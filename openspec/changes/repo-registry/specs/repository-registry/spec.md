# Spec Delta

## Purpose

Let agents route a request that names one of the user's repositories straight to its local checkout, using the workspace's Repository concepts as a shared registry and each machine's own record of where those repositories are checked out.

## ADDED Requirements

### Requirement: Repositories are core
The `repos` operations, `list_repos` and the generated routing skill SHALL be part of core: available in every workspace whatever addons are enabled, and never refused with `ADDON_DISABLED`.

#### Scenario: Core-only workspace routes repositories
- **WHEN** a workspace created with `--addons none` registers a repository and a caller runs `repos`, calls `list_repos` over MCP, and installs agents
- **THEN** all three work, and the installed skills are `context-kit` and `my-repos`

### Requirement: Repository concepts form the registry
Every concept with `type: Repository` in the workspace's hubs SHALL be a registered repository, identified as `<hub-id>/<concept-id>`. Its `resource` SHALL be its upstream (a git URL or `https://github.com/<owner>/<name>`), and its optional `aliases` SHALL list other names it goes by. `validate` SHALL report a Repository concept whose `resource` is missing or not a git upstream, or whose `aliases` is not a list of strings, and an alias or title claimed by two repositories.

#### Scenario: List registered repositories
- **WHEN** a workspace has Repository concepts in two hubs and a caller runs `repos`
- **THEN** each is listed once with its id, title, upstream and aliases, and a concept of another type is not listed

#### Scenario: Invalid repository fields
- **WHEN** a Repository concept has no `resource`, or an `aliases` that is not a list of strings
- **THEN** `validate` fails naming that concept and the field

#### Scenario: Alias claimed twice
- **WHEN** two Repository concepts share an alias
- **THEN** `validate` fails naming both concepts and the alias

### Requirement: Machine-local checkouts
Local checkout paths SHALL be stored only in the workspace's untracked state, never in a hub, keyed by the repository's upstream, so the same workspace on another machine starts with every repository `missing`. `repos` SHALL report each repository's recorded path, or `missing` when none is recorded or the recorded directory no longer exists.

#### Scenario: A fresh machine has no checkouts
- **WHEN** a workspace whose hubs register repositories is used from a copy with no local state
- **THEN** `repos` reports every repository as `missing`, and no hub file changed

### Requirement: Locate an existing checkout
`repos locate <repo> <path>` SHALL record `<path>` for the repository named by id or alias only when `<path>` is a git working tree with a remote whose URL is the repository's upstream (ignoring protocol, `.git` suffix and case); otherwise it SHALL fail without recording anything.

#### Scenario: Locate by alias
- **WHEN** a caller locates a repository by one of its aliases at a checkout whose `origin` is that upstream over SSH
- **THEN** the path is recorded and `repos` reports it

#### Scenario: Wrong checkout
- **WHEN** a caller locates a repository at a directory that is not a git checkout, or whose remotes point elsewhere
- **THEN** the command fails naming the mismatch and nothing is recorded

### Requirement: Clone a missing checkout
`repos clone <repo> [<path>]` SHALL clone the repository's upstream into `<path>` (default: a directory named after the repository under the user's home) and record it, and SHALL refuse a destination that already exists.

#### Scenario: Clone and record
- **WHEN** a caller clones a registered repository into a new path
- **THEN** the path is a checkout of that upstream and `repos` reports it

### Requirement: Scan a directory once
`repos scan <directory>` SHALL examine only `<directory>` and its immediate subdirectories, record every git checkout whose remote matches a registered upstream that has no recorded path, report what it recorded and what remains missing, and never overwrite a recorded path that still exists.

#### Scenario: Scan finds checkouts
- **WHEN** a directory holds a matching checkout one level down, an unrelated repository, and a matching checkout three levels down
- **THEN** only the first is recorded, and the repository whose checkout is deeper is reported missing

### Requirement: Generated routing skill
The workspace SHALL provide a generated skill named `my-repos` whose description names every registered repository by title and aliases, so agents select it when a request mentions one, and whose `metadata` lists each repository's id, upstream, aliases and local path or `missing`.

#### Scenario: Skill names every repository
- **WHEN** a workspace registers a repository with aliases and its checkout is located, and the skill is rendered
- **THEN** its description contains the title and each alias, its metadata gives the upstream and the local path, and it passes the bundled-skill frontmatter rules for both agents

### Requirement: Routing skill guidance
The routing skill's body SHALL tell agents to work in a repository's recorded path, not to search the filesystem for it, and to offer `repos clone` or `repos locate` when it is missing. A workspace with no registered repositories SHALL generate no routing skill.

#### Scenario: Missing checkout guidance
- **WHEN** the skill is rendered for a repository with no recorded path
- **THEN** its body lists that repository as missing with the exact `repos clone` and `repos locate` commands for it

#### Scenario: No repositories
- **WHEN** a workspace has no Repository concepts
- **THEN** no routing skill is generated

### Requirement: Read-only repository listing over MCP
The MCP server SHALL offer a read-only `list_repos` tool returning the same repositories, upstreams, aliases and local paths as `repos`, and SHALL NOT offer tools that record paths or clone.

#### Scenario: List over MCP
- **WHEN** an MCP client calls `list_repos` on a workspace with a located repository
- **THEN** it receives that repository with its local path, and no locate or clone tool is listed
