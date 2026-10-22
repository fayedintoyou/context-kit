# Spec Delta

## Purpose

Let an agent open one of the user's repositories by name in a single deterministic call: the shared CLI resolves it to this machine's checkout and hands over its instruction files, hub context pointers and a bounded default bootstrap, so the agent never scouts. Declared, budgeted packs and roles extend that.

## ADDED Requirements

### Requirement: Open a repository
`repos open <repo>` and the stdio MCP tool `open_repo` SHALL take a repository id, title, alias or upstream name as an explicit argument and, in one read-only call, return its resolution, its instruction-file pointers and its default bootstrap. CLI and MCP SHALL return equal results.

#### Scenario: Open by alias
- **WHEN** `https://github.com/example/orchard` is registered with alias `orchard`, its checkout tracks `AGENTS.md` and is recorded on this machine, and a caller runs `repos open orchard` and calls `open_repo` with `orchard`
- **THEN** both return the same result with the checkout path, the `AGENTS.md` pointer, the repository concept and the default tree

### Requirement: Layered resolution
Resolution SHALL be deterministic and done by the CLI: the name is matched against the shared registry (Repository concepts), then the upstream against this machine's recorded checkouts. The result SHALL say how it resolved: the field matched, the registering concept, the upstream and that the path came from this machine's record. It SHALL ignore the caller's working directory and never search the filesystem.

#### Scenario: How it resolved
- **WHEN** a caller opens a located repository by its title, and then by its id
- **THEN** each result names the field matched (`title` or `id`), the concept `team/fruit/orchard`, the upstream and the recorded path with source `machine`

#### Scenario: Explicit name wins over the working directory
- **WHEN** a caller runs `repos open orchard` from inside a worktree of another registered repository
- **THEN** the result resolves `orchard` to its own recorded checkout, not the worktree's repository

#### Scenario: Ambiguous or unknown name
- **WHEN** a caller opens a name two repositories share as upstream name, and then a name no repository has
- **THEN** the first fails with `AMBIGUOUS_REPOSITORY` naming both ids and the second with `UNKNOWN_REPOSITORY`

### Requirement: Unmapped repository
When the repository has no recorded checkout on this machine, or the recorded directory no longer exists, opening it SHALL succeed with status `missing`, the repository concept, no instruction files or tree, and `next` giving the exact `repos locate` and `repos clone` commands. It SHALL never clone, record or search.

#### Scenario: Not checked out here
- **WHEN** a caller opens a registered repository whose checkout is not recorded on this machine
- **THEN** the result has status `missing`, the repository concept, `next` with both exact commands, and no tree, and `.state/checkouts.json` is unchanged

#### Scenario: Stale mapping
- **WHEN** a repository's recorded checkout directory has been deleted and a caller opens it
- **THEN** the result has status `missing` with both exact commands, and the stale record is left as it was

### Requirement: Instruction file pointers
Opening a located repository SHALL return pointers (path, size, SHA-256) to regular files named `AGENTS.md` or `CLAUDE.md` at the checkout root and, with a subpath, in each directory down to it, outermost first, whether or not git tracks them. A symlinked instruction file SHALL be skipped with a warning.

#### Scenario: Nested instructions
- **WHEN** a checkout has a tracked `AGENTS.md` at its root and an untracked `services/billing/CLAUDE.md`, and a caller opens it at `services/billing/invoices`
- **THEN** the result points at `AGENTS.md` then `services/billing/CLAUDE.md`, and opening without a subpath points only at `AGENTS.md`

#### Scenario: Instruction file symlink
- **WHEN** a checkout's `CLAUDE.md` is a symlink to a file outside the checkout
- **THEN** opening returns no pointer for it and a warning naming `CLAUDE.md`, and the outside file is not read

### Requirement: Default bootstrap
Every located repository SHALL get, with no configuration, a bootstrap: instruction pointers, the repository concept and a tree of git-tracked paths under the root or subpath, sorted by code point, to depth 2 and at most 150 entries, with deeper content counted per directory. The whole result SHALL fit 8 KiB of compact JSON, trimming the tree, then declared pointers, with `truncated` reported.

