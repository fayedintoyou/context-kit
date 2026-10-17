# Delivering a change

A change's deltas say what should eventually be true. A pull request is one
independently reviewable step towards it. Progress is derived from git, never
recorded by hand.

```
proposal (target truth) ─accepted→ slices.yaml ─→ PRs, in parallel where independent
   → reconcile ("did we build it?") → archive → canonical specs → garden ("is it well shaped?")
```

1. **Slice.** For a change too large for one PR, write
   `openspec/changes/<change>/slices.yaml` with the `slice-change` skill. Each
   slice names the requirements it implements, its dependencies and optional
   paths. Check it with `specs status <change>`.
2. **Build.** `specs next <change>` returns a packet for every slice that is
   ready. Give a worker one packet: implement this slice, nothing else. Every
   commit for a slice ends with its trailers, and the PR description repeats
   them:

   ```
   OpenSpec-Change: <change>
   OpenSpec-Slice: <slice>
   ```

3. **Review.** Review each PR against its slice with `reconcile-change` and
   `independent-review`, using `specs slice <change> <slice>` as the brief.
4. **Reconcile.** When `specs status` shows `readyToReconcile`, run
   `reconcile-change` on the whole change. Work outside the change becomes a
   proposal amendment or a separate change, never silent scope.
5. **Archive, then garden.** Archive through OpenSpec, then run
   `garden-canonical-specs` to keep canonical truth well organized.

Merge commits and rebases keep commit trailers. GitHub's default squash message
keeps the PR's commit messages too; if you squash with a custom message, keep
the trailers in the PR description and have `gh` installed so merged PRs still
count as landed.

Context Kit dogfoods this: `openspec/changes/change-progress/slices.yaml`
planned the change that added it.
