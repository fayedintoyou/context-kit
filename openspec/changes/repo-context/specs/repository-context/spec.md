# Spec Delta

## Purpose

Let an agent open one of the user's repositories by name in a single deterministic call: the shared CLI resolves it to this machine's checkout and hands over its instruction files, hub context pointers and a bounded default pack, so the agent never scouts. Declared, budgeted packs with roles extend that.

## ADDED Requirements

### Requirement: Open a repository
`repos open <repo>` and the read-only MCP tool `open_repo` SHALL take a repository id, title, alias or upstream name as an explicit argument and, in one call, return the resolution, the checkout's instruction files, the declared verification commands, the repository's concept and declared pointers, and its default pack. Both SHALL return equal results.

#### Scenario: Open by alias
- **WHEN** `https://github.com/example/orchard` is registered with alias `orchard`, its checkout has `AGENTS.md` and is recorded on this machine, and a caller runs `repos open orchard` and calls `open_repo` with `orchard`
- **THEN** both return the same result with the checkout path, the `AGENTS.md` pointer, the repository concept and the default pack

### Requirement: Layered resolution
Resolution SHALL be deterministic and done by the CLI: the name is matched against the shared registry (Repository concepts), then the upstream against this machine's recorded checkouts. The result SHALL say how it resolved: the matched name and kind, the registering concept, and that the path came from this machine's record. It SHALL never search the filesystem.

#### Scenario: How it resolved
- **WHEN** a caller opens a located repository by its title, and then by its id
- **THEN** each result names the field matched (`title` or `id`), the concept `team/fruit/orchard`, the upstream and the recorded path with source `machine`

#### Scenario: Ambiguous or unknown name
- **WHEN** a caller opens a name two repositories share as upstream name, and then a name no repository has
- **THEN** the first fails with `AMBIGUOUS_REPOSITORY` naming both ids and the second with `UNKNOWN_REPOSITORY`

### Requirement: Unmapped repository
When the repository has no recorded checkout on this machine, opening it SHALL succeed with status `missing`, the concept and declared pointers, no instruction files or pack, and `next` giving the exact `repos locate` and `repos clone` commands. It SHALL never clone, record or search for it.

#### Scenario: Not checked out here
- **WHEN** a caller opens a registered repository whose checkout is not recorded on this machine
- **THEN** the result has status `missing`, the repository concept, `next` with both exact commands, and no pack, and the workspace's recorded checkouts are unchanged

### Requirement: Instruction file pointers
Opening a located repository SHALL return pointers (path, size, SHA-256) to the checkout's `AGENTS.md` and `CLAUDE.md` at its root and, with a subpath, in each directory between the root and the subpath, outermost first, so the agent reads them before changing anything. Absent files SHALL simply be omitted.

#### Scenario: Nested instructions
- **WHEN** a checkout has `AGENTS.md` at its root and `services/billing/CLAUDE.md`, and a caller opens it with subpath `services/billing/invoices`
- **THEN** the result points at `AGENTS.md` then `services/billing/CLAUDE.md`, and opening without a subpath points only at `AGENTS.md`

### Requirement: Default pack
Every located repository SHALL have, with no configuration, a default pack: the instruction file pointers, the repository concept, and a tree of git-tracked paths under the root or subpath, sorted by code point, to depth 2 and at most 150 entries. Deeper or omitted content SHALL be summarized as file counts per directory, with `truncated` reported.

#### Scenario: Zero-configuration pack
- **WHEN** a Repository concept declares no `context`, and its checkout tracks `README.md`, `src/app.js` and `src/lib/deep/x.js` and has an ignored `build/` directory, and a caller opens it
- **THEN** the default pack lists `README.md`, `src/` and `src/app.js`, summarizes `src/lib/` as one file, and never mentions `build/`

#### Scenario: Large tree
- **WHEN** a checkout tracks 400 files in its root directory and a caller opens it
- **THEN** the tree lists the first 150 by code point and reports `truncated` with 250 omitted and the first omitted path

### Requirement: Repository context field
A `type: Repository` concept MAY carry a `context` mapping with only the optional keys `verify`, `concepts`, `skills`, `mcp`, `areas` and `packs`. `validate` SHALL fail on any other key under `context`, naming the concept and key. Concepts of other types and other frontmatter keys SHALL stay as permissive as OKF requires.

#### Scenario: Declared context validates
- **WHEN** a Repository concept for `https://github.com/example/orchard` declares `context` with concepts, skills, MCP names, an area and a pack, all well formed and resolvable
- **THEN** `validate` passes

