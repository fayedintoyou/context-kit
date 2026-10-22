# Tasks

Slices are in `slices.yaml`. Every implementation commit carries
`OpenSpec-Change: behavior-maps` and `OpenSpec-Slice: <id>` trailers. `journey`
lands first and is usable alone; `pins`, `lid-source`, `hub-maps` and `evidence`
can then be built in parallel. Scenario tests go in `test/e2e/maps.test.mjs`
unless named otherwise, with fixtures (a fictional Pigeon chat app's OpenSpec
specs, a fictional Brightdesk support team's hub, LID entries copied from
upstream, golden diagrams) under `test/e2e/fixtures/maps/`.

## 1. Slice `journey`

- [x] 1.1 `lib/behavior/sources.mjs`: the source table, `Behavior` shape, normalization and 12-hex SHA-256 fingerprints, and the `openspec` source over `openSpec(...).read()` and `specSource`'s store rule, a requirement's text including its scenarios (design decisions 1 to 3)
- [x] 1.2 `lib/behavior/maps.mjs`: find `maps/*.md`, extract the single `yaml map` block, closed zod schema with `kind` defaulting to `state` (decision 5), `UNKNOWN_MAP`; structure checks, citation resolution (every `state` cites; every ambiguous ID rejected), coverage by scope, label lint with `vocabulary` (decision 10); the report and exit codes (decision 9)
- [x] 1.3 `lib/behavior/render.mjs`: Mermaid shapes, labels and edges (decision 12, without status classes yet) and JSON structure and citations (decision 13, no pins or statuses yet); the generated block and `maps render --write` (decision 14)
- [x] 1.4 `addons/maps/addon.json` (`operations: "maps"`, skill `behavior-map`); `list_behaviors`, `list_maps`, `check_map`, `render_map` in `lib/operations.mjs` (group `maps`, read-only) and `write_map_diagram` (CLI only, write); `maps behaviors|list|check|render` in `bin/hub.mjs` with usage lines
- [x] 1.5 `skills/behavior-map/SKILL.md`, the `journey` part of decision 17 (drafting, citing, checking, rendering; no pinning or status yet) with a status-free Pigeon example; `maps` help topic (`skills/context-kit/references/maps.md`) with every command, tool and code; the topic in `skills/context-kit/SKILL.md`'s table and `test/e2e/help.test.mjs`'s topic list, `maps` among the two-word commands it reads; `docs/maps.md` ("behavior maps", with "statecharts" as the familiar term), README (addons table, a Maps paragraph), `docs/format.md` (the `BehaviorMap` type), `docs/next.md`
- [x] 1.6 Link tests to "Unknown source", "List OpenSpec behaviors" (CLI and MCP, pending delta excluded), "Undeclared store", "Fingerprint follows the text", "List maps", "Unknown map", "Unknown key", "Unreachable state", "Valid map" (CLI and MCP), "Uncited state", "Unknown citation", "Ambiguous citation" (two scenarios sharing a name), "Uncovered scenario", "Scope narrowed to a requirement", "Label reads as code", "Allowed term" (with and without `GitHub` in the vocabulary), "Strict check in CI", "Render a map" (twice, CLI and MCP, byte-identical with a golden file), "Render as JSON" and "Outdated diagram"
- [x] 1.7 Link `test/e2e/mcp.test.mjs` to "No write tools over MCP" and `test/e2e/addons.test.mjs` to "Maps addon disabled"
- [x] 1.8 Add to `test/manual-checks.md`: "Diagram shows on GitHub" (push a fixture map with a written diagram to a scratch branch and view it) and "Draft from specs" (an agent drafts a map for the fixture's `alerts` capability from the skill alone; `maps check` passes and a reviewer confirms the labels are plain)

## 2. Slice `pins`

- [ ] 2.1 `pin_map` (CLI only, write) rewriting only `pins` through `yaml`'s Document API; `unpinned` and `stale` warnings naming the citing elements
- [ ] 2.2 Link tests to "Spec changed after pinning" (the rest of the file byte-identical after pinning) and "Pin and render converge"
- [ ] 2.3 JSON `pin` per citation; skill and help: when to pin (after a person reviews the map)
- [ ] 2.4 If `hub-maps` and `hub-federation` have both landed, test that `maps pin <mount>:/<id>` fails `UNKNOWN_MAP`; otherwise leave it to whichever of them lands last

## 3. Slice `lid-source`

- [x] 3.1 Fixtures from `jszmajda/lid` at `9679360`: `LID-CORE-001`…`004` from `docs/intent/linked-intent-dev/core/core-specs.md` (backticked markers), `AUTH-UI-001`, `AUTH-UI-002`, `AUTH-API-001`, `AUTH-API-002` and `CART-UI-001` from `plugins/linked-intent-dev/skills/linked-intent-dev/references/ears-syntax.md` (plain markers and markerless), laid out as `docs/intent/**/*-specs.md` and `docs/specs/*.md`, with upstream's MIT `LICENSE` and a README naming the source files and commit
- [x] 3.2 `lid` source per design decision 4; `INVALID_SOURCE` on duplicate IDs
- [x] 3.3 Link tests to "Upstream entry forms" and "Duplicate linked-intent ID"; help and docs list the `lid` source

## 4. Slice `hub-maps`

- [ ] 4.1 `hub` source over workspace hubs only (decision 14), `BehaviorMap` concepts excluded, inbox on request, `--at`/`at` through `summarize` and `freshness` (decision 8)
- [ ] 4.2 Hub `BehaviorMap` concepts as maps named `<hub-id>:/<concept-id>`; `context_stale` warnings; if `hub-federation` has landed, filter mounted hubs and test that a mount's map is unlisted and `maps check <mount>:/<id>` fails `UNKNOWN_MAP`, otherwise note on #48 that maps ignore mounts
- [ ] 4.3 Brightdesk hub fixture and the skill's second worked example (decision 7)
- [ ] 4.4 Link tests to "List hub behaviors", "Reproducible freshness", "A team's working states", "A hub map does not cover itself", "Map cites an outdated concept" and "Rendering ignores the clock"

## 5. Slice `evidence`

- [ ] 5.1 Declared status, evidence (confined repository paths, `#<n>`, `https://`), `fixed_by` targets, fix edges counting for reachability
- [ ] 5.2 Derived `tested`/`untested`/`unknown` from `testLinks()` in `lib/specs/links.mjs`, store sources `unknown`, both origins in the report and JSON (decision 11)
- [ ] 5.3 Status classes, the key and fix edges in Mermaid (decision 12), `status` and `fixes` in JSON (decision 13); update golden files; the skill's status and evidence guidance and the Pigeon example's pop-up issue and fix
- [ ] 5.4 Add "Status key shows on GitHub" to `test/manual-checks.md` (push a fixture map with statuses and a written diagram to a scratch branch and view it)
- [ ] 5.5 Link tests to "Issue and its fix", "Missing evidence file", "Tested and untested states", "Statuses in JSON" and "Render a map with a fix"
- [ ] 5.6 Run `npm test`, `node bin/hub.mjs validate`, `npx openspec validate behavior-maps --strict` and `specs reconcile behavior-maps`

## Workflow follow-up

- Reconcile this change with `reconcile-change`; the archive workflow archives it after merge, then run `garden-canonical-specs`
- Upgrade `~/context`'s pin, enable `maps` there and run `agents install`
