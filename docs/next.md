# Roadmap

Knowledge is OKF-based so personal and team hubs can be federated, with tunable
freshness and progressive disclosure, maintained in an agent-friendly wiki shape.
Each step is its own OpenSpec change with linked end-to-end tests.

1. **Progressive disclosure** (done): browse a directory, read a concept by its
   OKF ID, follow classified links, search every concept.
2. **Freshness policy**: per-hub and per-type sensitivity (for example metrics
   daily, preferences twice a year) so each read says `read`, `verify` or
   `refresh`, and why, from OKF `stale_after`, `generated`, `verified` and
   `sources`.
3. **Federation**: a workspace mounts other personal or team bundles, read-only,
   with namespaced concept IDs (`team-data:/tables/orders`) and per-bundle
   provenance and trust. Links that leave a hub (`outside`) become resolvable when
   a mount names their target.
4. **Wiki upkeep**: agents promote inbox notes into concepts, regenerate
   `index.md`, append `log.md`, and lint for broken links, orphans and stale or
   unverified concepts.

## Decisions

Agreed defaults, 2026-10-17:

- Federation mounts are pinned git dependencies, upgraded deliberately (like an
  instance pins the core), not live checkouts. Mounts never live inside a hub
  directory.
- Agents write curated concepts only as `status: draft` with no `verified`; a
  person promotes and verifies them.
- A concept with no `stale_after` and no matching freshness rule is read directly;
  stricter rules are set per type.
- The CLI stays in Node while the official MCP SDK and OpenSpec are Node and the
  end-to-end tests pin behavior. Revisit a Go single binary when teammates install
  Context Kit for federation, since it removes Node and PATH setup for MCP clients.

## Later

Remote MCP over HTTP with deliberate authentication, phone access, interactive
pages, and adapters for external services. Live services stay authoritative for
their own state.
