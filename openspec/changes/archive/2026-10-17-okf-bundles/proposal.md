# Proposal

## Why

Hubs use a Context Kit-specific layout: a manifest plus plain Markdown. Google Cloud's Open Knowledge Format (OKF v0.2) standardizes the same idea, Markdown concepts with YAML frontmatter, and adds provenance, trust and lifecycle fields that match what Context Kit tracks informally (curated versus unreviewed notes). Making every hub a conformant OKF bundle lets other OKF tools read Context Kit knowledge and gives agents a standard trust signal.

## What Changes

- Every hub directory MUST be a conformant OKF v0.2 bundle, checked strictly by `validate` and leniently on reads. Every non-reserved Markdown file has frontmatter with a non-empty `type`, and `index.md`/`log.md` follow their reserved structure. Unknown types, unknown keys and broken links remain acceptable. **BREAKING** for existing hubs without frontmatter; the toolkit example and the user's workspace are migrated in this change.
- `hub.json` remains for what OKF does not define: identity, curated document selection, skills, spec stores and hub links.
- `context` and `search` report each document's OKF summary: type, title, description, status, trust tier and staleness, derived only from OKF fields.
- Captured notes become OKF draft concepts (`type: Note`, `status: draft`, `generated` with an actor, no `verified`). MCP captures name the connected client; CLI captures take `--by <actor>`.
- `init` writes a bundle-root `index.md` declaring `okf_version: "0.2"` and starter documents with frontmatter.
- Out of scope: attested computations (§10) execution, generating `index.md`/`log.md` automatically, and importing arbitrary external OKF bundles as hubs.

## Capabilities

### New Capabilities
- `knowledge-format`: hubs as OKF bundles, conformance validation, and OKF trust summaries.

### Modified Capabilities
- `context-workspaces`: captured notes are written as OKF draft concepts with an actor.

## Impact

`lib/hubs.mjs`, new `lib/okf.mjs`, `lib/workspace.mjs`, `bin/hub.mjs` (`--by`), `bin/mcp.mjs` (client actor), example hub, docs, e2e tests. Pins `yaml` 2.9.1 as a direct dependency (previously transitive via OpenSpec).
