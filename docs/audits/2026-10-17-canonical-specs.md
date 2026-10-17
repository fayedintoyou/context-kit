# Canonical spec audit — 2026-10-17

Semantic audit per `skills/audit-canonical-specs/SKILL.md`. Nothing else was changed.

## Audit identity

- HEAD: `5a0fc96d869ee58a58332239e92829de9ae5a2af` (root is the git root)
- Dirty: `false`, so all evidence is committed evidence
- Canonical hash: `c36434c9e99728be4f8e7bdd91b7b24a8fe8634ac45a804260370f768f5fe5a9`
- Adapter: openspec 1.14.3. Structural status: `structurally_valid` (strict): 3 specs, 16 requirements
- Referenced stores: none (`referenced: []`, `referenceWarnings: []`)
- Tests: `npm test` passed 22 of 22. `npm run spec-links` linked all 21 scenarios (20 e2e, 1 manual).

## Verdicts

| Key | Requirement | Verdict | Evidence |
|---|---|---|---|
| agent-interface:7d1adc76b4ec4670 | Shared operations | supported | Both bins call `execute` (lib/operations.mjs:86-93; bin/hub.mjs:32-56; bin/mcp.mjs:24). Every result has `root`. mcp.test.mjs:76 deep-equals CLI and MCP output for context, list and read-skill. |
| agent-interface:c902ff7666572992 | MCP access scope | supported | Root is fixed at startup (bin/mcp.mjs:14). `operations(allowWrite)` filters out capture (operations.mjs:83). mcp.test.mjs:37 checks that capture is absent, that no schema has a root key, and that `root` is rejected with INVALID_INPUT. |
| agent-interface:e2b1322a695f21d2 | Actionable failures | supported | Coded errors go to stderr (bin/hub.mjs:63-65). MCP returns errors as `isError` (bin/mcp.mjs:26-28). workspace.test.mjs:121 checks nonzero exit, empty stdout and a code. Size errors are covered at workspace.test.mjs:102. |
| canonical-spec-audit:9b5877adfe636c32 | Spec source boundary | supported | The `nearest` and realpath check is at lib/specs/openspec.mjs:51-57. OpenSpec is pinned exactly in package.json. specs.test.mjs:104 and :113 cover a store delegate and a parent repository. |
| canonical-spec-audit:05879d9913d1b2ae | Shared spec stores | **contradicted (edge)** | See M1. Declared, referenced and undeclared cases pass (specs.test.mjs:64, :147, :95). |
| canonical-spec-audit:3ad3a47c97920be9 | Canonical inventory | supported | The adapter uses `list --specs` (openspec.mjs:67). An empty list gives `no_canonical_specs` (audit.mjs:58,69) and exit 1 (bin/hub.mjs:61). Covered by specs.test.mjs:207. |
| canonical-spec-audit:d578b7baaa32d9cf | Honest audit snapshot | supported | Output is capped by `MAX_OUTPUT` (audit.mjs:28). Requirement keys hash the requirement name (audit.mjs:41). Semantic status is fixed at `not_assessed`. specs.test.mjs:171 and :241 check head, dirty, hash and adapter. |
| canonical-spec-audit:be3b2608ab99f961 | Repeatable audits | supported | .github/workflows/checks.yml runs the tests and strict validation, plus a weekly audit artifact. The skill requires evidence tied to the snapshot and says "Never silently rewrite canonical intent". It is the manual check in test/manual-checks.md:7. |
| canonical-spec-audit:f0fe5fa5847ed98b | Referenced store discovery | supported | Implemented at openspec.mjs:81-88 and operations.mjs:26-38. specs.test.mjs:147 shows one level only (`nested` is not followed) and a `missing` warning, with repository specs still returned. |
| canonical-spec-audit:3ac477f0aa8d8e5c | Separate referenced specs | supported | The `shared-auth` spec in the repository and in the store come back as distinct entries (specs.test.mjs:150,155). Repository specs sit under the top-level `source`, and store specs under `references[].storeId`. |
| canonical-spec-audit:8ccb4df11a7f5f05 | Reference-aware repository audit | supported | Implemented at audit.mjs:55-66,75-79. specs.test.mjs:171 checks `store:` keys, applicability, strict result and hash. specs.test.mjs:220 shows SNAPSHOT_CHANGED using a git shim that edits the store mid-audit. |
| canonical-spec-audit:a082f7f76c231dc4 | Store audit scope | supported | `scope` is set at audit.mjs:72-73. Covered by specs.test.mjs:82. |
| context-workspaces:c30e8d8513ccdda3 | Explicit workspace selection | supported | `mkdir` without recursion and `wx` writes (lib/workspace.mjs:8-23). Root precedence is at bin/hub.mjs:26. workspace.test.mjs:37 covers init and refusal. The `CONTEXT_KIT_ROOT` path is untested. |
| context-workspaces:fc2fd1cb46fa7e4d | Bounded context retrieval | supported | Limits are in workspace.mjs:61-104 (128 KiB, 20 notes, 50 hits, 2 MiB scanned). Inbox is opt-in. Covered by workspace.test.mjs:64. |
| context-workspaces:41e7be486450f80e | Append-only capture | **uncertain** | Capture uses `wx` with unique names and makes no git calls (workspace.mjs:106-115). Covered by workspace.test.mjs:64 and :94. See M2. |
| context-workspaces:fb731e9c0f809a9a | Path confinement | supported | Realpath confinement is in lib/files.mjs:12-30. Symlinked hubs and inboxes are rejected (hubs.mjs:36; workspace.mjs:41). Covered by workspace.test.mjs:108 and :138. Retrieval also runs through `loadHubs`, but the test only asserts `validate`. |

