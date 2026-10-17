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

### Requirement: Generated skills stay current
`agents status` SHALL report an installed generated skill as `stale` when rendering it now would differ from what was installed, such as after hub edits or a pull that change repositories, and `agents install` SHALL update it. `repos locate`, `repos clone` and `repos scan` SHALL update an installed, unchanged routing skill in every place it is installed, and SHALL leave one edited since install alone and say so.

#### Scenario: Pulled hub changes
- **WHEN** the routing skill is installed and a new Repository concept is then added to a hub
- **THEN** status reports the skill stale, and after `agents install` its description names the new repository

#### Scenario: Locating refreshes the skill
- **WHEN** the routing skill is installed and a caller locates a missing repository
- **THEN** the installed skill's metadata gives the new local path without running `agents install`
