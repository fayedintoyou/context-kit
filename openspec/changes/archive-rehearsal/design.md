# Design

## Decisions

1. **Rehearse by archiving a copy.** The rehearsal copies the root's `openspec/` to a
   temp directory, runs the same archive path as `archiveReady` there for every
   active change, and strictly validates the copy. Reusing the real path means the
   rehearsal can't disagree with the archive.
   *Alternative*: merge deltas in memory and validate them. That would drift from what
   OpenSpec's archive actually writes.
2. **Every active change, readiness ignored.** In a pull request the change is
   unfinished by design: its tasks are unticked and its slices are unlanded. The
   rehearsal answers "will this archive cleanly", not "is it ready". Changes are
   applied in the order `archive --ready` would use, so two changes touching one
   requirement show the combined result.
3. **Issues are attributed to a change.** After each change is applied, the copy is
   validated, and new issues are attributed to that change. The report lists each
   change with its issues (spec, requirement path, message), plus issues already in
   the canonical specs before any change was applied, under `baseline`. Only issues a
   change introduces fail the check.
4. **The workflow job is cheap.** It needs only checkout, Node, `npm ci` and the
   kit, with no tests and no browsers. It runs on every pull request, alongside
   `canonical-guard`.
5. **Stores too.** `--store <id>` rehearses a store's active changes. Store archives
   are run by hand, so the rehearsal is for running before them. The workflow only
   rehearses the calling repository.

## Risks / Trade-offs

- [Two active changes conflict only in combination] → They are applied together in
  archive order, so the rehearsal sees the combination.
- [A change that can't be applied at all, such as MODIFIED on a missing requirement]
  → It is reported as that change's issue, and later changes still rehearse.
