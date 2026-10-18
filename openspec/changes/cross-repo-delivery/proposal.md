# Proposal

## Why

Once a store names the parties to a contract (`cross-repo-contracts`), changing the
contract means changing several repositories. Context Kit's delivery tools (slices,
landing evidence, packets, reconciliation, archive readiness) see only one repository
at a time: the one the change lives in. A store holds no code, so a store change can't
be tracked at all. People end up following such work by hand across repositories,
which is the bookkeeping the delivery process exists to remove.

## What Changes

- A store change's slices each name the party they land in (`repo:`). That party's
  checkout, recorded in the workspace's repository registry, supplies the evidence.
- Commits and PRs for a store change carry a store-qualified change id,
  `OpenSpec-Change: <store-id>:<change>`. A party's own change with the same name,
  or another store's, can never satisfy it.
- A party with no recorded checkout makes its slices `unknown`, with the remedy. It
  never looks `ready` or `landed`.
- `specs status|next|slice|reconcile|archivable` take `--store <id>`, and so do the
  matching MCP tools. `specs archive --ready --store <id>` stays CLI-only.
- Packets name the target party, its upstream and checkout, its base, the dependency
  evidence by repository, and the qualified trailers. A worker can be handed a packet
  and know where to work.
- Party tests link contract scenarios as `// spec: <store-id>:<capability> / <scenario>`
  in any tracked file. Reconcile and packets read them from each party: at the
  party's base for landed slices, at the slice's latest commit for slices in progress.
- Finishing a store change is documented as one step after the last party slice
  lands: reconcile, tick the final task, `specs archive --ready --store`, and commit
  in the store's repository.

Later, as a separate change: fetched mirrors for parties with no local checkout, and a
CI workflow that archives a store at a subpath with a token for private parties.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `change-progress`: store plans with party slices, qualified trailers, per-party
  landing and pull requests, the `unknown` state, store selection, cross-repository
  packets, reconciliation and contract test links.
- `change-archival`: readiness and archive for a store, and the `evidence_missing`
  blocker.

## Impact

- Code: `lib/specs/slices.mjs` (`repo`, store plan rules), `lib/specs/landing.mjs`
  (evidence per source, qualified change id, party base and PRs),
  `lib/specs/progress.mjs` (packets, reconcile, link collection with `git grep`),
  `lib/specs/archival.mjs`, `lib/operations.mjs` and `bin/hub.mjs` (`store`), and
  `lib/repos.mjs` (checkout lookup by upstream).
- Docs: `docs/delivery.md` (a worked store-change example), the `slice-change` and
  `reconcile-change` skills, `skills/context-kit/references/specs.md`.
- Depends on `cross-repo-contracts` (parties). Repository changes behave as today.
