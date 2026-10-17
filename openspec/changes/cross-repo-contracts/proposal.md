# Proposal

## Why

A person's or team's apps depend on each other. A website embeds a game, and both
have to keep their side of the arrangement. Each repository's own specs describe what
happens inside it. Nothing records the agreement between two repositories or who it
binds. Shared OpenSpec stores already serve specs to several repositories, but a store
spec can't say which repositories are its parties. A repository can't ask which
agreements it has made.

## What Changes

- A store MAY declare its **parties** in `openspec/parties.yaml`: short names mapped
  to repository upstreams. It also says which specs are **contracts** between which
  parties. A contract may name a spec that is still only proposed (an ADDED delta in
  an active change), so a contract can be declared with the change that creates it.
- `specs parties --store <id>` / `list_parties` lists a store's parties and
  contracts, each contract `canonical` or `proposed`.
- Store spec listings and reads label each contract with its parties. A repository's
  listing of a referenced store marks the contracts that name it as a party, matched
  by its own upstream.
- Parties are a store feature only. A repository's own `openspec/` has none.

Delivering contract changes across party repositories (slices that land in another
repository, status, packets, reconciliation and archiving from a store) is the
follow-up change `cross-repo-delivery`.

## Capabilities

### New Capabilities
- `cross-repo-contracts`: declaring a store's parties and contracts, and showing a
  repository the contracts it is party to.

### Modified Capabilities
None.

## Impact

- Code: new `lib/specs/parties.mjs`; `lib/operations.mjs` (`list_parties`, contract
  labels on `list_specs`/`read_spec`); `bin/hub.mjs` (`specs parties`); reuse of
  `normalizeUpstream` from `lib/repos.mjs`.
- Docs: `skills/context-kit/references/specs.md`, `docs/format.md`.
- Additive. Stores without `parties.yaml` and all repository behavior are unchanged.
