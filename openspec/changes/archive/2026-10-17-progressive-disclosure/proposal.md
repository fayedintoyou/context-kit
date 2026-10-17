# Proposal

## Why

Hubs are OKF bundles, but agents can only load a hub's curated selection all at once (`context`) or grep it (`search`). OKF is built for progressive disclosure: indexes at each level, a one-line `description` on every concept, and concepts addressable by path. Agents should see what exists, open one concept, and follow its links, spending context only on what they need. Federation and agent-maintained wikis both build on addressing single concepts.

## What Changes

- New `browse` operation lists one directory of a hub: the immediate child concepts and subdirectories, each with OKF type, title, description and trust summary, plus that directory's `index.md` body when present. Without an index, the listing is synthesized from frontmatter.
- New `read` operation returns one concept by its OKF concept ID (path without `.md`) with its OKF summary, body and outgoing links, each classified as a concept in the hub, a missing concept, or external.
- `search` results gain the matched concept's ID.
- Inbox notes stay opt-in for browse, read and search.
- CLI `browse <hub-id> [path]` and `read <hub-id> <concept-id>`; MCP tools `browse_hub` and `read_concept`.
- `context` keeps returning the curated selection as a starting point.
- Out of scope: cross-hub and federated links (federation change), writing indexes (wiki upkeep change), freshness decisions (freshness change).

## Capabilities

### New Capabilities
- `progressive-disclosure`: browse hub directories and read concepts by ID with classified links.

### Modified Capabilities
None.

## Impact

New operations in `lib/operations.mjs`, navigation in a new `lib/navigate.mjs`, CLI commands, docs, e2e tests over CLI and MCP. No new dependencies.
