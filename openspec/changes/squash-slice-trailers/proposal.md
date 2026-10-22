# Proposal

## Why

A slice lands when a commit reachable from the base carries its `OpenSpec-Change` and
`OpenSpec-Slice` trailers, or when `gh` reports a merged pull request whose description carries
them. `pr land` squash-merges by default, and a squash keeps only the message GitHub builds or is
given: a repository whose squash message is the pull request title or description, or one whose
trailers live only in the description, leaves the default branch without the trailers. Its
landing then depends on `gh`. In CI without `gh` auth the slice looks un-landed, so its
scenarios stop being required and their tests could be dropped without failing.

## What Changes

- When `pr land` squash-merges a pull request whose commits or description carry slice trailers,
  it passes `commit_title` (`<title> (#<n>)`) and `commit_message`: the commit messages as
  GitHub lists them, without trailer lines, then one trailer block of each `OpenSpec-Change` and
  `OpenSpec-Slice` line once, then the `Co-authored-by` lines GitHub's own squash message would
  carry (the commits' own, and the authors of commits that aren't the pull request author's).
  The commits come from the compare pinned to the head SHA; the merge stays pinned.
- It writes nothing the pull request doesn't carry: without trailers the merge call is unchanged,
  and rebase and merge commits keep each commit's message, so they get no message either.
- It refuses before posting or merging: `TRAILERS_CONFLICT` when commits or the description name
  slices for different changes, or a slice without a change (a squash counts every slice for
  every change it names); `TRAILERS_INVALID` for a trailer value that isn't an id;
  `EVIDENCE_INCOMPLETE` when the compare lists fewer commits than it counts.
- The result's `merge` names the `trailers` written.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pull-request-landing`: new requirement "Squash merges keep slice trailers".

## Impact

- `lib/landing.mjs`: the pull request's title, body and author and the compare's commits are read
  strictly; the squash message is built and checked in both gate passes.
- `docs/delivery.md`, `skills/context-kit/references/commands.md`
- `test/e2e/landing.test.mjs`
