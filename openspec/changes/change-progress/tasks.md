# Tasks

Slices are in `slices.yaml`. Every implementation commit carries
`OpenSpec-Change: change-progress` and `OpenSpec-Slice: <id>` trailers.
`packets` and `reconcile` can be built in parallel once `landing` lands.

## 1. Slice `plan`

- [x] 1.1 `lib/specs/slices.mjs`: read `openspec/changes/<change>/slices.yaml` (zod; ids with `storeIdSchema`'s pattern; unique; `depends_on` known and acyclic; `implements` resolved against the change's deltas via `deltas.mjs`, `RENAMED` by target name; `paths` relative globs without `..`), `INVALID_CONFIG` naming the file and problem; refuse unknown or archived change names with `NOT_FOUND`
- [x] 1.2 Status skeleton with no landing evidence (every slice `ready` or `blocked`, every requirement `unstarted` or `unplanned`, plan `absent`); link `test/e2e/progress.test.mjs` to "Valid plan", "Invalid plan" and "No plan"

## 2. Slice `landing`

- [x] 2.1 `lib/specs/landing.mjs`: resolve base (plan, else `origin/HEAD`, else `main` or `master`, else current branch; local and `origin/` copies both count); `git log --grep` + trailer parsing for landed commits; `git for-each-ref` over local and remote-tracking branches for in-progress commits; link `test/e2e/progress.test.mjs` to "Partly delivered change" and "Requirement covered by two slices" (temporary git repos with trailer commits, no network)
- [x] 2.2 Optional `gh pr list --state all --json number,state,headRefName,body,url`; `not_collected` with reason when missing or failing; link `test/e2e/progress.test.mjs` to "Open pull request" (fake `gh` on PATH) and "GitHub CLI missing"
- [x] 2.3 `change_status` in `lib/operations.mjs` (group `specs`, read-only, `{ change }`, store refused), `specs status <change>` in `bin/hub.mjs`, usage line; link `test/e2e/progress.test.mjs` to "Status over MCP" (enabled and `--addons none` workspaces)

## 3. Slice `packets`

- [x] 3.1 `deltas.mjs` returns requirement bodies and scenarios; packets add canonical text via the OpenSpec adapter for modified, removed and renamed requirements
- [x] 3.2 `next_slices` / `specs next` and `read_slice` / `specs slice`, with trailers and review inputs; link `test/e2e/progress.test.mjs` to "Parallel ready slices", "Packet for a modified requirement" and "Nothing ready"

## 4. Slice `reconcile`

- [x] 4.1 `reconcileChange` in `lib/specs/progress.mjs`: `outOfScope` (glob match against `paths`, `unchecked` without them, change directory excluded), `sharedFiles`, `strayTrailers`, `uncovered`, `untested` via `links.mjs`, embedded status
- [x] 4.2 `reconcile_change` / `specs reconcile`; link `test/e2e/progress.test.mjs` to "Out-of-scope file", "Stray trailer" and "Untested change scenario"

## 5. Slice `skills-docs`

- [x] 5.1 `skills/slice-change/SKILL.md` per design decision 8 (vertical, independently mergeable slices; minimal dependencies; full coverage; stable ids once work starts; never edits deltas)
- [x] 5.2 `skills/reconcile-change/SKILL.md` per design decision 8 (evidence per signal; amend or split, never absorb; slice review through `independent-review` with the packet; archive then garden)
- [x] 5.3 Add both to `addons/specs/addon.json`; link `test/e2e/addons.test.mjs` to "Specs addon lists the delivery skills"; add "Divergence is surfaced, not absorbed" to `test/manual-checks.md`
- [x] 5.4 `docs/delivery.md` (lifecycle and trailers, including the squash-merge caveat), `specs` help topic, `skills/context-kit/references/specs.md`, `docs/next.md`
- [x] 5.5 Run `npm test`, `openspec validate change-progress --strict`, and `specs status change-progress` / `specs reconcile change-progress` on this repository

## Workflow follow-up

- Reconcile this change with `reconcile-change`, archive it, then run `garden-canonical-specs`
- Upgrade `~/context`'s pin and run `agents install`
