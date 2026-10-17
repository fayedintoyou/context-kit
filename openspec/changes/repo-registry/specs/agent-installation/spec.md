# Spec Delta

## ADDED Requirements

### Requirement: Generated skills
`agents install` SHALL install the workspace's generated skills (the `my-repos` routing skill) alongside addon skills, always as copies even with `--link`, record them like other skills, and remove an unchanged installed generated skill when the workspace no longer generates it.

#### Scenario: Install the routing skill
- **WHEN** a workspace registers a repository and a caller runs `agents install --link` for both agents
- **THEN** each agent's skill directory has a copied `my-repos` skill, and status reports it installed

#### Scenario: Last repository removed
- **WHEN** the workspace's only Repository concept is deleted and a caller installs again
- **THEN** the installed `my-repos` skill is removed

### Requirement: Regenerate on demand
`repos sync` SHALL rebuild the routing skill from the workspace's Repository concepts (titles, aliases, upstreams) and this machine's checkouts, update every installed unchanged copy without registering MCP servers, report edited copies, and report where the skill is not installed yet.

#### Scenario: Sync after editing repositories
- **WHEN** the routing skill is installed and a caller adds an alias to a Repository concept and runs `repos sync`
- **THEN** the installed skill's description contains the new alias, status reports it installed, and no agent CLI was called

#### Scenario: Sync before any install
- **WHEN** a workspace registers a repository but has never installed agents, and a caller runs `repos sync`
- **THEN** the rendered skill exists in the workspace and the result says to run `agents install`

### Requirement: Sync after pulls
When the workspace is a git checkout, `agents install` SHALL install `post-merge` and `post-rewrite` hooks in that checkout's hooks directory that run `repos sync` and never fail the git command. It SHALL not overwrite a hook it did not install unless forced, `agents status` SHALL report the hooks, and `agents uninstall` SHALL remove them when unchanged.

#### Scenario: A pull rebuilds the skill
- **WHEN** a workspace checkout has the routing skill and sync hooks installed, and a pull brings in a new Repository concept
- **THEN** after the pull the installed skill names the new repository, without running `agents install`

#### Scenario: Existing hooks are kept
- **WHEN** the checkout already has a `post-merge` hook that Context Kit did not install
- **THEN** install leaves it unchanged and reports a conflict naming it, and uninstall removes only the hooks it installed

### Requirement: Generated skills stay current
`agents status` SHALL report an installed generated skill as `stale` when rendering it now would differ from what was installed, such as after hub edits or a pull that change repositories, and `agents install` SHALL update it. `repos locate`, `repos clone` and `repos scan` SHALL update an installed, unchanged routing skill in every place it is installed, and SHALL leave one edited since install alone and say so.

#### Scenario: Pulled hub changes
- **WHEN** the routing skill is installed and a new Repository concept is then added to a hub
- **THEN** status reports the skill stale, and after `agents install` its description names the new repository

#### Scenario: Locating refreshes the skill
- **WHEN** the routing skill is installed and a caller locates a missing repository
- **THEN** the installed skill's metadata gives the new local path without running `agents install`
