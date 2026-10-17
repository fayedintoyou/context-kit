# Proposal

## Why

An accepted OpenSpec change describes a target state. I rarely reach it in one
PR, and I don't want to. Large changes should land as several independently
reviewable PRs, often built in parallel by agents on separate worktrees. Today
the change is a blob that is either archived or not. Nothing records which
requirements have landed, which PR is building what, or what can safely start
next. Agents rebuild that picture from git history and guess, and "implement
this proposal" tends to produce one giant, dangerous diff.

Garden asks whether canonical truth is well organized after archive. A
different question comes before archive: did we build what the proposal says,
and did any PR do work the proposal doesn't cover? These are separate
operations, and the second one is missing.

## What Changes

- **A slice plan in the change.** `openspec/changes/<change>/slices.yaml` splits
  the change into independently mergeable slices. Each slice names the
  requirements of the change it implements, the slices it depends on, and,
  optionally, the paths it is expected to touch. The file records the plan
  only, never status: progress is always derived, so it can't go stale.
- **Landing through commit trailers.** A commit that implements a slice
  carries `OpenSpec-Change: <change>` and `OpenSpec-Slice: <slice>` trailers.
  A slice is `landed` when such a commit is reachable from the base branch,
  and `in_progress` when one exists only on another branch. When `gh` is
  available, open PRs carrying the trailers are named too. Requirement and
  change completion are derived from the slices; there is no "60% complete"
  field.
- **New read-only `specs` operations** (CLI and MCP):
  - `specs status <change>` (`change_status`): each slice is `landed`,
    `in_progress`, `ready` or `blocked`, with its commits, branches and PRs.
    Each requirement in the change's deltas is `landed`, `partial`,
    `in_progress`, `unstarted` or `unplanned`, plus derived totals.
  - `specs next <change>` (`next_slices`): the slices ready to start, meaning
    their dependencies have landed and nobody is working on them. Each comes
    as a work packet.
  - `specs slice <change> <slice>` (`read_slice`): the packet for any slice:
    - its requirements' delta text and scenarios
    - the canonical text they modify
    - its dependencies and their landing commits
    - its declared paths
    - the trailers to use

    This packet is also the brief for an independent reviewer of that slice's PR.
  - `specs reconcile <change>` (`reconcile_change`): facts for checking the
    change against what was built:
    - files changed by each slice's commits outside its declared paths
    - files changed by more than one slice
    - trailer commits naming unknown slices or changes
    - requirements no slice covers
    - the change's scenarios with no linked test, using the `// spec:`
      convention
- **Two new bundled skills in the `specs` addon:**
  - `slice-change` turns an accepted change into a slice plan: small,
    independently mergeable, dependency-ordered. It is validated with
    `specs status`.
  - `reconcile-change` uses the reconcile report and evidence to answer "did we
    build what the proposal says?" Divergence is resolved by amending the
    proposal or splitting work into a new change, never by silently widening
    scope. It also reviews a single slice's PR through `independent-review`,
    using the slice packet as the brief. Once everything is landed and
    reconciled, it suggests archive, and after archive, a garden pass.

This is not a workflow engine. Nothing is stored or enforced beyond the plan.
The operations expose state and dependencies, and agents decide what to do next.

## Capabilities

### New Capabilities
- `change-progress`: slice plans, trailer-based landing, derived status, next
  slices and slice packets, and the reconcile report and skills.

### Modified Capabilities
- None. The `specs` addon gains operations and skills, and its catalog
  requirement already covers listing them. Garden is unchanged: its locks
  already come from active changes.

## Impact

- New: `lib/specs/slices.mjs` (parse and validate `slices.yaml`, derive status)
  and `lib/specs/landing.mjs` (git trailer scan, optional `gh` lookup).
  `lib/specs/deltas.mjs` gains requirement bodies, not only names, for packets.
  `lib/operations.mjs` and `bin/hub.mjs` gain the four operations.
- New skills `skills/slice-change/` and `skills/reconcile-change/`, plus
  `addons/specs/addon.json`, the `specs` help topic and
  `skills/context-kit/references/specs.md`.
- `docs/delivery.md` (new): the lifecycle (slice, land, reconcile, archive,
  garden) and the trailer rule. This repository dogfoods it: this change ships
  its own `slices.yaml`, and its commits carry the trailers.
- No new dependencies. Uses the `git` CLI, and `gh` only when present.
