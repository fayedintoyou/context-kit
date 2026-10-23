# Roadmap

Knowledge is OKF-based so personal and team hubs can be federated, with tunable
freshness and progressive disclosure, maintained in an agent-friendly wiki shape.
Each step is its own OpenSpec change with linked end-to-end tests.

1. **Progressive disclosure** (done): browse a directory, read a concept by its
   OKF ID, follow classified links, search every concept.
2. **Freshness policy** (done): per-hub, per-type maximum ages so each read says
   `read`, `verify` or `refresh`, and why, from OKF `stale_after`, `generated`
   and `verified`.
3. **Federation**: a workspace mounts other personal or team bundles, read-only,
   with namespaced concept IDs (`team-data:/tables/orders`) and per-bundle
   provenance and trust. Links that leave a hub (`outside`) become resolvable when
   a mount names their target.
4. **Wiki upkeep**: agents promote inbox notes into concepts, regenerate
   `index.md`, append `log.md`, and lint for broken links, orphans and stale or
   unverified concepts.

Also done: addons with an agent installer for Claude Code and Codex, the `reflect`
skill, canonical spec auditing and gardening (read-only signals plus reviewed
maintenance changes), delivering changes in slices with derived progress and
reconciliation ([delivery](delivery.md)), help through the core `context-kit` skill,
and behavior maps drafted from OpenSpec specs, linked-intent development specs or a
hub's concepts (a team's or persona's working states), pinned, checked and rendered
as Mermaid ([maps](maps.md)). Next for maps (`behavior-maps`): declared and
test-derived status in the diagram; later, read-only maps of mounted hubs.

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
  end-to-end tests pin behavior. Context Kit already runs unchanged under Bun.
  When teammates install it for federation, ship a single executable with
  `bun build --compile` (rather than a Go port), after embedding the core's own
  files and giving the OpenSpec adapter a runtime that works inside the binary.
- Installs use the npx installer (`setup`, `agents install`); native plugin
  marketplaces are an option for distribution later (Codex also reads
  Claude-format marketplaces).

## Later

Remote MCP over HTTP with deliberate authentication, phone access, interactive
pages, and adapters for external services. Live services stay authoritative for
their own state.
