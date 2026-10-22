# repository-registry Specification

## Purpose
Let agents route a request that names one of the user's repositories straight to its local checkout, using the workspace's Repository concepts as a shared registry and each machine's own record of where those repositories are checked out.

## Requirements

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

### Requirement: Add a repository to a hub
`repos add <hub> [<upstream>]` SHALL write a `type: Repository` concept into the named hub, personal or shared, with the upstream's clean form as `resource`, the given title, aliases and description, `status: draft` and a `generated` actor and time, and SHALL list it in the hub's index. With `--path` it SHALL take the upstream from that checkout's remote when none is given and record the checkout.

#### Scenario: Add by upstream
- **WHEN** a caller adds `https://github.com/me/room` to a hub with a title and two aliases
- **THEN** the hub gains a draft Repository concept with those fields, the hub's index links it, `validate` passes, and `repos` lists it as missing

#### Scenario: Add from a checkout
- **WHEN** a caller adds a repository to a team hub with `--path` pointing at a checkout whose `origin` is the upstream, giving no upstream
- **THEN** the concept's `resource` is that remote's clean form, the checkout is recorded for this machine only, and an installed routing skill names the repository

#### Scenario: Already registered
- **WHEN** a caller adds an upstream that a hub already registers, or an alias another repository uses
- **THEN** the command fails naming the existing repository or alias and writes nothing

### Requirement: Adding over MCP
The MCP server SHALL offer `add_repo` only when started with `--allow-write`, adding a repository by upstream to a hub as `repos add` does but never recording a local path.

#### Scenario: Agent registers a repository
- **WHEN** an MCP client of a server started with `--allow-write` calls `add_repo` with a hub, upstream and aliases
- **THEN** the concept is written with the client as its `generated` actor, and a server without `--allow-write` does not list the tool

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
`repos scan <directory> [--depth <n>]` SHALL examine `<directory>` and its subdirectories to `<n>` levels (default 1, at most 6), never entering hidden directories, `node_modules`, a checkout found below `<directory>`, or `<directory>` itself when it is a registered repository's checkout. It SHALL record every checkout whose remote matches a registered upstream with no recorded path, report what it recorded and what remains missing, and never overwrite a recorded path that still exists.

#### Scenario: Scan finds checkouts
- **WHEN** a directory holds a matching checkout one level down, an unrelated repository, and a matching checkout three levels down
- **THEN** only the first is recorded, and the repository whose checkout is deeper is reported missing

#### Scenario: Deeper scan
- **WHEN** the same directory is scanned with `--depth 3`, and another registered repository's checkout sits inside the first checkout and inside a hidden directory
- **THEN** the checkout three levels down is recorded too, the nested and hidden ones are not, and `--depth 7` fails with `INVALID_INPUT` before scanning

#### Scenario: Scan from inside a checkout
- **WHEN** the scanned directory is a registered repository's checkout holding another registered repository's checkouts, and it is scanned with `--depth 3` before and after it is recorded
- **THEN** the first scan records only the scanned checkout, neither records a checkout inside it, and the other repository is reported missing

#### Scenario: Home directory kept in git
- **WHEN** the home directory is itself a checkout of no registered repository, a registered checkout sits two levels below it with another inside that, and a caller runs `repos setup --depth 3`
- **THEN** the checkout below home is recorded and the one inside it is not

### Requirement: Generated routing skill
The workspace SHALL provide a generated skill named `my-repos` whose description names registered repositories by their effective trigger names within the routing skill's keyword budget, so agents select it when a request mentions one, and whose `metadata` lists each repository's id, upstream, aliases and local path or `missing`.

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

### Requirement: Read a repository's instructions before changing it
The routing skill's body SHALL tell agents, before changing a repository, to read that checkout's `AGENTS.md` or `CLAUDE.md` and the repository's concept, and to follow the workflow they describe, because a session started outside the checkout does not load them. It SHALL give the exact concept read command for each repository.

#### Scenario: Workflow guidance before changes
- **WHEN** the skill is rendered for two registered repositories
- **THEN** its body tells agents to read the checkout's `AGENTS.md` or `CLAUDE.md` before changing it and gives the exact concept read command for each repository

### Requirement: Credential-free resources
A Repository's clean upstream SHALL be its `resource` without userinfo, query or fragment, keeping scheme, host, port and path; an SSH upstream keeps only a well-known login without a password (`git`, or a short lowercase name with few digits), and an scp-like one stays scp-like. `validate` SHALL report a Repository whose `resource` is not clean, naming the concept and its clean form, never echoing the resource.

#### Scenario: Resource carrying credentials
- **WHEN** Repository concepts have resources with a password, a token as the user, an `access_token` query or a fragment
- **THEN** `validate` fails naming each concept, and no secret appears in its output

#### Scenario: SSH login name kept
- **WHEN** a Repository concept's `resource` is `git@github.com:acme/billing.git`
- **THEN** `validate` passes and `repos` shows that resource unchanged

