---
name: reconcile-change
description: Check whether what was built matches an active OpenSpec change, during delivery or before archive, and review one slice's PR against its slice. Use mid-flight, when a change's slices have all landed, or when asked whether a change is done.
---

# Reconcile a change

Reconciling asks "did we build what the change says?" It is not gardening,
which asks after archive whether canonical specs are well organized. Never edit
the change's deltas, proposal or canonical specs while reconciling.

Run `specs reconcile <change>` (MCP `reconcile_change`). It returns the change's
derived status plus facts: files each slice's trailer commits changed outside
its `paths`, files changed by several slices, trailer commits naming unknown or
missing slices, requirements no slice implements, and the change's scenarios no
test links. `scope: unchecked` means the slice declared no paths, not that it
stayed in scope. `status.plan: absent` means no `slices.yaml`, not no planning.
`uncovered` means no slice assignment, not no implementation or tests. For an
unsliced change, check its proposal/design/tasks, deltas, diff and real tests.

Test signals only cover links the parser recognizes: currently `// spec:` links
in `test/**/*.test.mjs` and `test/manual-checks.md`, filtered to attached e2e,
manual or justified unit evidence. For a store's change (`--store <id>`), links
are `// spec: <store-id>:<capability> / <scenario>` in any file a party tracks,
read at each party's base and each in-progress slice's latest commit;
`untested.reads` says what was read and what was not (`checkout_missing`,
`no_local_commit`, ...), and `untested.links` names each link's repository, file,
line and commit. `not_collected` means none were collected;
even a collected `untested` list may miss tests in other layouts. Check the real
runner, scenario links and results before reporting a testing gap.

For each signal, gather evidence from diffs (`git show <sha>`), tests and code,
and record paths, symbols and commits:

- **Out-of-scope or unexplained behavior**: decide whether it belongs to this
  change. If it does, recommend amending the proposal through the OpenSpec
  update flow so the deltas describe it. If not, recommend a separate change.
  Never absorb scope silently by calling it part of the change.
- **Shared files**: check that later slices didn't undo or contradict earlier
  ones. In a store's change, slices and shared files name their `repo`; read
  their diffs in that party's checkout (`git -C <checkout> show <sha>`).
- **Stray trailers**: a renamed slice, a typo, or work without a plan entry;
  recommend fixing the plan or the PR description. A pull request naming two
  sliced changes is a defect even when nothing is stray: its slice lines count
  for both. Recommend splitting it.
- **Uncovered requirements**: for a change with a slice plan, recommend adding
  them to a slice with `slice-change`. Do not invent slices for an unsliced change
  merely to clear this signal.
- **Landed requirements**: check implementation and linked tests against the
  delta text and scenarios, as `audit-canonical-specs` does for canonical
  specs. Classify each as supported, contradicted or uncertain.

To review one slice's PR, get its packet with `specs slice <change> <slice>`
(MCP `read_slice`) and use `independent-review`. Give the reviewer the packet
(requirements with delta and canonical text, dependencies, paths, trailers),
the change's full deltas, the canonical specs it touches, the diff and the
linked tests. Ask: does this PR correctly implement this slice without
violating the rest of the change? The reviewer needs no worker conversation.

A store slice's PR is in its party's repository, not the store's: get its packet
with `specs slice <change> <slice> --store <id>` (MCP `read_slice` with `store`)
and review the PR there, in the checkout and against the party remote and base
the packet names. Check its commits and PR description carry the qualified
trailers (`OpenSpec-Change: <store-id>:<change>`), and judge it against the
store's contract as well as any change the party proposed for its own side.

Report divergences, gaps and uncertainty with evidence, and say what is ready.

Do not archive in a PR. Where the repository calls the `openspec` workflow,
archiving happens after merge once every task is ticked and every slice has
landed (`specs archivable` shows the blockers); make sure the final PR ticks the
remaining tasks, or leaves one unticked to hold the change open. Without the
workflow, suggest archiving after merge through the OpenSpec workflow. After
archive, suggest a `garden-canonical-specs` pass on the new canonical truth.

A store's change is finished by hand: no workflow sees a party merge from the
store's repository. When every slice of a store change has landed (fetch the
party checkouts first), end the report by naming the finishing step: run
`specs reconcile <change> --store <id>`, tick the final task in the store's
`tasks.md`, run `specs archive --ready --store <id>` from the workspace, then
commit and merge the result in the store's repository. Each party's own change
is archived by that party's workflow. `docs/delivery.md` walks through an
example.
