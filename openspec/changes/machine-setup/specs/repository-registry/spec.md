# Spec Delta

## MODIFIED Requirements

### Requirement: Generated routing skill
The workspace SHALL provide a generated skill named `my-repos` whose description names registered repositories by their effective trigger names within the routing skill's keyword budget, so agents select it when a request mentions one, and whose `metadata` lists each repository's id, upstream, aliases and local path or `missing`.

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

### Requirement: Repository keywords and name bounds
A Repository concept MAY list `keywords`: topic phrases that are not names, such as "personal site". `validate` SHALL report `keywords` that is not a list of strings, a title over 80 characters (code points), an alias or keyword over 60, and a keyword equal to another repository's title or alias when both are in workspace hubs; when a mount is involved, `hub-federation`'s warn-and-drop policy applies instead.

#### Scenario: Keywords reach the description
- **WHEN** a Repository concept lists keywords `personal site` and `portfolio`, and a caller runs `agents install` and later adds a keyword and runs `repos sync`
- **THEN** the installed skill's description contains both keywords after install and the new one after sync, and `validate` passes

#### Scenario: Invalid keywords and long names
- **WHEN** one Repository concept has `keywords: portfolio` (not a list), another an 81-character title, and a third a keyword equal to another repository's alias, all in workspace hubs
- **THEN** `validate` fails naming each concept and field

### Requirement: Routing skill renders effective trigger names
The routing skill SHALL build its description only from each repository's effective trigger names as the registry defines them (until a registry requirement narrows them, every valid title, alias and keyword), never from raw concept fields, so a name the registry filters out never reaches the budget. A repository with no effective title SHALL be named by its first effective alias, or else by its id.

#### Scenario: All names are effective by default
- **WHEN** a workspace's repositories have titles, aliases and keywords within the bounds and the skill is rendered
- **THEN** the description draws on all of them

#### Scenario: Title not usable
- **WHEN** one repository's title is over 80 characters and it has an alias, and another's is over 80 with no alias, and the skill is rendered
- **THEN** the first is named by its alias, the second by its id, and neither long title appears in the description

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
Repositories SHALL be assigned in id order to `my-repos` while each one's minimal entry (primary name and first effective alias) still fits that description, then to `my-repos-2`, and so on; each shard is then filled under the keyword budget and its body lists only its repositories. Installs and syncs SHALL add and remove shards like other generated skills.

#### Scenario: Too many repositories for one
- **WHEN** a workspace registers enough repositories that their minimal entries exceed one description, and a caller installs agents
- **THEN** each agent's skills include `my-repos` and `my-repos-2`, every repository is named by exactly one of them in id order, and each description is at most 1,024 characters

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
The routing skill's body SHALL tell agents to resolve a repository through one workspace operation, named both as a tool of the workspace's MCP server and as a launcher command. Every command it gives, including clone, locate, concept reads and recovery, SHALL run through the launcher, never a `cd` into the workspace. It SHALL name the core's resolve-and-load operation when one exists, else `list_repos` (`repos`).

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
When `repos scan` or `repos setup` finds a linked git worktree of a registered repository, it SHALL record the main worktree git reports for it when that is an existing, non-bare directory, and otherwise record nothing for it and say why; it SHALL never record the linked worktree itself.

#### Scenario: Scan finds a worktree
- **WHEN** the only checkout of a registered repository under the scanned directory is a linked worktree whose main checkout is elsewhere
- **THEN** the main checkout's path is recorded, not the worktree's

#### Scenario: Worktree of a bare or missing main
- **WHEN** the only checkout found is a worktree of a bare repository, or of a main checkout that has been deleted
- **THEN** nothing is recorded, and the result names the worktree and the reason