#### Scenario: Unknown context key
- **WHEN** a Repository concept's `context` has a key `commands`, and a `Guide` concept in the same hub has an unrelated extra key `context: hello`
- **THEN** `validate` fails naming the Repository concept and `context.commands`, and reports nothing about the Guide

### Requirement: Canonical verification commands
`context.verify` MAY list up to 10 single-line commands, each at most 200 characters, that agents are told to run to check work in the repository. Opening the repository SHALL return them in order as declared text. Context Kit SHALL never run them, and `validate` SHALL fail on a value that is not a list of such strings.

#### Scenario: Declared checks are returned, not run
- **WHEN** a Repository declares `verify: ["npm test", "node bin/check.mjs"]` where `bin/check.mjs` writes a marker file, and a caller opens it over the CLI and MCP
- **THEN** both results list the two commands in order, and the marker file does not exist

#### Scenario: Invalid verification commands
- **WHEN** a Repository declares `verify: npm test` as a bare string, and another declares a command containing a newline
- **THEN** `validate` fails naming each concept and `context.verify`

### Requirement: Concept references
A concept reference SHALL be `/<concept-id>` for a concept in the Repository concept's own hub, or `<hub-id>:/<concept-id>` for one in another hub of the workspace. `validate` SHALL fail on a reference that is malformed, names an unknown hub, or names no concept, including inbox notes. Unqualified references SHALL never resolve outside the declaring hub.

#### Scenario: References across hubs
- **WHEN** a Repository in hub `team/fruit` references `/guides/harvest` and `personal/notes:/orchard/ideas`, both existing concepts
- **THEN** `validate` passes and `repos open` reports them with hubs `team/fruit` and `personal/notes`

#### Scenario: Unresolvable references
- **WHEN** a Repository references `/guides/missing`, `nowhere:/guides/harvest`, `guides/harvest` without the slash, and an inbox note's ID
- **THEN** `validate` fails naming each reference and why: no such concept, unknown hub, malformed, inbox note

### Requirement: Skill and MCP references
Skill references SHALL use the forms hub manifests use (`kit:<name>` or a workspace-relative `SKILL.md` path) and SHALL resolve. MCP entries SHALL be server names only: strings of lowercase letters, digits, `-` and `_`, at most 64 characters. `validate` SHALL fail on any other MCP value, such as a mapping, a URL or a command line.

#### Scenario: Names, not configuration
- **WHEN** a Repository declares MCP entries `orchard-tracker`, `https://mcp.example.com`, `npx orchard-mcp --token x` and a mapping with a `command` key, and a skill `kit:no-such-skill`
- **THEN** `validate` passes `orchard-tracker` and fails naming each of the other four values

### Requirement: Area declarations
Each entry of `areas` SHALL have a `path`, a directory relative to the checkout root without leading `/`, `.` or `..` segments, backslashes or glob characters, plus optional `concepts`, `skills` and `mcp` lists validated like the repository's own. `validate` SHALL fail on a malformed path or two areas of one repository with the same path.

#### Scenario: Bad area paths
- **WHEN** a Repository declares areas `services/billing`, `../shared`, `src/**` and `services/billing` again
- **THEN** `validate` fails naming `../shared`, `src/**` and the duplicate `services/billing`, and accepts the first

### Requirement: Pack declarations
Each key of `packs` SHALL be a lowercase hyphenated name other than `default`, mapping to a `description`, `files` globs and optional `exclude` globs, `concepts`, `skills`, `mcp`, `roles` and `limits`. Globs SHALL be relative to the checkout, using only `*`, `**` and `?`. `limits.files` and `limits.bytes` SHALL be positive integers no larger than 500 files and 4 MiB.

#### Scenario: Invalid packs
- **WHEN** a Repository declares a pack without a description, one with a glob `/etc/**`, one with a glob containing `{a,b}`, one with `limits.files: 10000`, one named `Release` and one named `default`
- **THEN** `validate` fails naming each pack and field

### Requirement: Declared pointers when opening
Opening a repository SHALL list its declared pointers after its own concept. Each concept pointer has hub, ID, type, title, description capped at 300 characters, trust and freshness action, but no body. Skill pointers have name, description and reference. MCP names, areas and packs follow, in declaration order.

#### Scenario: Pointers without bodies
- **WHEN** a repository declares two concepts, a skill and an MCP name, and a caller opens it
- **THEN** the result lists the repository concept, then both concepts with their summaries but no body text, the skill with its description, and the MCP name

