# Spec Delta

## Purpose

Let any workspace mount a hub that lives in another git repository, pinned to a commit and read-only, so the same shared hub (one person's, used from several workspaces and machines, or one many people use) sits next to the workspace's own hubs under a namespace, with OKF trust and the bundle's provenance on every result.

## ADDED Requirements

### Requirement: Mount declaration
A workspace MAY declare `mounts` in `context-kit.json`, mapping each mount name (lowercase hyphenated, at most 64 characters) to a git `source`, an optional `path` to the hub inside it, an optional `ref` and a pinned 40-hex `commit`. Validation SHALL reject any other shape with `INVALID_CONFIG`, and a name equal to a workspace hub ID with `MOUNT_EXISTS`.

#### Scenario: Invalid mount declaration
- **WHEN** `context-kit.json` declares a mount whose name has an uppercase letter, one whose `commit` is a branch name, one with an unknown key, and, separately, a mount named like a workspace hub
- **THEN** `validate` fails with `INVALID_CONFIG` naming each of the first three, and with `MOUNT_EXISTS` naming the last

### Requirement: Add a mount
`mounts add <name> <source> [--ref <ref>] [--path <dir>]` SHALL resolve the ref (default: the source's default branch) to a commit, fetch it, check that `path` holds a hub manifest and a loadable OKF bundle, then record the mount with that commit. It SHALL refuse a taken name with `MOUNT_EXISTS`, a `path` leaving the repository with `INVALID_PATH` and a non-hub with `NOT_A_HUB`, recording nothing.

#### Scenario: Mount a hub from another repository
- **WHEN** a caller runs `mounts add shared <file:// repository> --path hubs/data` on a repository whose `hubs/data` is a hub
- **THEN** `context-kit.json` records the source, path, ref and the branch's current commit, `mounts` lists `shared` as fetched at that commit, and no file under `hubs/` changed

#### Scenario: Source is not a hub
- **WHEN** a caller adds a mount whose `path` has no `hub.json`, one whose `path` is `../outside`, and one whose name is already taken
- **THEN** the commands fail with `NOT_A_HUB`, `INVALID_PATH` and `MOUNT_EXISTS` respectively, and `context-kit.json` is unchanged

### Requirement: Fetch pinned content
`mounts fetch [<name>]` SHALL make each named mount's pinned commit available in the workspace's untracked state, outside every hub directory, without changing any pin. A fetch that fails SHALL report `FETCH_FAILED` for that mount and still fetch the others.

#### Scenario: Fresh machine fetches its mounts
- **WHEN** a workspace copy whose `context-kit.json` declares two mounts but has no local state runs `mounts fetch`
- **THEN** both are listed as fetched at their pinned commits, and `context-kit.json` is unchanged

#### Scenario: One source unreachable
- **WHEN** a caller fetches two mounts and one source no longer exists
- **THEN** the result reports `FETCH_FAILED` for that mount, the other is fetched, and the command exits nonzero

### Requirement: Pinned until upgraded
Reads SHALL use only a mount's pinned commit. `mounts upgrade <name> [--to <rev>]` SHALL resolve the mount's ref, or `rev`, to a commit, fetch it, move the pin and report the old and new commits with the concepts and repositories added, removed and changed. With `--check` it SHALL report the same without moving the pin or changing what reads return.

#### Scenario: Upstream moves on
- **WHEN** a mounted source gains a commit that adds a concept, and a caller reads the mount, runs `mounts upgrade shared --check`, then `mounts upgrade shared`
- **THEN** the first read and the check leave the pin and results unchanged while the check names the added concept, and after the upgrade the pin is the new commit and the concept is readable

### Requirement: Remove a mount
`mounts remove <name>` SHALL delete the mount's declaration and its fetched content, and SHALL fail with `UNKNOWN_MOUNT` for a name that is not declared.

#### Scenario: Remove a mount
- **WHEN** a caller removes a fetched mount, then removes it again
- **THEN** the first succeeds, `mounts` and `list` no longer show it, and the second fails with `UNKNOWN_MOUNT`

### Requirement: List mounts
`mounts` and the read-only MCP tool `list_mounts` SHALL report each declared mount's name, source, path, ref, pinned commit, status (`fetched`, `unfetched` or `broken` with a reason), its hub manifest's `id`, and its concept count per OKF trust tier. Commands that fetch, upgrade, add or remove mounts SHALL be CLI-only.

#### Scenario: List over CLI and MCP
- **WHEN** a workspace has one fetched and one unfetched mount, and a caller runs `mounts` and calls `list_mounts`
- **THEN** both report the same mounts, statuses and trust counts, and no MCP tool adds, fetches, upgrades or removes mounts, even with `--allow-write`

### Requirement: Read mounted hubs
A fetched mount SHALL be a hub addressed by its mount name in `list`, `context`, `browse`, `read` and `search` and their MCP tools. Each mounted hub and concept result SHALL carry `mount` with its name, source, path and commit, alongside the unchanged OKF summary and freshness under the mount's own policy.

#### Scenario: Read a mounted concept
- **WHEN** a workspace mounts `shared`, and a caller lists hubs, browses `shared`, reads `tables/orders` from it and searches for its text, over the CLI and over MCP
- **THEN** each result names hub `shared` with its `mount` provenance and the concept's OKF trust tier, and CLI and MCP results are equivalent

### Requirement: Qualified concept references
Every concept in a result SHALL carry `ref`, `<hub-id>:/<concept-id>`. `read` and `read_concept` SHALL accept a reference in place of the hub and concept, and SHALL fail with `INVALID_INPUT` when given a hub that differs from the reference's.

#### Scenario: Read by reference
- **WHEN** a caller searches, takes a mounted result's `ref` such as `shared:/tables/orders`, and reads it with `read shared:/tables/orders` and with `read_concept` given only that reference
- **THEN** both return that concept, and `read_concept` with hub `personal/main` and that reference fails with `INVALID_INPUT`

### Requirement: Bundles side by side
Mounted bundles SHALL never be merged with each other or with workspace hubs: each keeps its own root `index.md`, `okf_version`, `log.md`, curated documents and concept IDs.

#### Scenario: Same paths in two bundles
- **WHEN** a workspace hub and a mount both have a root `index.md` with different `okf_version` declarations, a `log.md` and a `README` concept
- **THEN** browsing each root returns its own index, `context` for each reports its own OKF version, and reading `README` in each returns its own text

### Requirement: Mounted hub manifests
A mounted hub's manifest SHALL be read like a workspace hub's, except that its `id` is reported only as the mount's manifest ID, and its `links` to hubs not present, its `skills` and its `specStores` SHALL produce warnings rather than failures and SHALL NOT be offered.

#### Scenario: Manifest fields that point elsewhere
- **WHEN** a mounted hub's manifest links a hub the workspace lacks and declares a skill and a spec store
- **THEN** `context shared` succeeds with warnings naming the link, skill and store, and `skills`, `read-skill shared ...` and `specs stores` do not offer them

### Requirement: Mounts are read-only
Operations that write to a hub SHALL refuse a mount with `READ_ONLY_MOUNT` before writing anything.

#### Scenario: Writes against a mount
- **WHEN** a caller with writes enabled runs `capture shared`, `repos add shared <upstream>`, and calls `capture_note` and `add_repo` with hub `shared`
- **THEN** each fails with `READ_ONLY_MOUNT` and the mount's fetched files are unchanged

### Requirement: Unavailable mounts degrade
A declared mount that is not fetched, or whose content is not a loadable hub, SHALL NOT fail operations on other hubs. Addressing it SHALL fail with `MOUNT_NOT_FETCHED` or `MOUNT_BROKEN` naming the remedy, and `list`, `search`, `validate` and `repos` SHALL warn about it. Problems in mounted content SHALL never fail `validate`.

#### Scenario: Mount not fetched yet
- **WHEN** a workspace declares a mount it has not fetched, and a caller lists hubs, searches, reads from the mount and validates
- **THEN** list and search return the workspace hubs with a warning naming `mounts fetch shared`, the read fails with `MOUNT_NOT_FETCHED`, and `validate` passes with that warning

#### Scenario: Broken mount
- **WHEN** a mount's pinned content has a curated document without frontmatter
- **THEN** `context shared` fails with `MOUNT_BROKEN` naming the file, and the workspace's own hubs still list, read and validate