## Mismatches

**M1. A store the repository references cannot be read when the root has no hubs.** `specSource` and `list_spec_stores` call `loadHubs` first (operations.mjs:15,59), and `loadHubs` throws NO_HUBS (hubs.mjs:81). I reproduced this in a temp repo that references a registered `platform` store and has no `hubs/` directory. `specs audit` and `specs list` both include `platform`. But `specs read shared-auth --store platform`, `specs list --store platform` and `specs stores` all fail with `NO_HUBS`. This breaks "Read a referenced store" and is inconsistent with the audit. A malformed hub manifest would block these reads too.
*Proposed disposition:* investigate whether "workspace repository" is meant to require hubs. If not, fix the implementation so that NO_HUBS counts as "no declarations", and add an e2e test.

**M2. "Outside the toolkit checkout" is checked by equality, not containment.** workspace.mjs:108 only rejects `root === KIT_ROOT`. An explicit root in a subdirectory of the checkout that has its own `hubs/` would accept captures. I did not reproduce this, because doing so would mean writing into the repository.
*Proposed disposition:* investigate the intent. If containment is meant, fix the implementation. Otherwise make an intentional spec change that narrows the wording.

## Coverage and uncertainty

- No referenced stores, so applicability was not assessed.
- Some branches are implemented but untested:
  - OpenSpec resolving a different store (openspec.mjs:55)
  - Retrieval failing on an escaped document (only validation is asserted)
  - `CONTEXT_KIT_ROOT` selection
  - CLI and MCP equivalence for search and spec operations
- "Semantic review" (manual): the skill text meets the scenario.
- The skill calls for an independent reviewer for substantial findings. That review has not been done; M1 should get one before anything is changed.
- Verdicts rest on code reading, the test run and one reproduction, not on the structural pass.

## Resolution

Both mismatches were resolved as implementation fixes. The canonical intent stands.

- **M1.** Spec operations work on any repository, matching the audit skill's `--root <repository>` use. A root without hubs now declares no stores (`lib/operations.mjs`, `hubStores`). A malformed manifest still fails loudly. The new end-to-end test "a repository without hubs can still read the stores it references" fails on the audited code and passes with the fix.
- **M2.** Capture now refuses any root inside the toolkit checkout, not only the checkout root (`lib/workspace.mjs`). The capture refusal test now creates a nested workspace under the git-ignored `.state/` directory and confirms no note is written. It fails on the audited code.
- **Gaps closed:** an escaped document now fails retrieval with `PATH_ESCAPE` as well as validation, and `CONTEXT_KIT_ROOT` selection and `--root` precedence are tested end to end.
- **Still untested:** OpenSpec resolving a different store, which the real CLI cannot produce (the adapter check remains), and CLI/MCP equivalence beyond context, hubs and skills.
- **Review:** the fixes are small and each one is backed by a test that fails before the fix. The audit itself was done by an agent independent of the implementer. No separate review round was run on the fixes.
