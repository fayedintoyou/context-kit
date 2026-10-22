# Spec Delta

## MODIFIED Requirements

### Requirement: Generated routing skill
The workspace SHALL provide a generated skill named `my-repos` whose description names registered repositories by title and aliases within the routing skill's keyword budget, so agents select it when a request mentions one, and whose `metadata` lists each repository's id, upstream, aliases and local path or `missing`.

#### Scenario: Skill names every repository
- **WHEN** a workspace registers a repository with aliases and its checkout is located, and the skill is rendered
- **THEN** its description contains the title and each alias, its metadata gives the upstream and the local path, and it passes the bundled-skill frontmatter rules for both agents

### Requirement: Scan a directory once
`repos scan <directory> [--depth <n>]` SHALL examine `<directory>` and its subdirectories down to `<n>` levels (default 1, at most 6), never entering hidden directories, `node_modules` or a checkout it found, record every git checkout whose remote matches a registered upstream that has no recorded path, report what it recorded and what remains missing, and never overwrite a recorded path that still exists.

#### Scenario: Scan finds checkouts
- **WHEN** a directory holds a matching checkout one level down, an unrelated repository, and a matching checkout three levels down
- **THEN** only the first is recorded, and the repository whose checkout is deeper is reported missing

#### Scenario: Deeper scan
- **WHEN** the same directory is scanned with `--depth 3`, and another registered repository's checkout sits inside the first checkout and inside a hidden directory
- **THEN** the checkout three levels down is recorded too, the nested and hidden ones are not, and `--depth 7` fails with `INVALID_INPUT` before scanning

## ADDED Requirements

### Requirement: Routing skill keyword budget
The routing skill's description SHALL stay within 1,024 characters by naming every repository's title first, then each repository's aliases one round at a time (every first alias, then every second) in concept order, skipping a keyword that does not fit. `repos sync` and `agents install` SHALL report every skipped alias with its repository.

#### Scenario: Aliases beyond the budget
- **WHEN** a workspace registers twelve repositories with six long aliases each, and a caller runs `repos sync`
- **THEN** the description is at most 1,024 characters, names every title and every repository's first alias, the result lists each skipped alias under its repository id, and the skill's body still lists every alias

#### Scenario: Everything fits
- **WHEN** a workspace registers two repositories with short aliases and a caller runs `repos sync`
- **THEN** the description names every title and alias and the result reports no skipped aliases

### Requirement: Routing skill shards
When the repositories' titles alone do not fit one description, the workspace SHALL generate numbered routing skills (`my-repos`, `my-repos-2`, and so on), each covering a run of repositories in id order whose titles fit, its body listing only those repositories. Installs and syncs SHALL add and remove shards like other generated skills.

#### Scenario: Too many titles
- **WHEN** a workspace registers enough repositories with long titles that their titles exceed 1,024 characters, and a caller installs agents
- **THEN** each agent's skills include `my-repos` and `my-repos-2`, every repository is named by exactly one of them, and each description is at most 1,024 characters

#### Scenario: Shards shrink back
- **WHEN** repositories are then removed until every title fits one description and a caller runs `repos sync`
- **THEN** the installed `my-repos-2` is removed and `my-repos` names every repository

### Requirement: Standard frontmatter for generated skills
Generated skills SHALL use only the Agent Skills frontmatter keys `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`, with a `name` that matches the skill's directory and `metadata` that maps strings to strings.

#### Scenario: Standard keys only
- **WHEN** the routing skill is rendered for repositories with and without local checkouts
- **THEN** its frontmatter has only standard keys, its name is its directory's name and at most 64 lowercase characters, and every metadata value is a string

### Requirement: Routing without a workspace path
The routing skill's body SHALL tell agents to resolve a repository through one workspace operation, named both as a tool of the workspace's MCP server and as a command of the installed launcher, and SHALL NOT tell them to change into the workspace directory. It SHALL name the workspace's resolve-and-load operation when the core offers one, and `list_repos` (`repos`) otherwise.

#### Scenario: Body names the server and the launcher
- **WHEN** the routing skill is rendered for a workspace whose MCP server is registered as `context-home`
- **THEN** its body names the `context-home` server's resolve tool and the launcher's command for it, and contains no `cd` into the workspace

