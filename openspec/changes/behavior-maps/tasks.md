# Tasks

Slices are in `slices.yaml`. Every implementation commit carries
`OpenSpec-Change: behavior-maps` and `OpenSpec-Slice: <id>` trailers. After
`sources`, `lid-source` and `check` can be built in parallel; after `check`,
`pins`, `render` and `derived-status` can. Scenario tests go in
`test/e2e/maps.test.mjs` unless named otherwise, with fixtures (a fictional
Pigeon chat app's OpenSpec and LID specs, hubs, JUnit files, golden diagrams)
under `test/e2e/fixtures/maps/`.

## 1. Slice `sources`

- [ ] 1.1 `lib/behavior/sources.mjs`: the source table (`openspec`, `hub`), `Behavior` shape, normalization and 12-hex SHA-256 fingerprints (design decisions 1 to 3); `openspec` maps `openSpec(...).read()` results through `specSource`'s store rule, a requirement's text including its scenarios
- [ ] 1.2 `hub` source over `lib/workspace.mjs` concept reads: `<hub-id>:/<concept-id>`, title, `okf`, freshness action, inbox only on request, fingerprint of the whole file
- [ ] 1.3 `addons/maps/addon.json` (`operations: "maps"`, `skills: []` until slice `skill-docs`); `list_behaviors` in `lib/operations.mjs` (group `maps`, read-only), `maps behaviors --source <s> [--store] [--hub] [--inbox]` in `bin/hub.mjs` and its usage line
- [ ] 1.4 Link tests to "Unknown source", "List OpenSpec behaviors" (CLI and MCP, pending delta excluded), "Undeclared store", "List hub behaviors" and "Fingerprint follows the text"
- [ ] 1.5 `maps` help topic and `skills/context-kit/references/maps.md` started with `maps behaviors`, `list_behaviors` and `INVALID_SOURCE`; `test/e2e/help.test.mjs` stays green

## 2. Slice `lid-source`

- [ ] 2.1 `lib/behavior/lid.mjs`: files `docs/intent/**/*-specs.md` and `docs/specs/*.md`, the entry grammar and markers, title from the nearest `##` heading, marker excluded from the fingerprint, `INVALID_SOURCE` on duplicate IDs (design decision 4); register `lid` in the source table
- [ ] 2.2 Link tests to "List linked-intent behaviors" and "Duplicate linked-intent ID"

## 3. Slice `check`

- [ ] 3.1 `lib/behavior/maps.mjs`: find repository maps (`maps/*.md`) and hub `BehaviorMap` concepts, extract the single `yaml map` block, closed zod schema (design decisions 5 and 6), `UNKNOWN_MAP`
- [ ] 3.2 Structure checks, citation resolution with ambiguity, coverage by scope per source, label lint with `vocabulary` (design decision 8)
- [ ] 3.3 `lib/behavior/status.mjs`: declared status, evidence (confined repository paths, `#<n>`, `https://`), `fixed_by` targets, fix edges counting for reachability
- [ ] 3.4 Report shape and codes (design decision 7); `list_maps` and `check_map` operations, `maps list` and `maps check [<map>] [--strict]`, exit codes
- [ ] 3.5 Link tests to "List maps", "Unknown map", "Unknown key", "Unreachable state", "Valid map" (CLI and MCP), "Unknown citation", "Ambiguous citation", "Uncovered scenario", "Scope narrowed to a requirement", "Label reads as code", "Allowed term", "Issue and its fix", "Missing evidence file" and "Strict check in CI"
- [ ] 3.6 Help topic and reference: map format, check codes, `UNKNOWN_MAP`

## 4. Slice `pins`

- [ ] 4.1 `pin_map` (CLI only, write) rewriting only `pins` through `yaml`'s Document API; `unpinned` and `stale` warnings naming the citing elements
- [ ] 4.2 Link a test to "Spec changed after pinning" (asserts the rest of the file is byte-identical after pinning)

## 5. Slice `render`

- [ ] 5.1 `lib/behavior/render.mjs`: Mermaid per design decision 11 and JSON per decision 12; `render_map` and `maps render <map> [--format]`
- [ ] 5.2 Generated block markers, `maps render --write` (CLI only, write) and the `diagram_outdated` warning (design decision 13)
- [ ] 5.3 Golden diagram fixtures; link tests to "Render a map with a fix" (twice, CLI and MCP, byte-identical), "Render as JSON" and "Outdated diagram"

## 6. Slice `derived-status`

- [ ] 6.1 Derived `tested`/`untested`/`unknown` from `testLinks()` in `lib/specs/links.mjs`, with reasons; store sources `unknown` (design decision 9)
- [ ] 6.2 `lib/behavior/junit.mjs`: strict small XML reader, 16 MiB bound, `<!DOCTYPE` rejected, `RESULTS_FORMAT`; test-name extraction from the linked `test(` call; matching by name and `file` (design decision 10)
- [ ] 6.3 `--results` / `results` on check and render (never on `--write`); `status_conflict` for declared `works` or `fixed`
- [ ] 6.4 Link tests to "Tested and untested states", "Results decide status" (a JUnit file produced by `node --test --test-reporter=junit` on a fixture) and "Declared fix contradicted"

## 7. Slice `context-states`

- [ ] 7.1 `maps/context-states.md` in this repository, scoped to and citing the requirements named in design decision 14; `maps check --strict` on this repository passes
- [ ] 7.2 `lib/behavior/context.mjs`: placement by the precedence in design decision 14, counts, bounded concept lists; `context_states` and `maps context <hub-id> [--format] [--inbox]`
- [ ] 7.3 `context_stale` warnings for `hub`-source maps
- [ ] 7.4 Link tests to "A hub's context state" and "Map cites a retired concept"

## 8. Slice `skill-docs`

- [ ] 8.1 `skills/behavior-map/SKILL.md` per design decision 17, with a worked fictional example; add it to `addons/maps/addon.json`
- [ ] 8.2 Link `test/e2e/addons.test.mjs` to "Maps addon disabled" and `test/e2e/mcp.test.mjs` to "No write tools over MCP"; add "Draft from specs" to `test/manual-checks.md` with how it is checked (an agent drafts a map for the fixture's `alerts` capability from the skill alone; `maps check` passes and a reviewer confirms the labels are plain)
- [ ] 8.3 `docs/maps.md` (format, sources, statuses, CI use with `maps check --strict` and a JUnit file), README (addons table and a Maps paragraph), `docs/next.md`, `docs/format.md` (the `BehaviorMap` concept type), finished `maps` help topic and reference covering every command, tool and code
- [ ] 8.4 Run `npm test`, `node bin/hub.mjs validate`, `npx openspec validate behavior-maps --strict`, `node bin/hub.mjs --root . maps check --strict` and `specs reconcile behavior-maps`

## Workflow follow-up

- Reconcile this change with `reconcile-change`; the archive workflow archives it after merge, then run `garden-canonical-specs`
- Upgrade `~/context`'s pin, enable `maps` there and run `agents install`