#### Scenario: Zero-configuration bootstrap
- **WHEN** a Repository concept declares no `context`, and its checkout tracks `README.md`, `src/app.js` and `src/lib/deep/x.js` and has an ignored `build/` directory, and a caller opens it
- **THEN** the tree lists `README.md`, `src/` and `src/app.js`, counts one file under `src/lib/`, and never mentions `build/`

#### Scenario: Large tree
- **WHEN** a checkout tracks 400 files with long names in its root directory and a caller opens it
- **THEN** the compact JSON result is at most 8192 bytes, the tree lists a prefix of the files in code-point order, and `truncated` gives the count omitted and the first omitted path

### Requirement: Paths stay inside the checkout
Subpaths SHALL be relative directories without `.` or `..` segments, backslashes or a leading `/` (`INVALID_PATH`) that exist in the checkout (`UNKNOWN_PATH`). Every file or directory read SHALL have no symlinked component below the checkout root and a real path inside it; otherwise a subpath fails with `PATH_ESCAPE` and a file is skipped.

#### Scenario: Escaping or missing subpath
- **WHEN** a caller opens a repository at `../outside`, at `/etc`, and at `docs/none`, which does not exist
- **THEN** the first two fail with `INVALID_PATH` and the third with `UNKNOWN_PATH`

#### Scenario: Symlinked parent
- **WHEN** a tracked directory `notes` is replaced by a symlink to a directory outside the checkout holding `AGENTS.md` and `x.md`, and a caller opens the repository at `notes` and builds a pack including `notes/**`
- **THEN** opening fails with `PATH_ESCAPE`, the pack lists no file under `notes/` and counts them as skipped, and no outside file is read

### Requirement: Git is read without running checkout configuration
Context Kit SHALL read the checkout through git only from the index and HEAD, never running a git command that compares or converts working-tree content, never fetching, and with `GIT_*` overrides, global and system config, hooks and fsmonitor disabled. It SHALL read and hash working-tree files itself.

#### Scenario: Hostile checkout configuration
- **WHEN** a checkout's `.git/config` sets `core.fsmonitor`, a clean filter and a process filter for `*.md`, each a command that writes a marker file, the environment sets `GIT_DIR` elsewhere, and a caller opens the repository and builds a pack of its `*.md` files
- **THEN** both succeed against that checkout, and no marker file exists

### Requirement: Local-only repository operations
`open_repo` and `context_pack` SHALL be offered by the stdio MCP server only, not by the HTTP server, because they read the serving machine's checkouts.

#### Scenario: Not offered over HTTP
- **WHEN** an MCP client lists tools on the HTTP server and calls `open_repo`
- **THEN** neither `open_repo` nor `context_pack` is listed and the call fails with `UNKNOWN_OPERATION`, while a stdio client lists both

### Requirement: Context schema
A Repository concept MAY carry `context` with optional keys `verify`, `concepts`, `skills`, `mcp`, `areas`, `roles` and `packs`. An area has `path`, `concepts`, `skills`, `mcp`. A role has `exclude`, `omit`, `concepts`, `skills`, `mcp`. A pack has `description`, `files`, `exclude`, `concepts`, `skills`, `mcp`, `limits` (`files`, `bytes`). `validate` SHALL fail on any other key at any level.

#### Scenario: Declared context validates
- **WHEN** a Repository concept for `https://github.com/example/orchard` declares every key of `context`, each well formed and resolvable
- **THEN** `validate` passes

#### Scenario: Unknown keys at any level
- **WHEN** one Repository's `context` has `commands`, another's pack `release` has `include`, another's role `reviewer` has `files`, and a `Guide` concept has an unrelated extra key `context: hello`
- **THEN** `validate` fails naming each Repository concept and the full key path, and reports nothing about the Guide

### Requirement: Context bounds
`validate` SHALL enforce: at most 50 entries per list, 50 areas, 8 roles and 20 packs; names lowercase-hyphenated up to 40 characters; references, paths and globs up to 200 characters; pack descriptions up to 300; `limits.files` 1 to 500 and `limits.bytes` 1 to 4 MiB.

