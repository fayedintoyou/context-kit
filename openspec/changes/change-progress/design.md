# Design

## Context

Context Kit's `specs` addon already reads canonical specs through the pinned
OpenSpec CLI. It audits them (`audit_specs`: "does code match canonical
truth?") and gardens them (`garden_specs`: "is canonical truth well shaped?").
`lib/specs/deltas.mjs` parses `ADDED`/`MODIFIED`/`REMOVED`/`RENAMED` headers for
active and archived changes. `lib/specs/links.mjs` parses `// spec:` test links.
`lib/specs/snapshot.mjs` holds the snapshot and requirement keys shared by audit
and garden.

OpenSpec's `tasks.md` is a checklist for the whole change. It has no notion of
independently mergeable units, dependencies or which PR did what, and its
checkboxes are hand-maintained state. OpenSpec ignores extra files in a change
directory and moves the whole directory on archive.

The lifecycle this change fills in:

```
proposal (target truth) ─accepted→ slice plan ─→ PRs (slices, parallel where independent)
   → reconcile ("did we build it?") → archive → canonical → garden ("is it well shaped?")
```

## Goals / Non-Goals

**Goals:**
- An agent can find the next independently mergeable unit of an accepted change,
  and get a self-contained brief for it, without reading anyone's conversation.
- Progress is derived from git (and PRs when available), never stored by hand.
- An independent evaluator can judge one PR against its slice alone.
- Divergence between a change and its implementation is detected before
  archive, not discovered by the gardener afterwards.

**Non-Goals:**
- A workflow engine. Nothing enforces order, claims slices, or blocks merges.
  Dependencies are information.
- Creating branches, worktrees, PRs or commits. Orchestrators (T3, Claude Code,
  people) do that with the packet.
- Applying or archiving the change. The OpenSpec workflow still does that.
- Requirement IDs such as `GEO-004`. OpenSpec has none, and inventing them would
  fork the format. Requirements are named `<capability> / <requirement name>`,
  as in test links.
- Shared stores. A store has no code to land into; `--store` is refused for
  these operations.

## Decisions

1. **Plan in `slices.yaml`, status nowhere.**

   ```yaml
   base: main                       # optional; default: the remote's default branch, else main or master, else current branch
   slices:
     - id: storage-model
       title: Store locations with geohash cells
       implements:
         - location-search / Geo radius query
       paths: ["src/search/storage/**"]    # optional scope hint, globs
     - id: graphql-api
       implements:
         - location-search / Distance ordering
       depends_on: [storage-model]
   ```

   The pasted model kept `status: merged` and `pr: 1432` in the file. That is
   state, and hand-kept state drifts; `tasks.md` checkboxes already prove it.
   Status comes from git instead. Alternative: slices as `tasks.md` sections.
   Rejected because dependencies, requirement lists and paths need structure,
   and `tasks.md` stays the per-step checklist inside a slice.

2. **Validation.** Slice ids match the store-id pattern and are unique.
   `depends_on` names existing slices and has no cycle. Every `implements` entry
   names a requirement in this change's `ADDED`, `MODIFIED`, `REMOVED` or
   `RENAMED` (target name) deltas; removals need implementing too. `paths` are
   relative globs without `..`. Any violation fails with `INVALID_CONFIG`
   naming the file and the problem, like the taxonomy file. A requirement may
   be implemented by several slices, and it is landed only when all of them
   have landed.

3. **Landing evidence: commit trailers.**
   `git log <base> --format=%H%x00%cI%x00%(trailers:key=OpenSpec-Change,valueonly)%x00%(trailers:key=OpenSpec-Slice,valueonly)`.
   A slice is `landed` when a commit reachable from `base` (or its `origin/`
   remote-tracking branch, so landing doesn't wait for a pull) carries both
   trailers. Without a planned base, the remote's default branch is used, then
   `main` or `master`. The current branch is the last resort, because a
   checked-out feature branch must not count as the base.
   It is `in_progress` when such commits exist only on other local or
   remote-tracking branches; `git for-each-ref` names those branches. Trailers
   survive merge commits and rebases. For squash merges, GitHub's default
   squash message keeps the PR's commit messages, so their trailers survive.
   The packet tells workers to also put the trailers in the PR description for
   repositories that squash with the PR body. Alternative: read PR state from
   GitHub only. Rejected as the primary source because it needs the network
   and auth, and e2e tests could not drive it. Alternative: tags or a status
   file. Rejected as stored state.

4. **PRs as optional enrichment.** If `gh` is on PATH and the repository has a
   GitHub remote, `gh pr list --state all --json
   number,state,headRefName,body,url` adds PRs whose body or head-branch
   commits carry the trailers. An open PR makes a slice `in_progress` even
   when its branch isn't fetched locally. When `gh` is missing, unauthenticated
   or fails, `pullRequests` is `not_collected` with the reason, and git
   evidence still decides `landed`. Tests use a fake `gh` on PATH. It is an
   external boundary, which `docs/testing.md` allows.

5. **Derived states.**
   - Slice: `landed`; else `in_progress`; else `ready` if every dependency is
     landed; else `blocked`, listing the unlanded dependencies.
   - Requirement: `landed` when all covering slices have landed; `partial` when
     some have; `in_progress` when none has landed but at least one is in
     progress; `unstarted`; or `unplanned` when no slice covers it.
   - Change totals: slices landed out of total, requirements landed out of
     total. `readyToReconcile` is true when every requirement is landed.
   - Without `slices.yaml`, the plan is `absent` and every requirement is
     `unplanned`. `next` returns nothing with `reason: no_plan`.

6. **Packets.** `read_slice` returns:
   - `change` and `slice` (id, title)
   - `base` and its commit
   - `requirements`: each requirement's delta text and scenarios, plus the
     current canonical text when the delta modifies, removes or renames it
   - `dependencies` with their landing commits
   - `paths`, if declared
   - the exact trailers
   - `review`: the inputs an evaluator needs
     - for a landed or in-progress slice: the git range or PR to diff
     - the linked tests for its scenarios

   `next_slices` returns `ready` slices as packets, so several workers can start
   in parallel. It does not claim them: two orchestrators can pick the same
   slice, and the second one sees it `in_progress` once the first pushes.

7. **Reconcile report.** Facts only:
   - `outOfScope`: per slice, files changed by its trailer commits (the union of
     `git show --name-only`, excluding the change directory itself) that match
     none of its `paths`. Empty when `paths` is undeclared, with
     `scope: unchecked`.
   - `sharedFiles`: files changed by more than one slice.
   - `strayTrailers`: commits naming this change with an unknown slice id.
   - `uncovered`: requirements no slice implements.
   - `untested`: scenarios in this change's deltas that no test links, via
     `links.mjs`, or `not_collected` when the repo has no links.
   - `status`: the `change_status` result, so one call has everything.

   Whether out-of-scope work is legitimate is the skill's call.

8. **Skills, separate from garden.**
   - `slice-change` produces a plan:
     - Each slice is independently mergeable and leaves the main branch
       working.
     - Prefer vertical slices that each carry their own tests over layer-wide
       slices.
     - Keep dependencies minimal so slices can run in parallel.
     - Every requirement is covered.
     - Add `paths` where they are predictable.

     It validates with `specs status` and commits the plan with the change, and
     it never edits deltas.
   - `reconcile-change` is used mid-flight or before archive:
     1. Run `reconcile_change`.
     2. For each signal, gather evidence: diffs, tests, code.
     3. For out-of-scope behavior, recommend amending the proposal (through the
        OpenSpec update flow) or proposing a separate change. Never silently
        absorb it.
     4. For each landed requirement, check that the implementation and its
        linked tests meet the delta. This is the `audit-canonical-specs` method
        applied to the target state.
     5. Report divergences, gaps and readiness.

     For one slice's PR, it hands `independent-review` the slice packet, the
     canonical baseline, the change's full deltas, the diff and the tests. It
     asks whether the PR correctly implements this slice without violating the
     rest of the change. When everything is landed and reconciled, it suggests
     archiving. After archive, it suggests `garden-canonical-specs`.

9. **Dogfooding.** This change ships `slices.yaml`, and its implementation
   commits carry the trailers. `specs status change-progress` is the first real
   test of the feature.

## Risks / Trade-offs

- **Forgotten trailers.** Commits without them land invisibly. The packet
  prints the exact trailers. Commits that touch a slice's `paths` but carry no
  trailers could be reported as a hint later; that is left out to avoid
  guessing.
- **Squash merges with custom messages drop trailers.** Then the PR body
  carries them, and `gh` enrichment can still mark the slice landed through
  the PR's `MERGED` state. Without `gh`, it stays `in_progress` until the
  branch is deleted, and then reads as `ready`. Document this: repositories
  that squash should keep commit messages or have `gh` available.
- **Renamed slices** lose their history. Slice ids are stable once work
  starts. The skill says so, and `strayTrailers` makes a rename visible.
- **Large repositories.** `git log` over the base is bounded by `--grep` on
  `OpenSpec-Change: <change>` before parsing trailers.

## Open Questions

- Should garden's report show slice progress for its `lockedBy` changes?
  Leaning no; `change_status` is one call away.
- Should `next_slices` accept a `--claim` that writes a local claim file to
  stop duplicate pickup between agents on one machine? Deferred: it is state,
  and orchestrators already track their own tasks.