#### Scenario: Remedies use the launcher
- **WHEN** the skill is rendered for a repository with no recorded path
- **THEN** its `repos clone`, `repos locate` and concept read commands run through the launcher and contain no `cd`

### Requirement: Machine setup
`repos setup` SHALL scan each `--scan` directory (default: the home directory) to `--depth` (default 2), then report every repository still missing with its remedies. It SHALL clone only repositories named with `--clone` or approved at a prompt, prompting only when stdin is a terminal or with `--ask`, and SHALL refresh installed routing skills.

#### Scenario: Fresh machine without prompts
- **WHEN** a workspace registers three repositories, one is checked out two levels below a temporary home, and a caller runs `repos setup` with stdin not a terminal
- **THEN** that checkout is recorded, the other two are reported missing with their `repos locate` and `repos clone` commands, and nothing is cloned

#### Scenario: Approved at a prompt
- **WHEN** a caller runs `repos setup --ask` and answers the prompts on stdin with a path for one missing repository and `clone` for the other
- **THEN** the first is located at that path, the second is cloned into its default location, both are recorded, and the installed routing skill gives both paths

#### Scenario: Named clone
- **WHEN** a caller runs `repos setup --clone room` with stdin not a terminal
- **THEN** only that repository is cloned and recorded, and any other missing repository is reported, not cloned

### Requirement: Worktrees are not recorded checkouts
When `repos scan` or `repos setup` finds a linked git worktree of a registered repository, it SHALL record that worktree's main checkout when it exists, and never the linked worktree itself.

#### Scenario: Scan finds a worktree
- **WHEN** the only checkout of a registered repository under the scanned directory is a linked worktree whose main checkout is elsewhere
- **THEN** the main checkout's path is recorded, not the worktree's

### Requirement: Which repository is this
`repos which [<path>]` SHALL report the repository a path (default: the current directory) belongs to, matched by git remotes: its id, title, hub, concept, the checkout's top, the path inside it, and whether the checkout is the recorded one, a linked worktree of it, or an unrecorded checkout. A path in a hub SHALL report the hub; any other SHALL report none.

#### Scenario: Nested subdirectory
- **WHEN** a caller runs `repos which` from a subdirectory three levels inside a recorded checkout
- **THEN** it reports that repository's id, hub and concept, the checkout's top, the relative path, and `recorded`

#### Scenario: Linked worktree
- **WHEN** a caller runs `repos which <path>` on a linked worktree of a recorded checkout
- **THEN** it reports the repository and `worktree`, with the main checkout's path

#### Scenario: Unrecorded checkout
- **WHEN** a caller runs `repos which` in a second clone of a registered repository that is not the recorded path
- **THEN** it reports the repository, `unrecorded` and the recorded path, and records nothing

#### Scenario: Not a repository of the user's
- **WHEN** a caller runs `repos which` in a directory outside any checkout, in an unrelated checkout, and in a hub directory of the workspace
- **THEN** the first two report no repository with exit status 0, and the third reports that hub's id

### Requirement: Which repository over MCP
The MCP server SHALL offer a read-only `which_repo` tool over stdio that returns what `repos which` returns for a given absolute path, and SHALL NOT offer it over HTTP.

#### Scenario: Agent asks where it is
- **WHEN** a stdio MCP client calls `which_repo` with a path inside a recorded checkout, and an HTTP client lists tools on a server for the same workspace
- **THEN** the stdio client receives the same repository as `repos which`, and the HTTP tool list has no `which_repo`

### Requirement: Repository paths over HTTP
Over HTTP, `list_repos` SHALL name the serving machine (`--machine-name`, default its host name) and return each local checkout as `servingMachinePath` instead of `path`, and its description SHALL say that these paths are on the serving machine. Over stdio it SHALL return `path` as before.

#### Scenario: Remote client sees whose paths they are
- **WHEN** an HTTP client of a server started with `--machine-name studio` calls `list_repos` on a workspace with a located repository
- **THEN** the result names machine `studio`, gives that repository's `servingMachinePath` and no `path`, and the tool's description says the paths are on the serving machine

#### Scenario: Local clients unchanged
- **WHEN** a stdio client calls `list_repos` on the same workspace
- **THEN** it receives `path` as before and no machine label
