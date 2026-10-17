# Proposal

## Why

Hubs report OKF trust and `stale_after`, but an agent still has to decide on each read whether to trust a concept as written, check it against its sources, or regenerate it. That decision should be tunable per hub and per kind of knowledge (a metric goes stale in a day, a preference in months) and computed the same way everywhere.

## What Changes

- Hubs may declare a `freshness` policy in `hub.json`: a `default` maximum age and per-`type` maximum ages as ISO 8601 durations.
- Every read (browse, read, context, search) reports `freshness`: `refresh` when `stale_after` has passed, `verify` when the concept is older than its policy age since it was last verified (or generated, when never verified), otherwise `read`, each with a reason and, when applicable, the instant it became or becomes due.
- Concepts with no matching rule and no `stale_after` are read directly.
- Out of scope: performing verification or regeneration (wiki upkeep), and workspace-wide policies.

## Capabilities

### New Capabilities
- `freshness-policy`: per-hub, per-type freshness policies and the read/verify/refresh decision.

### Modified Capabilities
None.

## Impact

`lib/hubs.mjs` (manifest field), `lib/okf.mjs` (decision), `lib/navigate.mjs` and `lib/workspace.mjs` (reporting), the `knowledge` help topic and docs/format.md, tests. No new dependencies.
