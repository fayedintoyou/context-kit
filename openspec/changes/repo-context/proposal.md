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

- **`repos open <repo> [<subpath>]`** (MCP `open_repo`, read-only, core) is the
  one call to start work. It takes an id, title, alias or upstream name and
  returns:
  - the resolution: the matched name and field, the registering concept, the
    upstream, and the path from this machine's record;
  - pointers (path, size, SHA-256) to the checkout's `AGENTS.md`/`CLAUDE.md`, at
    the root and on the way to the subpath;
  - the repository concept and its declared pointers (concepts with OKF
    summary, skills, MCP server names, areas, packs), without bodies;
  - the **default pack**.

  When the repository isn't mapped on this machine, it says so (`missing`) and
  returns the exact `repos locate`/`repos clone` commands. It never clones,
  records or searches.
- **Default pack, zero configuration.** Every located repository gets one: the
  instruction-file and concept pointers plus a bounded tree of git-tracked paths
  (so ignored files never appear). The tree is in stable code-point order, depth
  2 and at most 150 entries, with deeper content summarized as counts and
  truncation reported. The target is a bootstrap of roughly 1–2k tokens.
- **Optional `context` on Repository concepts** declares more pointers:
  - hub concept references, skill references and MCP server *names*;
  - `areas`, which attach pointers to a directory inside the checkout;
  - named `packs`: globs relative to the checkout plus references, for one
    action, with optional `roles` (for example a `reviewer` that inherits the
    pack but withholds the builder's notes and is told only how much was
    withheld).

  Everything is declarative: no commands, URLs, credentials or scripts.
- **Concept references** are `/<concept-id>` (the concept's own hub) or
  `<hub-id>:/<concept-id>`. This is the qualifier-colon-path form federation's
  namespaced IDs (`team-data:/tables/orders`) will reuse.
- **`validate`** checks `context` strictly: unknown keys, malformed globs or
  names, the reserved pack name `default`, unresolved references, and limits
  above the hard maxima. Other frontmatter stays OKF-permissive.
- **`repos pack <repo> <pack> [--role <role>] [--budget <bytes>] [--seed]`** (MCP
  `context_pack`, read-only) expands a declared pack, or `default`, against the
  recorded checkout into a deterministic manifest. It lists the matching tracked
  files with size and SHA-256, plus the commit, dirty flag, the default pack's
  pointers, the pack's own pointers and a manifest hash. File and byte budgets
  apply, with an explicit `truncated` report. `--seed` adds OKF frontmatter for
  a working note. Without a checkout it fails with `CHECKOUT_MISSING` and the
  remedies.
- **`--check-mcp`** on open and pack reports, per agent, whether each declared
  MCP server is registered (`available`/`missing`/`unknown`), by asking the
  agent's own CLI. Context Kit never registers or installs one.
- **The `my-repos` body** tells agents to call `repos open <id>` (or
  `open_repo`) first and work from its result. Its frontmatter is unchanged.
  The sibling change `machine-setup` owns skill frontmatter and installation.

Non-goals: RAG, embeddings or semantic ranking; scripts or executables hosted
in hubs (expansion is the built-in CLI's fixed algorithm); installing or
configuring MCP servers; inlining file contents; writing into repositories'
own files; detecting the repository from the caller's working directory or MCP
roots; federation itself (`hub-federation`).

## Capabilities

### New Capabilities

- `repository-context`: opening a repository in one call (layered resolution,
  instruction files, pointers, default pack), the optional `context` field
  and its validation, declared packs with roles and budgets, MCP availability
  reporting, and the routing skill's instruction to open repositories.

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
- `lib/operations.mjs`, `bin/hub.mjs`: `open_repo` and `context_pack` in core,
  `repos open` and `repos pack` with `--check-mcp`, `--role`, `--budget` and
  `--seed`. New error codes: `INVALID_CONTEXT`, `UNKNOWN_PACK`, `UNKNOWN_ROLE`,
  `CHECKOUT_MISSING`.
- A shared glob helper replaces the two copies in `lib/landing.mjs` and
  `lib/specs/progress.mjs`.
- Docs: `docs/format.md` (the `context` field), `skills/context-kit/references/repositories.md`
  and `commands.md`, README's repositories paragraph.
- Tests: new `test/e2e/repo-context.test.mjs` (temporary hubs, `git init`
  checkouts, fake agent CLIs as in `agents.test.mjs`) and a routing-skill test
  in `test/e2e/repos.test.mjs`.
- No new dependencies. Uses the `git` CLI, as `repos` already does.
