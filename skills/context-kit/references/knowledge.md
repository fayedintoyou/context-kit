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

## Freshness

A hub tunes when knowledge must be checked or regenerated with `freshness` in
`hub.json`: maximum ages as ISO 8601 durations, per OKF type and by default.

```json
"freshness": { "default": "P1Y", "types": { "Metric": "P1D", "Preferences": "P6M" } }
```

Every read reports `freshness.action`:

- `refresh`: `stale_after` has passed; regenerate it from its sources.
- `verify`: older than its age since last verified (or generated, if never
  verified); check it against its sources, then add a `verified` entry.
- `read`: use it as written.

A concept with no matching rule and no `stale_after` is read directly. Each
decision has a `reason` and, when a rule applies, the `due` instant.

## Writing concepts as an agent

- Write curated concepts only as `status: draft` with no `verified`; a person
  promotes and verifies them. Set `generated.at` to the actual time of writing.
- Keep what the user said apart from what you inferred. Attribute stated facts and
  rules (`Source: <who>, <date>`); put inferences under an `Inferred (unconfirmed)`
  heading, never in the user's first-person voice, and list them in your report.
- When you record an operational cause or a "leave X alone" rule, name the check
  that confirmed it (a before/after request, a real browser load). If you ran none,
  write `Suspected: … (not confirmed)`. Do not disable a security setting on an
  unconfirmed diagnosis without saying so first.
- Record what the source cannot: for a repository, where it lives, external
  accounts and DNS, ownership rules. Link the repo's own docs rather than copying
  build, test or command details.

## Validation

`validate` requires every hub to be a conformant bundle and names each problem.
Reads are lenient: a stray file only produces a warning unless it is a curated
document. See `docs/format.md` in the core for the full format and migration.
