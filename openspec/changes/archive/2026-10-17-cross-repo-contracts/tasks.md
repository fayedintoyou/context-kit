# Tasks

Fixtures: stores are registered in the isolated OpenSpec registry used by
`test/e2e/specs.test.mjs`, and parties use fictional `https://github.com/example/*`
upstreams. No network.

## 1. Slice `parties-file`

- [x] 1.1 Add `lib/specs/parties.mjs`: load and validate a store's `openspec/parties.yaml` (party names, upstreams through `normalizeUpstream`, unique upstreams, contracts with at least two declared parties, each naming a canonical spec or one an active change adds, classed `canonical`/`proposed`). Link `test/e2e/specs.test.mjs` to "Contract names an unknown party" and "Contract names no spec", asserting the other `INVALID_CONFIG` cases in the same tests
- [x] 1.2 `specs parties --store <id>` CLI and `list_parties` MCP tool in the `specs` group, refusing a call without a store. Link `test/e2e/specs.test.mjs` to "Parties are listed", "Parties belong to stores" and "Contract proposed with its change" (archive the fixture change with `specs archive --ready` run against the store's root to see `canonical`)
- [x] 1.3 Document `parties.yaml` and `specs parties` in `skills/context-kit/references/specs.md` and `docs/format.md` with the fictional example, and add `parties` wherever help lists spec commands. Run `node bin/hub.mjs validate`; `npm test` passes except the spec-link check for `contract-labels` scenarios

## 2. Slice `contract-labels`

- [x] 2.1 Add `contract` to store `list_specs`/`read_spec` results, and `party` to referenced-store specs in repository listings, matched against all of the repository's remotes. Link `test/e2e/specs.test.mjs` to "Contract lists its parties" and "A repository sees its contracts"
- [x] 2.2 Document contract labels and `party` in `skills/context-kit/references/specs.md`, then run `node bin/hub.mjs validate` and `npm test` (all green, every scenario linked)