#### Scenario: Over the bounds
- **WHEN** a Repository declares 51 concepts, a pack description of 301 characters, a glob of 201 characters, `limits.files: 501` and a role named `Reviewer`
- **THEN** `validate` fails naming each field and its bound

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

### Requirement: Readable skill pointers
A skill reference SHALL use a hub manifest form (`kit:<name>` or a workspace `SKILL.md` path) and `validate` SHALL fail unless some hub declares it and, for `kit:` skills, an enabled addon provides it. Each skill pointer SHALL carry the hub and reference that `read-skill` (MCP `read_skill`) accepts.

#### Scenario: Every emitted skill pointer reads
- **WHEN** a Repository references a `kit:` skill its hub declares and a workspace skill another hub declares, and a caller opens it and reads each skill pointer with `read-skill <hub> <reference>`
- **THEN** every read succeeds

#### Scenario: Unreadable skill references
- **WHEN** a Repository references a workspace skill no hub declares, and a `kit:` skill of an addon that is not enabled
- **THEN** `validate` fails naming each reference and why

### Requirement: MCP server names
MCP entries SHALL be server names only: lowercase letters, digits, `-` and `_`, at most 64 characters. `validate` SHALL fail on any other MCP value, such as a mapping, a URL or a command line.

#### Scenario: Names, not configuration
- **WHEN** a Repository declares MCP entries `orchard-tracker`, `https://mcp.example.com`, `npx orchard-mcp --token x` and a mapping with a `command` key
- **THEN** `validate` passes `orchard-tracker` and fails naming each of the other three values

### Requirement: Area declarations
Each area's `path` SHALL be a directory relative to the checkout root without leading `/`, `.` or `..` segments, backslashes or glob characters. `validate` SHALL fail on a malformed path or two areas of one repository with the same path.

#### Scenario: Bad area paths
- **WHEN** a Repository declares areas `services/billing`, `../shared`, `src/**` and `services/billing` again
- **THEN** `validate` fails naming `../shared`, `src/**` and the duplicate `services/billing`, and accepts the first

### Requirement: Pack declarations
Each pack SHALL be named other than `default` and have a `description` and `files`. Globs in `files` and `exclude` (packs and roles) SHALL be relative to the checkout, use only `*`, `**` and `?` as wildcards, and contain no `.` or `..` segment, leading `/` or backslash.

#### Scenario: Invalid packs
- **WHEN** a Repository declares a pack without a description, packs with globs `/etc/**`, `../x/**`, `docs\\*.md` and `{a,b}.md`, and a pack named `default`
- **THEN** `validate` fails naming each pack and field

### Requirement: Declared pointers when opening
Opening a repository SHALL return its `verify` commands and list its declared pointers after its own concept. Concept pointers have hub, ID, type, title, description up to 300 characters, trust and freshness action, but no body; skill pointers have hub, reference, name and description; then MCP names, in declaration order.

#### Scenario: Pointers without bodies
- **WHEN** a repository declares two concepts, a skill and an MCP name, and a caller opens it
- **THEN** the result lists the repository concept, then both concepts with their summaries but no body text, the skill with its description, and the MCP name

### Requirement: Areas, roles and packs summarized
Without a subpath, opening SHALL list each area by path with counts of its concepts, skills and MCP names, each role by name, and each declared pack by name and description, without expanding them.

#### Scenario: Summarized declarations
- **WHEN** a repository declares two areas, a `reviewer` role and a `release` pack, and a caller opens it without a subpath
- **THEN** each area appears with its path and counts but no pointers, the role by name, and the pack with its description

### Requirement: Open at a directory
`repos open <repo> <subpath>` (MCP `path`) SHALL root the tree at the subpath and add the pointers of every area whose path equals or contains it, outermost first, after the repository's own, with duplicates dropped and the matched areas named.

#### Scenario: Nested areas
- **WHEN** a repository declares areas `services` and `services/billing`, and a caller opens it at `services/billing/invoices`
- **THEN** the result names both areas as matched and lists the repository's pointers, then those of `services`, then those of `services/billing`, each concept once

