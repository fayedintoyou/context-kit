# Design
## Decisions
Use Markdown and existing hub manifests. Workspace paths resolve from --root, then CONTEXT_KIT_ROOT, then the toolkit checkout for reads. Capture refuses the toolkit checkout and requires explicit root selection.
Keep notes in a reserved inbox, separate from curated documents. Context includes notes only when requested. Filenames are generated and files are created exclusively.
Use workspace-relative skill paths or kit:<skill-name> references. Bundled skills remain maintained with the toolkit.
CLI and MCP call the same validated service functions. MCP root is fixed at startup, never supplied by a tool caller. Writes are hidden unless --allow-write is supplied.
Keep an internal spec port list/read/validate. The OpenSpec adapter invokes the pinned CLI through the current Node executable, with fixed argument arrays and telemetry disabled. Check resolved root metadata. No arbitrary commands from manifests.
Spec sources are either the selected repository, holding specs that live beside its code, or a shared OpenSpec store, holding specs used across repositories. Hubs declare stores with optional `specStores` IDs; callers choose among declared IDs only, and OpenSpec's machine registry maps an ID to a path. Store results must resolve with source `store` and the requested ID. A repository whose OpenSpec config delegates to a store is refused as a repository source, so callers always know which kind of spec they read. Reading references that repositories declare to stores, and cross-repository semantic audits, belong to a follow-up change.
Audit uses strict validation and emits an unassessed checklist, HEAD, dirty state, spec hashes and adapter version. Require a stable snapshot during collection. Empty canonical inventories are explicitly inconclusive. Source normalization is adapter-owned.
## Tradeoffs
Fail-fast workspace validation is intentional for the initial small workspace. Local files are trusted against concurrent hostile mutation; confinement rejects existing symlink escapes but is not an OS sandbox.
Read limits prevent accidental unbounded context. Capture is append-only and not retry-idempotent; callers must not retry a successful capture blindly.
MCP stdio serves local clients only. Phone access requires a later authenticated HTTP deployment.
## Review dispositions
Plan review: accepted scoped inbox, explicit roots, portable skills, path checks, caps and error codes. Deferred operation catalog and review-brief generator. Retained gated MCP capture to exercise a useful shared write path.
Spec review: accepted pinned adapter, fixed MCP root, exact root verification, stable audit identity, stable requirement keys, strict validation and no-canonical-specs status. Use a weekly audit artifact plus push/PR checks: structural checks and snapshot collection are automated; semantic review remains explicitly unassessed.
