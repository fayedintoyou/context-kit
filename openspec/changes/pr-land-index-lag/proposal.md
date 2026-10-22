# Proposal

## Why

`pr land <n> --sha <head> --wait` refused PRs #55 and #56 at once with `CHECKS_MISSING` for
all four expected checks, though every check run had completed successfully on that head; the
same command minutes later merged. Matching an expected Actions check joins its check run
(`/commits/<sha>/check-runs`) to a workflow run (`/actions/runs?head_sha=<sha>`) through the
check suite, and GitHub's `head_sha` listing can lag behind or briefly omit runs. The check
runs were there but couldn't be traced, so they counted as missing, and missing is final even
with `--wait`.

## What Changes

- A check run with an expected entry's name and app whose check suite no listed workflow run
  claims, when no traced run matches, is a distinct transient state, `untraced`, not `missing`.
- Without `--wait` it refuses `CHECKS_UNTRACEABLE`, saying GitHub hasn't indexed the workflow
  run yet and to retry or use `--wait`. With `--wait` it is polled like a pending check until
  traceable or the deadline, then refuses `CHECKS_UNTRACEABLE (timed out waiting)`.
- Unchanged: an untraced run never passes; a check with no run of its name and app, or whose
  runs are all traced to another workflow or event, is `CHECKS_MISSING`; a newer untraceable run
  above a traced match is still `EVIDENCE_INCOMPLETE`; failures still refuse at once.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pull-request-landing`: new requirement "Wait for GitHub to index workflow runs".

## Impact

- `lib/landing.mjs` (`evaluateChecks`, `checksOutcome`, the `--wait` loop)
- `skills/context-kit/references/commands.md` (the refusal code)
- `test/e2e/landing.test.mjs`
