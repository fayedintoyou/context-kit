# Proposal

## Why

When I tell an agent "work on the orchard", the `my-repos` skill gives it a
checkout path and a list of things to read, and then the agent scouts. It lists
directories, greps for an `AGENTS.md`, browses the hub tree for anything
relevant. A fresh subagent or teammate does it all again, because it has the
installed skills and MCP servers but none of the parent's history. Meanwhile the
shared CLI already knows everything needed to skip that. The committed registry
(Repository concepts) plus this machine's overlay (`.state/checkouts.json`)
resolve the name to one path. Only the hub knows which concepts, skills and MCP
servers matter for that repository and its directories.

Resolution should be deterministic and done by the CLI, not the model. The same
call that resolves the path should hand over the repository's context, cheaply
and as pointers, with a sensible default pack and no configuration. Hubs can
then declare richer packs for particular actions, without anything in a hub
being executed and without expanding the whole wiki.

## What Changes

- **`repos open <repo> [<subpath>] [--role <role>]`** (stdio MCP `open_repo`,
  read-only, core, local-only) is the one call to start work. It takes an id, title, alias or upstream name and
  returns:
  - the resolution: the matched name and field, the registering concept, the
    upstream, and the path from this machine's record;
  - pointers (path, size, SHA-256) to the checkout's `AGENTS.md`/`CLAUDE.md`, at
    the root and on the way to the subpath;
  - the repository concept and its declared pointers (concepts with OKF
    summary, skills, MCP server names, areas, packs), without bodies;
  - the **default bootstrap**: at most 8 KiB of compact JSON (about 2k
    tokens) in all.

  When the repository isn't mapped on this machine, it says so (`missing`) and
  returns the exact `repos locate`/`repos clone` commands. It never clones,
  records or searches.
- **Default bootstrap, zero configuration.** Every located repository gets
  one: the instruction-file and concept pointers plus a tree of paths from the
  git index (so ignored files never appear). The tree is in code-point order,
  depth 2 and at most 150 entries, with deeper content counted, trimmed to the
  byte allowance, and with truncation reported.
- **Safe reads.** Git is read only from the index and HEAD, with `GIT_*`
  overrides, global and system config, hooks and fsmonitor disabled. No
  working-tree comparison ever runs a filter. Files are hashed by Context Kit
  itself. A symlink anywhere below the checkout root stops a read, so a
  replaced directory can't escape the checkout.
- **Optional `context` on Repository concepts** declares more pointers:
  - hub concept references, skill references and MCP server *names*;
  - `areas`, which attach pointers to a directory inside the checkout;
  - named `packs`: globs relative to the checkout plus references, for one
    action;
  - `roles` (for example a `reviewer`) that apply from the first `open` and
    to every pack, withholding the builder's notes and reporting only how
    much was withheld.

  The schema is closed and bounded at every level.

  Everything is declarative: no commands, URLs, credentials or scripts.
- **Canonical verification commands.** `context.verify` lists the commands
  agents are told to run to check work (for example `npm test`), so every
  session runs the same checks instead of inventing its own sequence.
  `repos open` returns them as declared text, and Context Kit never runs them.
- **Concept references** are `/<concept-id>` (the concept's own hub) or
  `<hub-id>:/<concept-id>`. This is the qualifier-colon-path form federation's
  namespaced IDs (`team-data:/tables/orders`) will reuse.
- **`validate`** checks `context` strictly: unknown keys at any level, string
  and list bounds, malformed globs (including `..`, absolute paths and
  backslashes) or names, the reserved pack name `default`, unresolved
  references, skills no hub declares or no enabled addon provides, and limits
  above the hard maxima. Other frontmatter stays OKF-permissive.
- **`repos pack <repo> <pack> [--role <role>] [--budget <bytes>] [--seed]`** (stdio
  MCP `context_pack`, read-only, local-only) expands a declared pack, or
  `default`, against the recorded checkout. It returns one canonical payload
  and its hash: the matching index files with size, SHA-256 and binary flag,
  the commit, the dirty flag, the instruction files and the references.
  Open-time data (path, freshness, MCP availability) is returned beside the
  payload and not hashed. File and byte budgets
  apply, with an explicit `truncated` report. `--seed` adds OKF frontmatter for
  a working note. Without a checkout it fails with `CHECKOUT_MISSING` and the
  remedies.
- **`--check-mcp`** on open and pack reports, per agent, whether each declared
  MCP server is registered (`available`/`missing`/`unknown`), by asking the
  agent's own CLI. Context Kit never registers or installs one.
- **`open_repo` becomes the workspace's resolve operation**, replacing
  `list_repos`, so `machine-setup`'s renderer names it (and the launcher command
  `context-kit repos open <id>`) in the `my-repos` body. Agents call it first
  and work from its result. Its frontmatter is unchanged. The sibling change
  `machine-setup` owns skill frontmatter and installation.

