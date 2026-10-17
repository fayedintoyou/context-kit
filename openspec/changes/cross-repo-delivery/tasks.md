# Tasks

Fixtures: party repositories are local `git init` repos recorded with `repos locate`.
Their remotes are local bare repos. For scenarios involving the GitHub CLI, parties use
fictional `https://github.com/example/*` upstreams, mapped to the bare repos with an
isolated git `url.<file-url>.insteadOf` config. The fake `gh` asserts it received
`-R example/<name>` and rejects the fork or default repository. Stores are
registered in the isolated OpenSpec registry used by `test/e2e/specs.test.mjs`. `gh`
is stubbed on `PATH` where a scenario needs pull requests, as the existing progress
tests do. No network.

## 1. Store plans and party evidence

- [ ] 1.1 Store selection for `change_status`, `next_slices`, `read_slice`, `reconcile_change` and `archivable_changes`, and CLI `--store` on status/next/slice/reconcile/archivable/archive, through `specSource`. Link `test/e2e/progress.test.mjs` to "Store change over CLI and MCP"
- [ ] 1.2 Slice plan rules: `repo` required in store plans, forbidden in repository plans, and validated against the store's parties. Link `test/e2e/progress.test.mjs` to "Plan across party repositories" and "Unknown party"
- [ ] 1.3 Evidence per source in `lib/specs/landing.mjs`: party checkout by normalized upstream, qualified change id for store changes, party base resolution, and the `unknown` state in `deriveStatus`. Link `test/e2e/progress.test.mjs` to "Slice landed in another repository", "Same change name elsewhere" and "No checkout for a party". Existing progress tests must pass unchanged
- [ ] 1.4 Party remote and base: the remote matching the party upstream, its default branch, and its branch tip as the single base commit for landing, packets and links. Link `test/e2e/progress.test.mjs` to "Fork checkout" (fork `origin` with another default branch, party `upstream`, fake `gh` whose default is the fork) and "Local base behind its remote"
- [ ] 1.5 Party PR enrichment with `gh -R <owner>/<name>` from the party upstream, counting a merged PR only into the party's base. Link `test/e2e/progress.test.mjs` to "Party pull request merged elsewhere"

## 2. Packets, reconcile and links

- [ ] 2.1 Party packets: store, party, upstream, checkout, party base, dependency repositories and qualified trailers. Link `test/e2e/progress.test.mjs` to "Packet for a party slice", over both CLI `specs next --store` and MCP `read_slice`
- [ ] 2.2 Reconcile per repository: out-of-scope and shared files labeled by repository. Link `test/e2e/progress.test.mjs` to "Out-of-scope file in a party repository"
- [ ] 2.3 Contract test links via `git grep` at the party base (landed) or the slice's latest trailer commit (in progress), with repository and commit in results, and untested collection from every party. Link `test/e2e/progress.test.mjs` to "Party tests are found", "Pull request with no local commit" and "Unqualified or other-store links"

## 3. Archiving a store change

- [ ] 3.1 `evidence_missing` blocker, and `archive --ready --store` writing only under the store's `openspec/`. Link `test/e2e/archival.test.mjs` to "Party evidence missing" and "Archive a finished store change"

## 4. Docs and skills

- [ ] 4.1 `docs/delivery.md`: a worked fictional example (store change with `site` and `game` slices, each party's own change, the finishing step, who archives what, and that party link checkers ignore `<store-id>:` links). Also update `skills/context-kit/references/specs.md`. Verify the example's commands against the e2e fixture by running them in the integration test (4.3)
- [ ] 4.2 `slice-change` (choose `repo` per store slice, qualified trailers) and `reconcile-change` (review a party slice's PR in its party repository; end a finished store change by naming the finishing step). Verify with `npm test`
- [ ] 4.3 One integration test: a store with two parties and a contract change sliced across both. Land each slice in its party fixture, then `status` → `next` → `reconcile` → tick the final task → `archivable` is `ready` → `archive --ready --store` merges the contract into the store's canonical specs. Run `npm test` and `node bin/hub.mjs validate`

## Workflow follow-up

- Ship after `cross-repo-contracts` has merged and archived.
- A later change adds fetched mirrors and CI archiving for stores (see design Non-Goals).
