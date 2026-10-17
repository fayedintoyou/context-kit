# Tasks

## 1. Conformance and summaries

- [x] 1.1 Add an OKF module that parses concepts, checks bundle conformance and derives trust summaries, and verify with the e2e test "hubs must be conformant OKF bundles" linked to "Concept without a type", "Reserved file structure" and "Permissive consumption"
- [x] 1.2 Enforce conformance when loading hubs and report OKF summaries from context and search, and verify with the e2e test "context reports OKF trust and staleness" and "a stray file warns on reads but fails validation", linked to "Trust tiers and staleness" and "Stray file"

## 2. Writing OKF

- [x] 2.1 Write captures as OKF draft concepts with an actor from the MCP client or CLI `--by`, and verify with e2e tests linked to "Captured note records its author" and "Actor cannot be forged" over CLI and MCP
- [x] 2.2 Make `init` write an OKF starter with a versioned root index, and verify with the e2e test linked to "Conformant starter"
- [x] 2.3 Migrate the toolkit example hub and update docs/format.md and README, and verify `node bin/hub.mjs validate` passes

## 3. Integration

- [x] 3.1 Run `npm test`, spec links and `openspec validate okf-bundles --strict`, and verify all pass

## Workflow follow-up

- Migrate the user's workspace (`~/context`) after upgrading its pinned core.
