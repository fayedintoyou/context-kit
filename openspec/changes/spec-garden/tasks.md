# Tasks

## 1. Shared parsing

- [ ] 1.1 Extract scenario and `// spec:` link parsing from `scripts/spec-links.mjs` into `lib/specs/links.mjs`, rooted at any repository; the script imports it and `npm test` still passes unchanged
- [ ] 1.2 Add a delta parser in `lib/specs/deltas.mjs` that reads `ADDED`/`MODIFIED`/`REMOVED`/`RENAMED` requirement headers from a change's `specs/<capability>/spec.md`, for archived changes (with their date prefix) and active ones

## 2. Garden report

- [ ] 2.1 `lib/specs/garden.mjs`: reuse the audit's snapshot (factor `snapshot` and requirement keys out of `audit.mjs` and share them), collect twice, fail with `SNAPSHOT_CHANGED`; report `no_canonical_specs`; link `test/e2e/garden.test.mjs` to "Garden a repository", "Pending changes only" and "Gardening writes nothing" (hash every file in the fixture before and after)
- [ ] 2.2 Sizes and limits: line, requirement and scenario counts; `oversized`; requirements without scenarios; limit resolution from domain override, then taxonomy, then built-in defaults; link `test/e2e/garden.test.mjs` to "Oversized spec" and "Domain override"
- [ ] 2.3 History from archived deltas, carried across `RENAMED`; empty when absent; link `test/e2e/garden.test.mjs` to "History across a rename" and "Written without a change" (fixture archives built with the pinned OpenSpec CLI: propose, then `openspec archive`)
- [ ] 2.4 Locks from active changes; link `test/e2e/garden.test.mjs` to "Requirement under active change"
- [ ] 2.5 Lexical overlap (normalize, word 3-shingles, Jaccard, threshold, truncation to the output budget with a `truncated` flag); link `test/e2e/garden.test.mjs` to "Near-duplicate requirements"
- [ ] 2.6 Trace through `lib/specs/links.mjs`; `not_collected` when no links; link `test/e2e/garden.test.mjs` to "Unlinked scenario" and "No link convention"
- [ ] 2.7 Taxonomy: parse and validate `openspec/taxonomy.yaml` (zod schema; identifiers match `storeIdSchema`'s pattern), report `undeclared`, `empty`, `retiredInUse`, `unchecked` when absent, `INVALID_CONFIG` when malformed; link `test/e2e/garden.test.mjs` to "Taxonomy drift", "No taxonomy" and "Malformed taxonomy"
- [ ] 2.8 `--store <id>`: same report from a declared store, trace `not_collected`; extend "Garden a repository" or add a store case beside the existing store fixtures in `test/e2e/specs.test.mjs`

## 3. Interfaces

- [ ] 3.1 `garden_specs` in `lib/operations.mjs` (group `specs`, read-only, `{ store }` schema), `specs garden` in `bin/hub.mjs`, usage line; link `test/e2e/garden.test.mjs` to "Garden over MCP" (enabled and `--addons none` workspaces)
- [ ] 3.2 Run the report on this repository and on `~/context`'s pinned copy, and set the built-in default limits from what they show (update design decision 7 if they change)

## 4. Skill and docs

- [ ] 4.1 Write `skills/garden-canonical-specs/SKILL.md` following design decision 8: triage, evidence, classification, locked items deferred, retirements as questions, one change or none, `openspec validate --strict`, `independent-review` for large changes; add it to `addons/specs/addon.json`; link `test/e2e/addons.test.mjs` to "Specs addon lists the gardener"
- [ ] 4.2 Add "Gardening proposes, never rewrites" to `test/manual-checks.md`: verified by running the skill on a fixture copy with an oversized spec and a stale requirement during independent review
- [ ] 4.3 Document `specs garden`, `garden_specs` and `openspec/taxonomy.yaml` in the `specs` help topic and `skills/context-kit/references/specs.md`; mention gardening next to auditing in `docs/next.md`
- [ ] 4.4 Write `openspec/taxonomy.yaml` for this repository's own ten capabilities, so the toolkit gardens itself
- [ ] 4.5 Run `npm test` and `openspec validate spec-garden --strict`

## Workflow follow-up

- Run `garden-canonical-specs` on Context Kit itself and review the result as the first real maintenance change
- Upgrade `~/context`'s pin and run `agents install` so the skill reaches Claude Code and Codex
- Archive the change after merge
