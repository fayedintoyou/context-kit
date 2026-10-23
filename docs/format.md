# Hub format

A hub is a directory one level below `hubs/` or `examples/`. Each hub directory is
an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
(OKF) v0.2 bundle, plus a `hub.json` manifest for what OKF does not define. OKF
tools can read a hub as-is; they ignore `hub.json`.

```
hubs/working-with-agents/
  hub.json          # Context Kit: identity, curated selection, skills, stores, links
  index.md          # OKF: optional listing; okf_version: "0.2" at the hub root
  README.md         # OKF concept
  preferences.md    # OKF concept
  inbox/            # captured notes, also OKF concepts (status: draft)
```

## OKF concepts

Every Markdown file in a hub, other than `index.md` and `log.md`, is a concept: a
UTF-8 file starting with YAML frontmatter that has a non-empty `type`.

```markdown
---
type: Preferences
title: Working preferences
description: How I like agents to approach work.
status: stable
generated: { by: human:me, at: 2026-10-17T00:00:00Z }
verified: { by: human:me, at: 2026-10-17T00:00:00Z }
stale_after: 2027-04-01T00:00:00Z
---

# Working preferences
...
```

Only `type` is required. Context Kit reads the OKF trust and lifecycle fields and
reports them with every document and search result, under `okf`:

- `trust`: `unverified` (no `verified`), `machine-confirmed` (only non-`human:`
  verifiers) or `human-reviewed` (any `human:` verifier).
- `status`: `draft`, `stable` (the default) or `deprecated`.
- `stale`: true once the current time reaches `stale_after`, which needs an
  explicit UTC offset.

Actors follow OKF: `human:<id>` for people, `process:<id>` for automated
processes, `<producer>/<version>` for agents and tools. Link concepts with
ordinary Markdown links; root-relative links (`/preferences.md`) are stable when
files move. Broken links, unknown types and extra keys are allowed.

A concept with `type: Repository` registers one of your repositories. Its
`resource` must be the git upstream (`https://github.com/<owner>/<name>`, an SSH
URL, or `file://` for a local one), optional `aliases` lists other names for it,
and optional `keywords` lists topic phrases that aren't names ("personal site").
Keywords only help agents pick the routing skill; commands never accept them.
The `resource` never carries credentials: `validate` rejects one with userinfo
(other than a well-known SSH login such as `git@`), a query or a fragment, naming
the clean form to use, and `repos add` stores only the clean form.
`validate` rejects a Repository without a git upstream, with `aliases` that is not
a list of names or `keywords` that is not a list of strings, sharing an alias or
title with another, with a title over 80 characters or an alias or keyword over
60 (Unicode code points), or with a keyword equal to another repository's title
or alias. `repos add` refuses names over these bounds. Local checkout paths are never stored in hubs (see the `repositories`
help topic).

A Repository concept may also carry `context`: what `repos open` hands an agent
beyond the defaults (see the `repositories` help topic). It is a closed mapping
with optional keys:

- `verify`: up to 10 single-line commands, each at most 200 characters, that
  agents are told to run to check work. They are text: Context Kit never runs them.
- `concepts`: concept references, `/<concept-id>` for a concept of the
  Repository's own hub or `<hub-id>:/<concept-id>` for one in another workspace
  hub. An unqualified reference never resolves outside its hub; inbox notes are
  not referenceable.
- `skills`: skill references in hub manifest form (`kit:<name>` or a workspace
  `SKILL.md` path), declared by some hub and, for `kit:`, provided by an enabled
  addon.
- `mcp`: MCP server names (lowercase letters, digits, `-`, `_`, at most 64
  characters), never URLs, commands or configuration.
- `areas`: a list of `{path, concepts, skills, mcp}`, `path` a literal directory
  relative to the checkout root, without a leading `/`, `.` or `..` segments,
  backslashes or glob characters, distinct within the repository.
- `roles`: names mapped to `{exclude, omit, concepts, skills, mcp}`: `exclude`
  globs, `omit` the references or MCP names to withhold.
- `packs`: names other than `default` mapped to `{description, files, exclude,
  concepts, skills, mcp, limits}`, with `description` and `files` required and
  `limits` holding `files` (1 to 500) and `bytes` (1 to 4 MiB).

Globs are relative to the checkout and use only `*`, `**` and `?` as wildcards,
with no `.` or `..` segment, leading `/` or backslash. Bounds: at most 50
entries per list, 50 areas, 8 roles and 20 packs; role and pack names
lowercase-hyphenated up to 40 characters; references, paths and globs up to 200
characters; pack descriptions up to 300. `validate` fails (`INVALID_CONTEXT`) on
any other key at any level, a value out of bounds or malformed, or a reference
that does not resolve, naming the concept and key path. Other concept types keep
OKF's permissiveness: a `context` key on them means nothing. Reads are lenient:
`repos open` refuses only a structurally invalid `context`, and returns a
reference that stopped resolving as a pointer marked `missing`.

The bounds don't cap the file: a `context` within every bound can still make the
concept file larger than the 128 KiB a concept may be, which fails as `TOO_LARGE`.