#### Scenario: Subpath outside every area
- **WHEN** a caller opens a repository at `docs`, which exists but no area contains
- **THEN** the result has a tree rooted at `docs`, the repository's pointers and no matched areas

### Requirement: Lenient context reads
Opening SHALL fail with `INVALID_CONTEXT`, naming the problems, only when the repository's `context` is structurally invalid. A reference that no longer resolves SHALL be returned as a pointer marked `missing` with a warning. `repos`, `list_repos` and the routing skill SHALL keep working for every repository whatever its `context`.

#### Scenario: Deleted concept after validation
- **WHEN** a referenced concept is deleted, and another repository has a `context` that is a list rather than a mapping
- **THEN** opening the first repository returns that pointer marked missing with a warning, opening the second fails with `INVALID_CONTEXT`, and `repos` lists both

### Requirement: Roles
`--role <role>` (MCP `role`) on open and pack SHALL apply a role: its `exclude` globs remove files from the tree and packs, `omit` removes declared pointers, and its own pointers are added. Instruction files SHALL never be withheld. Results SHALL report counts withheld, never their paths or IDs. An undeclared role SHALL fail with `UNKNOWN_ROLE`.

#### Scenario: A fresh reviewer never sees builder notes
- **WHEN** a repository tracks `notes/builder/plan.md` and `notes/review.md`, declares `/guides/release-builder`, and its `reviewer` role excludes `notes/builder/**` and omits that concept, and a fresh caller runs `repos open orchard --role reviewer` then `repos pack orchard release --role reviewer` for a pack including `notes/**`
- **THEN** neither output contains `notes/builder` or `release-builder`, both point at `AGENTS.md`, and both report withheld counts

#### Scenario: Unknown role
- **WHEN** a caller opens a repository or builds a pack with `--role evaluator`, which it does not declare
- **THEN** the request fails with `UNKNOWN_ROLE` naming the declared roles

### Requirement: Build a pack
`repos pack <repo> <pack>` and the stdio MCP tool `context_pack` SHALL return a canonical payload: repository id, upstream, pack, role, HEAD commit, instruction files, matching tracked files (path, size, SHA-256, binary flag), concept and skill references, MCP names and its hash. Open-time data SHALL be returned beside it. `default` SHALL return the default bootstrap's files and references.

#### Scenario: Pack for a release
- **WHEN** a located checkout tracks `AGENTS.md`, `CHANGELOG.md`, `docs/release/steps.md`, `docs/release/draft.tmp`, `docs/release/logo.png` and `src/app.js`, and the `release` pack includes `CHANGELOG.md` and `docs/release/**` and excludes `**/*.tmp`
- **THEN** the payload lists `CHANGELOG.md`, `docs/release/logo.png` marked binary, and `docs/release/steps.md` with sizes and SHA-256, points at `AGENTS.md`, and gives the HEAD commit, and no file content is returned

#### Scenario: Same over MCP
- **WHEN** a caller builds the same pack, and `default`, over the CLI and over stdio MCP with the repository and pack as arguments
- **THEN** each pair of results is equal

### Requirement: Packs are deterministic
The canonical payload SHALL depend only on the registry entry, pack declaration, role, HEAD, index and the bytes of selected files: sorted by code point, no paths outside the checkout, times, trust, freshness or MCP availability. `dirty` SHALL be true when a selected or instruction file differs from the index or is missing.

#### Scenario: Rebuild, edit and delete
- **WHEN** a caller builds a pack twice without changes, then edits `AGENTS.md`, then deletes a selected file, building after each step
- **THEN** the first two payloads and hashes are byte-identical, the third has a new hash and `dirty: true`, and the fourth reports the deleted file as missing with `dirty: true`

#### Scenario: Concepts age
- **WHEN** a pack references a concept, a caller builds it, the concept's `stale_after` passes, and the caller builds it again
- **THEN** `repos open` reports the concept's freshness as `refresh`, and both pack hashes are equal

#### Scenario: Same pack on two machines
- **WHEN** the same commit is checked out at two different paths, each recorded in its own copy of the workspace, and a caller builds the same pack in each
- **THEN** both payload hashes are equal

