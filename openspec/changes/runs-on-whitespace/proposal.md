# Proposal

## Why

A late independent review of #42 found that the `runs-on` input's list form fails when the JSON has
whitespace before it, as YAML block scalars or careless quoting can leave: `startsWith(inputs.runs-on,
'[')` is false for `' ["self-hosted", "my-mac"]'`, so the whole text becomes one runner label and the
jobs wait for a runner that doesn't exist. The test mirrored the expression in JavaScript instead of
evaluating it, so it couldn't catch this.

## What Changes

- The workflow recognises a list by `contains(inputs.runs-on, '[')`. `fromJSON` accepts surrounding
  whitespace, and a runner label never contains `[`.
- The test evaluates the workflow's expression with GitHub's own evaluator (`@actions/expressions`,
  a dev dependency), including a leading space and line breaks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-archival`: "Jobs where the caller runs them" accepts whitespace around a list.

## Impact

- `.github/workflows/openspec.yml`, `test/e2e/archival.test.mjs`, `package.json` (dev dependency)
