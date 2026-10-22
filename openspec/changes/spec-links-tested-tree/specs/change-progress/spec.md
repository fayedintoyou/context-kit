## ADDED Requirements

### Requirement: Test links name a landing the tree has no record of
When a sliced change's scenario is required only by slices that landed on the plan's base, and HEAD reaches no trailer commit naming such a slice and no merge commit of a merged pull request naming it, the link check SHALL still fail, and SHALL say that the slice has landed on the base but the tree has no record of it, and that a branch behind the base should be updated and the check re-run, and otherwise the test linked.

#### Scenario: Branch behind a landed slice
- **WHEN** branch `work` was cut from `main` before the `storage` slice's trailer commit landed on `main`, or a pull request's detached merge commit into that older `main` is checked out, and no test links the `storage` scenario
- **THEN** the link check fails naming that scenario and says `storage` has landed on `main` but this tree has no record of it, to update a branch that is behind, and otherwise to link the test; after rebasing `work` it fails without that hint, and a branch from `main` that links the test passes

#### Scenario: Landing rewritten out of a branch
- **WHEN** `main` landed `storage` with a test linking its scenario, and a branch replaces that commit with one keeping its code but without its trailers or the test
- **THEN** the link check fails on that branch naming the `storage` scenario, saying this tree has no record of the landing and otherwise to link the test

#### Scenario: Squashed landing without a merge commit
- **WHEN** gh reports a merged pull request naming `storage` with no merge commit, `main` has its squashed commit without trailers, HEAD is `main`, and no test links the `storage` scenario
- **THEN** the link check fails naming that scenario, without saying the tree has no record of the landing
