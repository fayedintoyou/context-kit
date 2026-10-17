# Design

## Context

- Delivery (`lib/specs/slices.mjs`, `landing.mjs`, `progress.mjs`, `archival.mjs`)
  takes one `root`, both where the change lives and where its code lands, and runs
  `git` and `gh` there.
- `cross-repo-contracts` gives stores `openspec/parties.yaml`. A store's id is in
  `.openspec-store/store.yaml` (`id:`).
- The repository registry stores machine-local checkouts in `.state/checkouts.json`,
  keyed by normalized upstream. Any upstream can be looked up whether or not a hub
  registers it.
- Context Kit's own test links follow its layout (`test/**.test.mjs`). Party
  repositories use their own layouts and link checkers.

## Goals / Non-Goals

**Goals:**
- Separate where a change is planned (a store) from where each slice lands (a party),
  with no change for repository plans.
- Read only what the person already has: recorded checkouts. Never fetch or write
  outside `specs archive`.

**Non-Goals (a later change):**
- Fetched mirrors for parties with no checkout, and CI that archives a store at a
  subpath with a token for private parties. When that lands, mirrors need explicit
  forced and pruned fetch refspecs and their own remote-HEAD resolution. Bare clones
  do neither. Tests must use a fixture remote that really filters blobs.
- Teaching each party's link checker about qualified links. That is party work.
  Checkers must ignore links whose capability carries a `<store-id>:` qualifier.

## Decisions

1. **Qualified change id, not a new trailer.** Store changes use
   `OpenSpec-Change: <store-id>:<change>`. The trailer search already matches the
   whole value, so a party's own `embed` change or another store's `other:embed`
   can't collide. No new trailer key, and existing repositories are untouched. The
   `:` matches the qualified test-link syntax, so one identity reads the same in
   commits and tests.
   *Alternative*: an `OpenSpec-Store` trailer. Rejected: a second line to forget, and
   the commit search would have to correlate two trailers.

2. **Every store slice names a party.** A store holds no code, so a slice without
   `repo` would have nowhere to land. Requiring it removes a case rather than
   defining one.

3. **Evidence sources.** `landing` becomes a function over sources
   `{ repo, root, upstream }`, one per party named by the plan. The checkout is found
   by the party upstream's normalized key in the workspace's checkouts. With no
   checkout, the source is `unknown`, and `deriveStatus` gains that state: not landed,
   and its dependents blocked. Inside the checkout, the **party remote** is the remote
   whose URL normalizes to the party upstream. A fork's `origin` is never assumed to be
   the party. The base branch is the plan's `base`, else `refs/remotes/<party>/HEAD`,
   else `main`/`master` on that remote. The **base commit** is `<party>/<base>`, the
   remote's fetched tip. Without it the slices are `unknown` (`remote_not_fetched`):
   missing tracking data doesn't show what landed, and a local branch can hold
   unpushed work. Landing, packet bases and test links all use that
   one commit, so a stale local `main` can't hide evidence that has landed upstream.
   `gh` is always called with `-R <owner>/<name>` from the party upstream, overriding
   any `gh` default or `GH_REPO`. A merged PR counts only when its `baseRefName` is the
   party's base branch. Repository plans keep today's resolver, unchanged.

4. **Packets carry their destination.** A party packet adds
   `store`, `repo: { party, upstream, checkout }`, the party's base, dependency
   repositories and qualified trailers. A worker started anywhere, such as a fresh
   worktree of the party or another agent harness, can act on the packet alone.

5. **Test links with `git grep` at a named commit.** For landed slices, links are read
   at the party's base commit. For in-progress slices, in both packets and reconcile,
   they are read at the slice's latest trailer commit, which already exists locally
   because it was found that way. A slice that is in progress only through an open PR
   has no such commit. Its links are `not_collected` (`no_local_commit`) rather than
   fetched, since fetching is deferred. Reconcile reads each party's base and every
   in-progress slice's latest commit, and the union counts. The search is
   `git grep -n -E '//[[:space:]]*spec:[[:space:]]*<store-id>:' <commit>`, independent
   of each party's test layout. Results name the repository and commit.

6. **Store selection reuses `specSource`.** Delivery operations resolve `store` to the
   store's root through the same check as reads, run the existing code with that root
   as the plan root, and keep the workspace root for checkouts.

7. **Finishing a store change is a documented step, not automation.** A party merge
   doesn't push to the store's repository, so no workflow can notice it there. After
   the last party slice lands: `specs reconcile --store`, tick the final task (left
   unticked as the holding task), `specs archive --ready --store`, then commit and
   merge in the store's repository. `docs/delivery.md` walks a fictional example end
   to end: a store change with a `site` slice and a `game` slice, plus each party's
   own intra-app change. It names who archives each: party changes by their own
   workflows, the store change by this step.

## Risks / Trade-offs

- [A party squash-merges with a custom message and drops trailers] → Same rule as
  today: keep trailers in the PR description. Party PR enrichment counts it once
  merged into the party's base.
- [The step is forgotten and a finished contract stays active] → `specs archivable
  --store` lists it as `ready`. The `reconcile-change` skill ends by naming the step.
- [A stale checkout under-reports landing] → Party landing counts only the party
  remote's fetched tip, so an unfetched checkout reports `in_progress` or
  `remote_not_fetched` rather than landed. The docs say to fetch party checkouts before
  finishing.

## Migration Plan

Additive for repositories. Store plans are new. Rollback is reverting the change.
