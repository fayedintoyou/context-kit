# Design

## Context

OKF v0.2 (GoogleCloudPlatform/knowledge-catalog, `okf/SPEC.md`) defines bundles as directories of Markdown concepts with YAML frontmatter, reserved `index.md` and `log.md`, and optional trust fields. OKF ignores non-Markdown files, so `hub.json` can sit inside a bundle.

## Decisions

- **The hub directory is the bundle.** A hub stays the unit Context Kit lists and selects; its directory, including `inbox/`, must conform. Alternative considered: one bundle per workspace, which would force a single bundle root over unrelated hubs.
- **Keep `hub.json` for Context Kit-only fields.** OKF has no place for skills, spec stores, hub links or a bounded curated selection, and forbids frontmatter in `index.md` beyond `okf_version`. Folding these into concept frontmatter would invent non-standard semantics for every concept.
- **Validate strictly, read leniently.** `validate` fails on anything §11 conformance requires, so our hubs stay exportable. Reads fail only when a curated document is not a concept; other problems (a stray file, an old-format note) come back as warnings, so one bad file never blocks `list`, `context` or `search`. Everything consumers must tolerate (unknown types, keys and versions, broken links, missing indexes) is accepted. Index and log bodies are not checked beyond the frontmatter and date-heading rules.
- **Trust summaries come only from OKF fields.** Context Kit never invents a score; it derives the tier and staleness as §5.3–5.5 specify. Inbox notes keep their separate `unreviewed` status because inbox placement is the review boundary.
- **Actors (§7).** MCP captures use the client's declared `name/version` from MCP initialization. Sanitizing removes `:`, so a client cannot produce a `human:`, `process:` or `team:` actor; missing identity becomes `unknown-client/unknown`. CLI captures default to the tool's own actor, `context-kit/<version>`, because the CLI cannot know whether a person or an agent is typing; a person passes `--by human:<id>`. Tool arguments never set the actor.
- **Walk.** The conformance walk skips dot-directories, rejects symlinked Markdown files, and reads at most 2,000 files per hub within the existing 128 KiB file limit. Errors name the hub and file and point to the migration notes in docs/format.md.
- **Malformed trust fields** (non-mapping `verified` entries, `stale_after` without a UTC offset) are reported as warnings and treated as absent, never as a rejection.
- **Bounds.** Conformance walks at most 2,000 Markdown files per hub, each within the existing 128 KiB file limit.

## Risks / Trade-offs

- [OKF is at v0.2 and may change] → Conformance is isolated in one module and pinned to v0.2; an `okf_version` mismatch is reported but still read on a best-effort basis.
- [Breaking existing hubs] → Only the toolkit example and the user's workspace exist; both migrate in this change, and the error names each nonconformant file.
- [Skill files inside a hub] → Agent Skills frontmatter allows a fixed key set, so adding `type` could break skill tooling. Skills must live outside hub directories; the format guide says so and validation reports a `SKILL.md` inside a hub as nonconformant.
