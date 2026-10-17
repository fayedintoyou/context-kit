---
name: garden-canonical-specs
description: Investigate the shape of canonical specs and propose evidence-based splits, moves, merges, renames or clarifications as one reviewed OpenSpec change. Use for spec upkeep or a requested gardening pass.
---

# Garden canonical specifications

Run Context Kit `garden_specs` (MCP), or `context-kit --root <repository> specs
garden`. From a workspace instance, use `npm run hub -- specs garden`. For a
shared store, select a declared store with `--store <id>` and keep that selector
on every subsequent OpenSpec command. Garden one tree at a time. If the report
says `no_canonical_specs`, report that and stop.

Keep findings tied to the snapshot's HEAD, dirty state and canonical hash, the
adapter version and requirement keys shared with `audit_specs`. A dirty tree's
evidence includes working changes; identify the files used. Recheck affected
findings if the tree moves. The deterministic report supplies measurable leads;
it does not decide duplication, cohesion or obsolescence.

Triage oversized or undeclared specs, lexical overlap pairs, history gaps combined
with untested scenarios, and retired names still in use. `not_collected` trace
means there is no recognized link convention, not that behavior lacks tests.
Inspect `historyAmbiguities` before treating empty history as a gap: date-only
archives cannot always distinguish requirements reusing the same name.
For each lead, read the specs, search implementation and tests, and inspect git
history. Record paths, symbols, commits and confidence (high, medium or low).
Discard leads the evidence does not support.

Classify surviving findings as split, move, merge, rename, clarify or candidate
retirement. Skip requirements with `lockedBy`; list them as deferred with the
active change names. Inspect spec-level locks too, so a restructure does not
invalidate an active addition or a pending requirement location. Never edit
`openspec/specs/`. Never move, merge, rename or remove locked requirements.
Ask the user about every candidate retirement, with evidence and uncertainty;
put no retirement in delta specs until the user confirms it. Absence of history
or tests alone is not evidence of obsolescence.

If no actionable finding survives, report the tree healthy at the snapshot,
listing any deferred leads or retirement questions, and stop without creating a
change. Otherwise use the repository's OpenSpec workflow to create exactly one
`garden-<date>` change (for example `garden-2026-10-17`). If that name already
exists, inspect and continue it within scope; do not overwrite unrelated work.
Include a proposal with each finding, evidence, confidence and semantic impact,
delta specs, proposed taxonomy updates and implementation tasks. Keep proposed
`taxonomy.yaml` content inside the maintenance change for review; tasks apply it
to `openspec/taxonomy.yaml` later. Do not rewrite the live taxonomy during triage.

Express a move as `REMOVED` in the source capability and `ADDED` in the target,
with identical requirement text and scenario names. A split is a set of those
moves. A merge keeps one requirement whose text covers both and removes the
other; label it a semantic change. Use `RENAMED` for a requirement rename.
Include tasks to update `// spec: <capability> / <scenario>` links when a scenario
moves; the project's spec-links check must pass after implementation.

If a move or confirmed retirement empties a capability, OpenSpec 1.14.3 refuses
archive without `retire_capabilities: true` alongside `schema: spec-driven` in
the change's `.openspec.yaml`. Include a task for that explicit marker and for
preserving any content archive cannot account for. With the marker and accounted
content, archive deletes the canonical spec and prunes its empty directory;
manual canonical deletion is unnecessary. This skill only proposes those tasks.

Validate with `openspec validate garden-<date> --strict` (including the selected
`--store <id>` when applicable). Resolve validation errors and hand the single
change to the user for review. Use `independent-review` for a large change, giving
the reviewer the original intent, actual deltas and evidence. Do not apply or
archive the change. Report the snapshot, accepted findings, deferred locks,
retirement questions and validation outcome.
