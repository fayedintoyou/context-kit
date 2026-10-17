# Knowledge: hubs and OKF

A **hub** is a directory under `hubs/` (or `examples/`) describing one area: a
person's preferences, a team's domain, a project. Each hub directory is an
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
v0.2 bundle plus a `hub.json` manifest.

## Concepts

Every Markdown file in a hub, except `index.md` and `log.md`, is a concept: YAML
frontmatter with at least a `type`, then a Markdown body. Its ID is its path
without `.md` (`playbooks/deploy`).

```markdown
---
type: Playbook
title: Deploy
description: How to ship a release.
status: stable                # draft | stable | deprecated
generated: { by: human:me, at: 2026-10-17T00:00:00Z }
verified: { by: human:me, at: 2026-10-17T00:00:00Z }
stale_after: 2027-01-01T00:00:00Z
---
```

Context Kit reports each concept's OKF signals under `okf`: `trust` is
`unverified`, `machine-confirmed` or `human-reviewed` (from `verified`), and
`stale` turns true at `stale_after`. Actors are `human:<id>`, `process:<id>` or
`<tool>/<version>`.

`index.md` lists a directory for progressive disclosure (frontmatter only for
`okf_version` at the hub root). `log.md` records history under `## YYYY-MM-DD`
headings. Link concepts with ordinary Markdown links; `/path.md` is relative to
the hub root.

## The manifest

`hub.json` holds what OKF does not: `id`, `description`, `documents` (the curated
selection `context` returns), `skills`, `links` to other hubs, and optional
`specStores`.

## Validation

`validate` requires every hub to be a conformant bundle and names each problem.
Reads are lenient: a stray file only produces a warning unless it is a curated
document. See `docs/format.md` in the core for the full format and migration.
