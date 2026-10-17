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
   commit for a slice carries these lines (anywhere in the message), and the
   PR description repeats them:

   ```
   OpenSpec-Change: <change>
   OpenSpec-Slice: <slice>
   ```

3. **Review.** Review each PR against its slice with `reconcile-change` and
   `independent-review`, using `specs slice <change> <slice>` as the brief.
4. **Reconcile.** When `specs status` shows `readyToReconcile`, run
   `reconcile-change` on the whole change. Work outside the change becomes a
   proposal amendment or a separate change, never silent scope.
5. **Archive after merge, then garden.** Don't archive in PRs. The `openspec`
   workflow (`.github/workflows/openspec.yml`) runs on every push to the default
   branch. It archives each change whose tasks are all ticked and whose planned
   slices have all landed (`specs archivable` shows which), runs the tests and
   pushes the archive commit. To keep a change open, leave a task unticked. Then
   run `garden-canonical-specs` to keep canonical truth well organized.

Canonical specs change only by archiving a change. On pull requests, the
workflow's `canonical-guard` check fails when `openspec/specs/` is edited
directly; the `canonical-edit` label allows a deliberate exception.

To use the process in another repository, add a caller workflow pinned to a
Context Kit commit:

```yaml
name: openspec process
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
permissions:
  contents: write
jobs:
  openspec:
    uses: fayedintoyou/context-kit/.github/workflows/openspec.yml@<commit>
    with:
      kit: npx --yes --package=github:fayedintoyou/context-kit#<commit> context-kit
      test: npm test
```

and copy the lifecycle paragraph from this repository's `openspec/config.yaml`
context. The job pushes with the workflow token, which doesn't trigger other
workflows, so the archive commit neither loops nor redeploys. If the default
branch is protected, the job needs a token allowed to push to it.

Merge commits and rebases keep commit trailers. GitHub's default squash message
keeps the PR's commit messages too; if you squash with a custom message, keep
the trailers in the PR description and have `gh` installed so merged PRs still
count as landed.

Context Kit dogfoods this: `openspec/changes/change-progress/slices.yaml`
planned the change that added it.