### Requirement: Areas and packs summarized
Without a subpath, opening SHALL list each area by path with counts of its concepts, skills and MCP names, and each declared pack by name, description and role names, without expanding them, so the result stays a small bootstrap.

#### Scenario: Summarized areas and packs
- **WHEN** a repository declares two areas and a pack with a `reviewer` role, and a caller opens it without a subpath
- **THEN** each area appears with its path and counts but no pointers, and the pack with its description and `reviewer`

### Requirement: Open at a directory
`repos open <repo> <subpath>` (MCP `path`) SHALL add the pointers of every area whose path equals or contains the subpath, outermost first, after the repository's own, with duplicates dropped and the matched areas named. A malformed subpath SHALL fail with `INVALID_PATH`.

#### Scenario: Nested areas
- **WHEN** a repository declares areas `services` and `services/billing`, and a caller opens it at `services/billing/invoices`
- **THEN** the result names both areas as matched and lists the repository's pointers, then those of `services`, then those of `services/billing`, each concept once

#### Scenario: Subpath outside every area
- **WHEN** a caller opens a repository at `docs`, which no area contains, and then at `../outside`
- **THEN** the first returns only the repository's pointers with no matched areas, and the second fails with `INVALID_PATH`

### Requirement: Lenient context reads
Opening SHALL fail with `INVALID_CONTEXT`, naming the problems, only when the repository's `context` is structurally invalid. A reference that no longer resolves SHALL be returned as a pointer marked `missing` with a warning. `repos`, `list_repos` and the routing skill SHALL keep working for every repository whatever its `context`.

#### Scenario: Deleted concept after validation
- **WHEN** a referenced concept is deleted, and another repository has a `context` that is a list rather than a mapping
- **THEN** opening the first repository returns that pointer marked missing with a warning, opening the second fails with `INVALID_CONTEXT`, and `repos` lists both

### Requirement: MCP server availability
Open and pack results SHALL report each declared MCP name as declared. With `--check-mcp` (MCP `checkMcp`) they SHALL also report, per agent, `available`, `missing`, or `unknown` when its CLI is absent or fails, asked through that agent's own CLI from the checkout when located. Context Kit SHALL never register, install or configure a declared server.

#### Scenario: Declared versus registered
- **WHEN** a repository declares `orchard-tracker` and `docs-search`, a fake `claude` CLI has only `orchard-tracker` registered, no `codex` CLI is on the path, and a caller opens the repository with `--check-mcp`
- **THEN** `orchard-tracker` is available and `docs-search` missing for Claude Code, both are unknown for Codex, and the fake CLI received no add or remove call

#### Scenario: No check by default
- **WHEN** a caller opens a repository without `--check-mcp`
- **THEN** the MCP names are reported as declared with no availability, and no agent CLI is called

### Requirement: Build a pack
`repos pack <repo> <pack>` and the read-only MCP tool `context_pack` SHALL return the repository, pack, role, HEAD commit, dirty flag, and the files matching the pack's `files` but no `exclude`, each with path, size and SHA-256 of its working-tree content. They SHALL also return the default pack's instruction and concept pointers, the pack's own pointers and a manifest hash, but no file contents. `default` SHALL return the default pack.

#### Scenario: Pack for a release
- **WHEN** a located checkout tracks `AGENTS.md`, `CHANGELOG.md`, `docs/release/steps.md`, `docs/release/draft.tmp` and `src/app.js`, and the `release` pack includes `CHANGELOG.md` and `docs/release/**` and excludes `**/*.tmp`
- **THEN** the manifest lists exactly `CHANGELOG.md` and `docs/release/steps.md` with their sizes and SHA-256, points at `AGENTS.md` and the repository concept, and gives the HEAD commit

#### Scenario: Same over MCP
- **WHEN** a caller builds the same pack over the CLI and over MCP with the repository and pack given as arguments, and builds `default` both ways
- **THEN** each pair of results is equal, and `default` equals the default pack that `repos open` returns

### Requirement: Packs are deterministic
A pack SHALL depend only on the hubs, the checkout's tracked files and their contents, and the arguments: files sorted by code point, pointers in declaration order, no timestamps or time-dependent trust or freshness fields. The manifest hash SHALL exclude the checkout path and MCP availability, so two machines with the same commit and contents agree.

#### Scenario: Rebuild unchanged
- **WHEN** a caller builds a pack twice without changes, then edits one listed file without committing and builds it again
- **THEN** the first two results are byte-identical, and the third has that file's new hash, a different manifest hash and `dirty: true`