A concept with `type: BehaviorMap` is a behavior map: one fenced `yaml map` block
with a source, a scope, nodes and transitions, and optionally a generated Mermaid
diagram between `context-kit:diagram` markers. A repository keeps its maps in
`maps/<name>.md`; a hub may hold maps too, as concepts anywhere in it (outside
`inbox/`), named `<hub-id>:/<concept-id>`. `maps check` validates them (see
[maps](maps.md)); `validate` treats them as ordinary concepts.

`index.md` files carry no frontmatter, except `okf_version` in the hub-root index.
Every `##` heading in a `log.md` is a `YYYY-MM-DD` date.

## The manifest

Required `hub.json` fields:

- `version`: integer `1`.
- `id`: unique identifier such as `personal/working-with-agents`.
- `description`: short description used to select the right hub.
- `documents`: nonempty list of concept paths relative to the hub directory.
  This is the curated selection `context` returns, in order.
- `skills`: skill references, either `kit:<name>` for skills bundled with the
  core or `SKILL.md` paths relative to the workspace root.
- `links`: other hub IDs. Links express navigation, not automatic inclusion or
  permission to access resources.

Optional:

- `freshness`: when this hub's knowledge must be checked or regenerated, as
  ISO 8601 durations: `{"default": "P1Y", "types": {"Metric": "P1D"}}`. Reads
  report `freshness.action`: `refresh` once `stale_after` passes, `verify` when
  older than the type's (or default) age since last verified or generated, else
  `read`.
- `specStores`: IDs of shared OpenSpec stores (planning repositories registered
  with `openspec store register`) whose specs apply to this hub.

A store may name the repositories its specs bind in `openspec/parties.yaml`: each
party is a lowercase hyphenated name mapped to a repository upstream (a git URL),
and each contract is a spec of the store with two or more of those parties
(fictional example):

```yaml
parties:
  site: https://github.com/example/site
  game: https://github.com/example/game
contracts:
  game-embedding: [site, game]
```

A contract names a canonical spec or one an active change of the store adds.
Store spec listings and reads label each spec with `contract` (its parties, or
null), and a repository listing a referenced store adds `party`, the party whose
upstream matches one of its git remotes, or null. Only stores declare parties; a
repository's own `openspec/` has none. See the `specs` help topic.

Paths must resolve inside their allowed root, including through symlinks. IDs use
lowercase letters, digits, hyphens and slash-separated segments. Unknown manifest
fields are rejected so accidental assumptions do not look supported.

Skills follow the Agent Skills format, which does not allow an OKF `type`, so keep
`SKILL.md` files outside hub directories.

## Checking

`validate` requires every hub to be a conformant bundle and reports each
nonconformant file. Reads are lenient: `list`, `context` and `search` fail only
when a curated document is not a concept, and report other problems (a stray
file, an unknown `okf_version`, a malformed `stale_after`) as `warnings`.

Captured notes are written as concepts with `type: Note`, `status: draft`, no
`verified`, and `generated.by` naming the MCP client or the CLI's `--by` actor
(default `context-kit/<version>`). Reviewing a note means folding it into a
curated concept, adding a `verified` entry if you checked it, and deleting the note.

## Mounts

A workspace can also use a hub from another git repository. Its `context-kit.json`
declares `mounts`, each mount name mapping to a credential-free git `source`, an
optional `path` to the hub directory inside it, an optional `ref` and the pinned
40-hex `commit`:

```json
"mounts": { "shared": { "source": "https://github.com/example/shared-context", "path": "hubs/data", "ref": "main", "commit": "0123456789abcdef0123456789abcdef01234567" } }
```

The mounted directory must hold a `hub.json` and an OKF bundle. `mounts add` writes
the declaration; `mounts fetch` exports the pinned commit, read-only, into untracked
`.state/mounts/<name>/`, never under `hubs/`. The `mounts` help topic has the rules.

A fetched mount is read like a workspace hub, under its mount name, and every
concept result carries a qualified `ref`, `<hub-id>:/<concept-id>`. Every MCP
client the server admits, over stdio or the remote HTTP server, sees mounted
content and its `mount` provenance exactly like workspace hubs. Its Repository
concepts join the registry as `<mount>:/<concept-id>`, with checkouts recorded per
machine as for any repository. Concepts sharing an upstream are one repository
(workspace hubs first, then mounts by name), and a title or alias a mount claims
for a different upstream than a workspace hub, or that only mounts claim, is a
warning, never a `validate` failure.

## Migrating

Hubs created before OKF support have plain Markdown documents. For each one, add
frontmatter with at least a `type` (for example `Guide` or `Preferences`), a
`title` and a `description`, and add a hub-root `index.md` that declares
`okf_version: "0.2"` and lists the documents. Older captured notes need the same
frontmatter, with `type: Note` and `status: draft`. Then run `validate`. The
manifest version stays `1`; an older core reads the new files as plain Markdown.

Markdown holds preferences, source references, explanations, routing and
decisions. Never put credentials in a hub. Reading a hub does not execute code or
authorize its instructions.
