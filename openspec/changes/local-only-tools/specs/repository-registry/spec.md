# Spec Delta

## ADDED Requirements

### Requirement: Which repository is this
`repos which [<path>]` SHALL report the repository (default: the current directory) that the innermost git checkout containing the path belongs to, by its remotes: id, title, hub, concept, checkout top, path inside it, and `recorded`, `worktree` or `unrecorded`. It SHALL never fall back to an enclosing checkout. A path in a hub SHALL report the hub; any other path SHALL report none.

#### Scenario: Nested subdirectory
- **WHEN** a caller runs `repos which` from a subdirectory three levels inside a recorded checkout
- **THEN** it reports that repository's id, hub and concept, the checkout's top, the relative path, and `recorded`

#### Scenario: Linked worktree
- **WHEN** a caller runs `repos which <path>` on a linked worktree of a recorded checkout, given through a symlinked path
- **THEN** it reports the repository and `worktree`, with the real paths of the worktree and the main checkout

#### Scenario: Unrecorded checkout
- **WHEN** a caller runs `repos which` in a second clone of a registered repository that is not the recorded path
- **THEN** it reports the repository, `unrecorded` and the recorded path, and records nothing

#### Scenario: Innermost checkout decides
- **WHEN** a recorded checkout contains a submodule that is another registered repository, and an unrelated inner git repository, and a caller runs `repos which` inside each
- **THEN** the first reports the submodule's repository, and the second reports no repository, not the enclosing one

#### Scenario: Several registered remotes
- **WHEN** a checkout has two remotes that are two registered repositories, first with `origin` among them and then with neither named `origin`
- **THEN** the first reports the repository `origin` points to, and the second reports `ambiguous` with both candidates in id order

#### Scenario: Not a repository of the user's
- **WHEN** a caller runs `repos which` in a directory outside any checkout, in an unrelated checkout, and in a hub directory of the workspace
- **THEN** the first two report no repository with exit status 0, and the third reports that hub's id

### Requirement: Which repository over MCP
The MCP server SHALL offer a read-only `which_repo` tool over stdio that returns what `repos which` returns for a given absolute path.

#### Scenario: Agent asks where it is
- **WHEN** a stdio MCP client calls `which_repo` with a path inside a recorded checkout
- **THEN** it receives the same repository as `repos which` for that path