#### Scenario: Same pack on two machines
- **WHEN** the same commit is checked out at two different paths, each recorded in its own copy of the workspace, and a caller builds the same pack in each
- **THEN** both manifest hashes are equal

### Requirement: Packs only read tracked files inside the checkout
Packs, including the default pack's tree, SHALL consider only files git tracks in the checkout. They SHALL skip untracked and ignored files, submodules, symlinks and tracked files missing from the working tree, and report counts of what they skipped. A pack SHALL never read outside the checkout or run anything from it or the hubs.

#### Scenario: Skipped files
- **WHEN** a pack's glob matches a tracked file, an untracked file, a tracked symlink to a file outside the checkout, and a tracked file deleted from the working tree, and the checkout's git config sets `core.fsmonitor` to a command that writes a marker file
- **THEN** only the tracked file is listed, one untracked, one symlink and one missing file are reported skipped, and the marker file does not exist

### Requirement: Pack budgets
A declared pack SHALL list files in order until the next would exceed its file limit or byte budget (`limits`, default 100 files and 512 KiB). `--budget <bytes>` (MCP `budget`) MAY lower the byte budget, never raise it past `limits`. When files are left out, the result SHALL report `truncated` with the limit reached, the count omitted and the first omitted path.

#### Scenario: Truncated by bytes
- **WHEN** a pack matches three 4 KiB files and a caller builds it with `--budget 9000`
- **THEN** the first two files are listed and `truncated` reports the byte budget, one file omitted and the third path

#### Scenario: Budget above the limit
- **WHEN** a caller passes a `--budget` above the pack's `limits.bytes`
- **THEN** the pack's limit applies and the result reports the effective budget

### Requirement: Pack roles
A pack's `roles` SHALL map lowercase hyphenated names to selections that inherit the pack and may add `files`, `concepts`, `skills` and `mcp`, add `exclude` globs, and `omit` inherited concept, skill or MCP references. `--role <role>` (MCP `role`) SHALL apply one. The result SHALL report counts of what the role withheld, never their paths or IDs.

#### Scenario: Reviewer without builder notes
- **WHEN** the `release` pack includes `notes/**` and `/guides/release-builder`, and its `reviewer` role excludes `notes/builder/**` and omits `/guides/release-builder`, and a caller builds it with `--role reviewer`
- **THEN** the manifest names role `reviewer`, lists no file under `notes/builder/` and not that concept, and reports the counts withheld without naming them

#### Scenario: Unknown role
- **WHEN** a caller builds a pack with `--role evaluator`, which it does not declare
- **THEN** the request fails with `UNKNOWN_ROLE` naming the pack's roles

### Requirement: Packs need a checkout
Building a pack SHALL fail with `CHECKOUT_MISSING` and give the exact `repos locate` and `repos clone` commands when the repository has no recorded checkout on this machine. An undeclared pack name SHALL fail with `UNKNOWN_PACK` naming `default` and the repository's packs.

#### Scenario: Pack without a checkout
- **WHEN** a caller builds a pack of a repository that is missing on this machine, and then a pack name it does not declare
- **THEN** the first fails with `CHECKOUT_MISSING` and both remedies, the second with `UNKNOWN_PACK` listing `default` and the declared packs, and nothing is recorded or cloned

### Requirement: Seeded front matter
With `--seed` (MCP `seed`), the pack result SHALL include OKF frontmatter for a working note: `type: ContextPack`, a title and description naming the repository, pack and role, `status: draft`, the upstream as `resource`, the commit, manifest hash, concept references and file paths. It SHALL be deterministic and carry no `verified` or timestamps.

#### Scenario: Seed becomes a concept
- **WHEN** a caller builds a pack with `--seed` and writes a hub file from that frontmatter with any body
- **THEN** `validate` accepts the file as a draft, unverified concept of type `ContextPack`, and the seed names the pack's files and concept references

### Requirement: Routing skill opens repositories
The routing skill's body SHALL tell agents, when a request names one of the repositories, to first open it with the exact `repos open` command (or MCP `open_repo`) for that repository and work from the result instead of searching or scouting. This change SHALL NOT alter the skill's frontmatter.

#### Scenario: One call to start
- **WHEN** the routing skill is rendered for two registered repositories, one with `context` and one without
- **THEN** its body gives the exact `repos open` command for each, and its frontmatter is identical to the one rendered after removing the `context` key
