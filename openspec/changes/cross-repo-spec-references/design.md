# Design

## Context

`local-context-mvp` provides a spec adapter that reads either the selected repository or a hub-declared store and labels results with their source. OpenSpec 1.14.3 records a repository's shared dependencies as `references:` in `openspec/config.yaml` and reports them, with per-store health, from `openspec context --json`. It resolves store paths through its machine registry. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- Show an agent in a repository which shared requirements may apply to it, without claiming that they do.
- Keep audit identity stable and honest across several roots.

**Non-Goals:**
- Deciding whether a referenced requirement applies. That stays a semantic, evidence-backed review.
- Changing how stores are declared to the workspace (`specStores`).

## Decisions

- **Read references through OpenSpec, not our own YAML parsing.** Call `openspec context --json` for the repository and accept only entries it reports. This keeps the reference format, one-level rule, self-reference handling and health diagnostics owned by OpenSpec. Alternative considered: parsing `config.yaml` ourselves, which would drift from OpenSpec's tolerant parser.
- **A repository's references authorize reading those stores.** Declaring a reference in a selected repository is the same kind of owner decision as a hub's `specStores`, so referenced stores need not also appear in a hub. Each store read still goes through the adapter's `--store` path and its source and identity checks.
- **Additive result fields.** `list_specs` on a repository gains `references: [{ storeId, status, specs? }]`. Audit reports gain `referenced: [{ storeId, canonicalHash, checklist }]` and leave existing fields unchanged. Checklist keys are prefixed `store:<id>/<spec>:` so they never collide with the repository's own keys.
- **Snapshot covers every root.** The audit collects the repository and each healthy referenced store twice and fails with `SNAPSHOT_CHANGED` if any hash or git state moved. A referenced store that is unhealthy is recorded as a warning with no checklist.
- **Budget.** Referenced content counts toward the existing audit output budget. Exceeding it fails with `TOO_LARGE` rather than silently truncating a store.

## Risks / Trade-offs

- [OpenSpec store behavior is beta and may change] → Parse its JSON with strict schemas, pin the version, and fail with `ADAPTER_FORMAT` on shape changes.
- [A widely referenced store makes every repository audit large] → Shared output budget plus an explicit `TOO_LARGE` error; narrowing by store is a later option.
- [Local registry paths differ per machine] → Reports carry store IDs and content hashes as identity. Paths are informational only.