### Requirement: Pack files
Packs SHALL consider only files in the index, skipping submodules, symlinks, files under symlinked directories and files missing from the working tree, with counts. A file's size SHALL be checked before it is read. A file with a NUL byte in its first 8 KiB SHALL be marked `binary`.

#### Scenario: Skipped files
- **WHEN** a pack's glob matches a tracked file, an untracked file, a tracked symlink to a file outside the checkout and a tracked submodule
- **THEN** only the tracked file is listed, the untracked file is not mentioned, and one symlink and one submodule are reported skipped

### Requirement: Pack budgets
A pack SHALL list files in order until the next would exceed its file limit or byte budget (`limits`, default 100 files and 512 KiB), without reading that file. `--budget <bytes>` (MCP `budget`) MAY lower the budget, never raise it. When files are left out, `truncated` SHALL give the limit, count omitted and first omitted path.

#### Scenario: Truncated by bytes
- **WHEN** a pack matches three 4 KiB files and then a 10 MiB file, and a caller builds it with `--budget 9000`
- **THEN** two files are listed, `truncated` reports the byte budget, two omitted and the third path, and the 10 MiB file is never opened

#### Scenario: Budget above the limit
- **WHEN** a caller passes a `--budget` above the pack's `limits.bytes`
- **THEN** the pack's limit applies and the result reports the effective budget

### Requirement: Packs need a checkout
Building a pack SHALL fail with `CHECKOUT_MISSING` and give the exact `repos locate` and `repos clone` commands when the repository has no existing recorded checkout on this machine. An undeclared pack name SHALL fail with `UNKNOWN_PACK` naming `default` and the repository's packs.

#### Scenario: Pack without a checkout
- **WHEN** a caller builds a pack of a repository that is missing on this machine, and then a pack name it does not declare
- **THEN** the first fails with `CHECKOUT_MISSING` and both remedies, the second with `UNKNOWN_PACK` listing `default` and the declared packs, and nothing is recorded or cloned

### Requirement: Seeded front matter
With `--seed` (MCP `seed`), the pack result SHALL include OKF frontmatter for a working note: `type: ContextPack`, a title and description naming the repository, pack and role, `status: draft`, the upstream as `resource`, the commit, payload hash, concept references and file paths. It SHALL be deterministic and carry no `verified` or timestamps.

#### Scenario: Seed becomes a concept
- **WHEN** a caller builds a pack with `--seed` and writes a hub file from that frontmatter with any body
- **THEN** `validate` accepts the file as a draft, unverified concept of type `ContextPack`, and the seed names the pack's files and concept references

### Requirement: MCP server availability
Open and pack results SHALL report each declared MCP name as declared. Only with `--check-mcp` (MCP `checkMcp`) SHALL they also report, per agent, `available`, `missing`, or `unknown` when its CLI is absent or fails, asked through that agent's own CLI. Context Kit SHALL never register, install or configure a declared server.

#### Scenario: Declared versus registered
- **WHEN** a repository declares `orchard-tracker` and `docs-search`, a fake `claude` CLI has only `orchard-tracker` registered, no `codex` CLI is on the path, and a caller opens the repository with `--check-mcp`
- **THEN** `orchard-tracker` is available and `docs-search` missing for Claude Code, both are unknown for Codex, and the fake CLI received no add or remove call

#### Scenario: No check by default
- **WHEN** a caller opens a repository and builds a pack without `--check-mcp`
- **THEN** the MCP names are reported as declared with no availability, and no agent CLI is called

### Requirement: Routing skill opens repositories
The routing skill's body SHALL tell agents, when a request names one of the repositories, to first open it with the exact `repos open` command (or MCP `open_repo`) for that repository, passing `--role` when they are reviewing, and work from the result instead of scouting. This change SHALL NOT alter the skill's frontmatter.

#### Scenario: One call to start
- **WHEN** the routing skill is rendered for two registered repositories, one with `context` and one without
- **THEN** its body gives the exact `repos open` command for each, and its frontmatter is identical to the one rendered after removing the `context` key
