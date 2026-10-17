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
stayed in scope. `untested` with `not_collected` means the repository has no
`// spec:` link convention; look for tests yourself.

For each signal, gather evidence from diffs (`git show <sha>`), tests and code,
and record paths, symbols and commits:

- **Out-of-scope or unexplained behavior**: decide whether it belongs to this
  change. If it does, recommend amending the proposal through the OpenSpec
  update flow so the deltas describe it. If not, recommend a separate change.
  Never absorb scope silently by calling it part of the change.
- **Shared files**: check that later slices didn't undo or contradict earlier
  ones.
- **Stray trailers**: a renamed slice, a typo, or work without a plan entry;
  recommend fixing the plan or the PR description.
- **Uncovered requirements**: recommend adding them to a slice with the
  `slice-change` skill.
- **Landed requirements**: check implementation and linked tests against the
  delta text and scenarios, as `audit-canonical-specs` does for canonical
  specs. Classify each as supported, contradicted or uncertain.

To review one slice's PR, get its packet with `specs slice <change> <slice>`
(MCP `read_slice`) and use `independent-review`. Give the reviewer the packet
(requirements with delta and canonical text, dependencies, paths, trailers),
the change's full deltas, the canonical specs it touches, the diff and the
linked tests. Ask: does this PR correctly implement this slice without
violating the rest of the change? The reviewer needs no worker conversation.

Report divergences, gaps and uncertainty with evidence, and say what is ready.
When status shows `readyToReconcile` and nothing unresolved remains, suggest
archiving through the OpenSpec workflow; after archive, suggest a
`garden-canonical-specs` pass on the new canonical truth. Do not archive
yourself unless the user asks.