#### Scenario: Token-like SSH login dropped
- **WHEN** a caller adds `abcdefghijKLMNOPQRST@gitlab.com:me/garden.git`, an ssh:// URL with that login, and scp-like upstreams with logins `faye` and `git`
- **THEN** the first two are stored without the login and reported as `removed`, the others are stored unchanged, and the token is in no hub file or output

#### Scenario: scp-like path kept
- **WHEN** an scp-like upstream whose login was dropped, and one that kept `faye@`, are cloned
- **THEN** git asks ssh for the same relative path on the same host as the original, as `host` and `faye@host`

#### Scenario: Plain username suggests the clean form
- **WHEN** a Repository's `resource` is `https://faye@bitbucket.org/faye-team/bucket.git`
- **THEN** `validate` fails naming the concept and saying to use `https://bitbucket.org/faye-team/bucket.git`

### Requirement: Adding never writes credentials
`repos add` and `add_repo` SHALL store only the upstream's clean form, whether given or taken from a checkout's remote, in the concept, the hub's index and every generated file, and when anything was removed SHALL say so in the result without echoing it. Their errors SHALL name an upstream only by its clean form or identity.

#### Scenario: Checkout remote with a token
- **WHEN** a caller adds a repository with `--path` to a checkout whose `origin` is `https://faye:<token>@github.com/acme/billing.git?access_token=<token>`
- **THEN** the concept's `resource` is `https://github.com/acme/billing.git`, the result says credentials were removed, and no form of the token is in the hub, its index, the workspace state, stdout or stderr

#### Scenario: Agent adds an upstream with a token
- **WHEN** an MCP client calls `add_repo` with an upstream holding a token as its user and in its query
- **THEN** the concept stores the clean form, and neither the hub nor the tool result holds the token

#### Scenario: Refusals never echo the upstream
- **WHEN** a caller adds an upstream with a token that a hub already registers, or one that is not a git upstream
- **THEN** the command fails naming the existing repository by the clean form, or saying it is not an upstream, without the token

### Requirement: Resources are shown clean
`repos`, `list_repos` and the generated routing skill SHALL show each Repository's clean upstream, never its `resource` as written. Free text redacted before output SHALL be redacted in time linear in its length.

#### Scenario: Hand-written resource with a token
- **WHEN** a Repository concept's `resource` holds a token in its userinfo and query, and a caller runs `repos`, calls `list_repos` and syncs the routing skill
- **THEN** each shows the clean upstream, and no form of the token is in their output or the generated skill

#### Scenario: Long input redacted quickly
- **WHEN** a `repos setup --ask` answer is a path of 200,000 characters with no URL in it
- **THEN** setup reports it as not a checkout within a few seconds

### Requirement: Repository keywords and name bounds
A Repository concept MAY list `keywords`: topic phrases that are not names, such as "personal site". `validate` SHALL report `keywords` that is not a list of strings, a title over 80 characters (code points), an alias or keyword over 60, and a keyword equal to another repository's title or alias when both are in workspace hubs (with a mount, `hub-federation`'s warn-and-drop policy applies). `repos add` SHALL refuse names over these bounds before writing.

#### Scenario: Keywords reach the description
- **WHEN** a Repository concept lists keywords `personal site` and `portfolio`, and a caller runs `agents install` and later adds a keyword and runs `repos sync`
- **THEN** the installed skill's description contains both keywords after install and the new one after sync, and `validate` passes

#### Scenario: Invalid keywords and long names
- **WHEN** one Repository concept has `keywords: portfolio` (not a list), another `keywords: null`, another an 81-character title, and another a keyword equal to another repository's alias, all in workspace hubs
- **THEN** `validate` fails naming each concept and field

#### Scenario: Add refuses long names
- **WHEN** `repos add` is given an 81-character title, a 61-character alias, or an upstream whose name is 81 characters and no title
- **THEN** it fails with `INVALID_INPUT` and writes no concept

### Requirement: Routing skill renders effective trigger names
The routing skill SHALL build its description only from each repository's effective trigger names as the registry defines them (until a registry requirement narrows them, every valid title, alias and keyword), never from raw concept fields. A repository with no effective title (none, blank or too long) SHALL be named by its first effective alias, else by its id; an id over 80 characters fails `validate`, `repos sync` and `agents install`.

#### Scenario: All names are effective by default
- **WHEN** a workspace's repositories have titles, aliases and keywords within the bounds and the skill is rendered
- **THEN** the description draws on all of them

#### Scenario: Title not usable
- **WHEN** one repository's title is over 80 characters and it has an alias, and another's is over 80 with no alias, and the skill is rendered
- **THEN** the first is named by its alias, the second by its id, and neither long title appears in the description

#### Scenario: Blank title
- **WHEN** one repository's title is blank and it has an alias, and another's is blank with no alias, and the skill is rendered
- **THEN** the first is named by its alias and the second by its id

#### Scenario: No title
- **WHEN** one repository has no title and has aliases, and another has neither, and the skill is rendered
- **THEN** the first is named by its first alias and the second by its id, the upstream's name is not used for either, and `validate` passes

#### Scenario: Id too long to name
- **WHEN** a repository has no usable title or alias and its id is over 80 characters
- **THEN** `validate` and `repos sync` fail naming it and asking for a shorter title or an alias

