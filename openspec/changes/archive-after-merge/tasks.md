# Tasks

## 1. Readiness and archiving

- [ ] 1.1 Adapter: `changes()` wrapping `openspec list --json` (name, completed and total tasks) and `archive(name)` wrapping `openspec archive <name> --yes --json`, both rooted like the other commands
- [ ] 1.2 `lib/specs/archival.mjs`: readiness from task counts plus `change-progress` status when a slice plan exists; blockers `no_tasks`, `tasks_incomplete`, `slices_unlanded` (naming slices); link `test/e2e/archival.test.mjs` to "Finished change", "Held open" and "Slices not landed"
- [ ] 1.3 `archivable_changes` (group `specs`, read-only) and `specs archivable`; link "Readiness over MCP" (enabled and `--addons none`)
- [ ] 1.4 CLI-only `archive_ready` / `specs archive --ready`: archive ready changes in name order, strict validation, report archived and skipped, refuse without `--ready`; link "Archive what is finished", "Nothing ready" (hash the tree before and after) and "Archive refused without the flag"

## 2. Workflow

- [ ] 2.1 `.github/workflows/openspec.yml` (`workflow_call`: `kit`, `setup`, `test`): `archive` job on default-branch pushes, `canonical-guard` job on pull requests with the `canonical-edit` override
- [ ] 2.2 `.github/workflows/archive.yml` calling it for this repository with `kit: node bin/hub.mjs`
- [ ] 2.3 Add "Archived on merge" and "Canonical edit in a pull request" to `test/manual-checks.md`, verified by the first run after merge (archives `repo-registry`, `spec-garden` and finished changes) and a throwaway PR that edits a canonical spec

## 3. Process and docs

- [ ] 3.1 `openspec/config.yaml` context: tick tasks as you go, don't archive in PRs, the workflow archives after merge, hold a change open with an unticked task, never edit `openspec/specs/` directly
- [ ] 3.2 `docs/delivery.md` step 5, the `specs` help topic, `commands.md`, troubleshooting, README; `reconcile-change` stops suggesting a manual archive where the workflow is installed
- [ ] 3.3 Run `npm test` and `openspec validate --all --strict`

## Workflow follow-up

- `room`: caller workflow pinned to the merged Context Kit commit with `setup: npx playwright install --with-deps chromium`, `openspec/config.yaml` context, `AGENTS.md` line; its first push archives `richer-room-and-phone-view`
- Create the `canonical-edit` label in both repositories
