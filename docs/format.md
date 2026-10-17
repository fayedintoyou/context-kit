# Hub format

A hub is a directory one level below `hubs/` or `examples/`. Each hub directory is
an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
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

- `specStores`: IDs of shared OpenSpec stores (planning repositories registered
  with `openspec store register`) whose specs apply to this hub.

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