#### Scenario: Invalid keyword never rendered
- **WHEN** a workspace repository lists a 61-character keyword and a keyword equal to another workspace repository's alias, and a caller runs `repos sync`
- **THEN** `validate` fails naming both, neither keyword appears in the description, and neither is reported as skipped by the budget

### Requirement: Routing skill keyword budget
Each routing skill description SHALL be at most 1,024 characters (Unicode code points) including its fixed text and separators. It SHALL name each repository's primary name first, then fill rounds in order (every first alias, every second, and so on, then keywords the same way), skipping a name that does not fit. `repos sync` and `agents install` SHALL report every skipped name with its repository.

#### Scenario: Aliases beyond the budget
- **WHEN** a workspace registers twelve repositories with six long aliases and two keywords each, and a caller runs `repos sync`
- **THEN** each description is at most 1,024 characters, names every repository and its first alias, the result lists each skipped alias and keyword under its repository id, and the body still lists every alias

#### Scenario: Exact boundary
- **WHEN** names are chosen so the full description is exactly 1,024 characters, then one keyword grows by one character
- **THEN** the first render includes every name with nothing skipped, and the second skips exactly that keyword

#### Scenario: Characters, not bytes
- **WHEN** names contain accented letters and emoji, and the full description is exactly 1,024 code points but more bytes
- **THEN** nothing is skipped and the description is 1,024 code points

#### Scenario: Everything fits
- **WHEN** a workspace registers two repositories with short aliases and a caller runs `repos sync`
- **THEN** the description names every title and alias and the result reports no skipped names

### Requirement: Routing skill shards
Repositories SHALL be split in id order into the fewest contiguous shards (`my-repos`, `my-repos-2`, ...) whose minimal entries (primary name and first effective alias) fit one description each, balanced so the largest shard's minimal entries are as short as possible; each shard is then filled under the keyword budget and its body lists only its repositories. Installs and syncs SHALL add and remove shards like other generated skills.

#### Scenario: Too many repositories for one
- **WHEN** a workspace registers enough repositories that their minimal entries exceed one description, and a caller installs agents
- **THEN** each agent's skills include `my-repos` and `my-repos-2`, every repository is named by exactly one of them in id order, and each description is at most 1,024 characters

#### Scenario: Balanced shards
- **WHEN** twenty repositories, each with a long first alias, a short second alias and a keyword, need two shards
- **THEN** each shard names ten repositories and nothing is skipped

#### Scenario: Longest allowed names
- **WHEN** a repository has an 80-character title and twenty 60-character aliases
- **THEN** its minimal entry fits a description on its own, and its other aliases are reported skipped

#### Scenario: Shards shrink back
- **WHEN** repositories are then removed until every minimal entry fits one description and a caller runs `repos sync`
- **THEN** the installed `my-repos-2` is removed and `my-repos` names every repository

### Requirement: Standard frontmatter for generated skills
Generated skills SHALL use only the Agent Skills frontmatter keys `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`, with a `name` that matches the skill's directory and `metadata` that maps strings to strings.

#### Scenario: Standard keys only
- **WHEN** the routing skill is rendered for repositories with and without local checkouts
- **THEN** its frontmatter has only standard keys, its name is its directory's name and at most 64 lowercase characters, and every metadata value is a string

### Requirement: Routing without a workspace path
The routing skill's body SHALL tell agents to resolve a repository through one workspace operation, named as a tool of the workspace's MCP server and as a launcher command. Every command it gives (clone, locate, concept reads, recovery) SHALL run through the launcher, or the core by absolute path with `--root` while this workspace's launcher is not in place, never a `cd` into the workspace. It SHALL name the core's resolve-and-load operation when one exists, else `list_repos` (`repos`).

#### Scenario: Body names the server and the launcher
- **WHEN** the routing skill is rendered for a workspace whose MCP server is registered as `context-home`
- **THEN** its body names the `context-home` server's resolve tool and the launcher's command for it, and contains no `cd` into the workspace

#### Scenario: Remedies use the launcher
- **WHEN** the skill is rendered for a repository with no recorded path
- **THEN** its `repos clone`, `repos locate` and concept read commands run through the launcher and contain no `cd`

#### Scenario: Launcher unavailable
- **WHEN** the skill is rendered before any install, and again after the installed launcher is replaced by another file and a caller runs `repos sync`
- **THEN** both times its commands run the core by absolute path with `--root` and the workspace, contain no `cd`, and the resolve command lists the repositories from another directory

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
When `repos scan` or `repos setup` finds a linked git worktree of a registered repository, it SHALL record the main worktree git reports for it when that is an existing, non-bare directory, and otherwise record nothing for it and say why; it SHALL never record the linked worktree itself.

#### Scenario: Scan finds a worktree
- **WHEN** the only checkout of a registered repository under the scanned directory is a linked worktree whose main checkout is elsewhere
- **THEN** the main checkout's path is recorded, not the worktree's

#### Scenario: Worktree of a bare or missing main
- **WHEN** the only checkout found is a worktree of a bare repository, or of a main checkout that has been deleted
- **THEN** nothing is recorded, and the result names the worktree and the reason
