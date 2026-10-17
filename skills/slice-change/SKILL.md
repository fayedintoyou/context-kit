---
name: slice-change
description: Split an accepted OpenSpec change into independently mergeable slices with dependencies, written as the change's slices.yaml. Use when an accepted change is too large for one PR, or before handing its work to several agents.
---

# Slice a change

A slice is the unit of one reviewable PR. The change's deltas say what should
eventually be true; the plan says which independently mergeable steps get there.
Write only `openspec/changes/<change>/slices.yaml`. Never edit the deltas,
proposal or canonical specs here; if the change itself looks wrong, say so and
use the OpenSpec update flow instead.

Start from the change's deltas: run `specs status <change>` (MCP
`change_status`) to list its requirements as `<capability> / <requirement
name>`. Read the proposal, design and tasks, then the code the change touches.

Shape each slice so that:

- Merging it alone leaves the default branch working and tested.
- It is vertical where possible: a requirement with its tests, not a layer such
  as "all the models" across every requirement.
- Dependencies are only what it truly needs merged first, so independent slices
  can be built in parallel on separate worktrees.
- Every requirement in the deltas is implemented by at least one slice. A
  requirement may be shared by slices that each deliver part of it; it lands
  only when all of them land.
- `paths` lists globs the slice is expected to touch when that is predictable.
  They are a scope hint for reconciliation, not a lock.
- In a shared store's change, every slice names with `repo` the party it lands
  in, as declared in the store's `openspec/parties.yaml`. A repository's slices
  name no `repo`.

```yaml
base: main            # optional; defaults to the remote's default branch
slices:
  - id: storage-model
    title: Store locations with geohash cells
    implements: [location-search / Geo radius query]
    paths: ["src/search/storage/**"]
  - id: graphql-api
    implements: [location-search / Distance ordering]
    depends_on: [storage-model]
```

Ids are lowercase words joined by hyphens. Keep them stable once work starts:
landing evidence is the `OpenSpec-Change` and `OpenSpec-Slice` trailers in
commits and PR descriptions, so renaming a started slice orphans its history.
The plan holds no status; progress is derived on every read.

Validate with `specs status <change>` until it returns without `INVALID_CONFIG`
and no requirement is `unplanned`. Check `specs next <change>` shows the slices
you expect to start first. Keep `tasks.md` as the per-step checklist and group
its steps by slice. Commit the plan with the change and report the dependency
order, which slices can run in parallel, and anything left uncertain.
