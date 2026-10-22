# Proposal

## Why

Once a slice lands on the default branch, the link check requires its scenarios, judged by the
evidence `specs status` uses. A pull request's branch or merge ref from before that landing
contains neither the slice nor its tests, so its `npm test` fails with only "scenario … has no
linked test". That happened on #67 and on branch-push runs of several pull requests, and re-running
an old `pull_request` run fails the same way because it reuses the old merge ref. Nothing says the
fix is to update the branch.

Making those scenarios pending instead would fail open: trailers can't show the slice's code is
absent from a tree (a branch can rewrite or cherry-pick the landing without trailers and drop its
tests), and squash evidence depends on `gh`, which CI may not have. So the gate stays as it is and
the failure explains itself.

## What Changes

- Which scenarios are required is unchanged.
- When a sliced change's scenario is required only by slices that landed on the base, and HEAD
  reaches none of that landing (no trailer commit naming the slice, no merge commit of a merged
  pull request naming it), the failure says what is known: `… has no linked test — slice <x> has
  landed on <base>, but this tree has no record of that landing; if the branch is behind <base>,
  update it (rebase/merge <base>) and re-run; otherwise link the test`, and `npm run spec-links`
  marks the scenario `no landing record`. It doesn't conclude the branch is behind: a tree may
  carry the code through an amended or cherry-picked commit without trailers. A merged pull
  request whose merge commit `gh` doesn't give gets no such hint.
- `docs/delivery.md`: after a slice lands, update open pull requests' branches before landing them;
  re-running an old `pull_request` run reuses its old merge ref.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-progress`: new requirement "Test links name a landing the tree has no record of".

## Impact

- `lib/specs/links.mjs`, `lib/specs/landing.mjs` (`behindSlices`; merged pull requests keep their
  merge commit), `scripts/spec-links.mjs` (the `no landing record` mark)
- `docs/testing.md`, `docs/delivery.md`
- `test/e2e/spec-links.test.mjs`
