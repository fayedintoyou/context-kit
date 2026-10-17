# Design

## Context

- Stores are resolved through pinned OpenSpec (`openspec store`). A store is a folder
  with `openspec/` and `.openspec-store/store.yaml` (`version: 1`, `id: <id>`).
  `store setup --no-init-git` places one inside an existing repository.
  `lib/operations.mjs` `specSource` enforces the declared-or-referenced rule for store
  reads.
- `normalizeUpstream` in `lib/repos.mjs` already compares upstreams across SSH, HTTPS,
  `.git` suffixes and case.
- Pending deltas are parsed by `lib/specs/deltas.mjs`, which can tell whether an active
  change ADDs a spec.

## Goals / Non-Goals

**Goals:**
- One small file that names a store's parties and contracts, readable everywhere a
  store is readable.

**Non-Goals:**
- Delivery across repositories (`cross-repo-delivery`).
- Parties for a repository's own `openspec/`. Cross-repo identity (link qualifiers,
  trailer namespaces) needs a store id, and the goal only needs stores.
- A contract format. A contract is an ordinary OpenSpec spec.

## Decisions

1. **`openspec/parties.yaml`, not OpenSpec config or taxonomy.** OpenSpec owns
   `config.yaml`, and future versions may reject unknown keys. `taxonomy.yaml` is
   optional gardening input. Example (fictional):
   ```yaml
   parties:
     site: https://github.com/example/site
     game: https://github.com/example/game
   contracts:
     game-embedding: [site, game]
   ```
   *Alternative*: name parties by registry id. Rejected because registry ids depend
   on the reader's hubs, while a store must make sense to every reader. Upstreams
   are portable.

2. **Proposed contracts are allowed.** Declaring a contract in the same change that
   adds its spec keeps the declaration and the contract reviewed together. Requiring
   canonical specs would force a second, unreviewed edit after archive. Listings stay
   canonical-only, so a proposed contract shows in `specs parties`, not in
   `specs list`. Renaming or removing a contract spec in a change must update
   `parties.yaml` in the same change, or validation fails once the change archives.
   That is the intended failure: it is loud and points at the file.

3. **Party matching uses every remote.** A checkout's `origin` may be SSH while the
   party uses HTTPS. A fork's `upstream` remote may be the party. Matching any remote
   through `normalizeUpstream` covers both. Two parties can't share an upstream, so a
   match is unambiguous.

## Risks / Trade-offs

- [A parties file that names private upstreams leaks nothing new] → It sits in the
  same store as the contracts, readable by whoever reads the store.
- [Validation on every store read could break reads of an otherwise healthy store] →
  It fails loudly with `INVALID_CONFIG`, as an invalid `taxonomy.yaml` already does
  for gardening.

## Migration Plan

Additive. Rollback is reverting the change.