Non-goals: RAG, embeddings or semantic ranking; scripts or executables hosted
in hubs (expansion is the built-in CLI's fixed algorithm); installing or
configuring MCP servers; inlining file contents; writing into repositories'
own files; detecting the repository from the caller's working directory or MCP
roots (`machine-setup`'s `repos which` does that); serving checkouts over the
remote HTTP server; `keywords` on Repository concepts, skill frontmatter and
the remote-access parity rule (`machine-setup`, #50); federation itself
(`hub-federation`, #48).

## Dependencies

- **`slice-aware-links`** (a prerequisite toolkit change). Today
  `lib/specs/links.mjs` requires a linked test for every scenario of every
  active change, so `npm test` fails on this plan and on each slice until all
  of them land. That change makes the gate slice-aware. This change adds no
  placeholder tests to work around it.

- **Landing order across changes**, which `slices.yaml` can't express, is
  checked in tasks. The `open` slice starts after `machine-setup`'s
  `skill-frontmatter`, `portable-entry` and `local-only` slices have landed.
  `routing` starts after its `skill-frontmatter` and `portable-entry` slices
  have. No slice depends on `hub-federation`. Which concept's `context`
  applies to a repository merged from several concepts is specified and tested
  only in `hub-federation`, which lands after `fields`.

## Capabilities

### New Capabilities

- `repository-context`: opening a repository in one call (layered resolution,
  instruction files, verification commands, pointers, default pack), the optional `context` field
  and its validation, declared packs with roles and budgets, MCP availability
  reporting, role-aware bootstrap, and the routing skill's instruction to open repositories.

### Modified Capabilities

None. `repository-registry` keeps its requirements unchanged, and the routing
skill addition is an ADDED requirement here, so this change, `hub-federation`
and `machine-setup` don't modify the same requirement text.

## Impact

- `lib/repos.mjs`: parses and validates `context`, exposes resolution details
  from the existing `find()`, and adds the routing body line. New
  `lib/repo-context.mjs` for opening, pointer resolution, area matching, the
  default tree, pack expansion (`git ls-files`, hashing, budgets) and MCP
  availability.
- `lib/operations.mjs`, `bin/hub.mjs`, `lib/mcp/`: `open_repo` and `context_pack`
  in core, stdio only,
  `repos open` and `repos pack` with `--check-mcp`, `--role`, `--budget` and
  `--seed`. New error codes: `INVALID_CONTEXT`, `UNKNOWN_PACK`, `UNKNOWN_ROLE`,
  `CHECKOUT_MISSING`.
- `lib/landing.mjs`'s glob matcher moves unchanged into `lib/globs.mjs`, shared
  with packs. `lib/specs/progress.mjs` keeps its own matcher, whose semantics
  differ.
- Docs: `docs/format.md` (the `context` field), `skills/context-kit/references/repositories.md`
  and `commands.md`, README's repositories paragraph.
- Tests: new `test/e2e/repo-context.test.mjs` (temporary hubs, `git init`
  checkouts, fake agent CLIs as in `agents.test.mjs`) and a routing-skill test
  in `test/e2e/repos.test.mjs`.
- No new dependencies. Uses the `git` CLI, as `repos` already does.
