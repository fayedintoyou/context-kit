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

## Choosing `repo` in a store's change

A store holds no code, so each slice is one PR in one party's repository. Run
`specs parties --store <id>` for the parties and contracts, then for each
requirement ask which party has to change for it to become true:

- A requirement one party implements is that party's slice.
- A requirement both sides of a contract implement (a host and its guest) gets
  one slice per party, each implementing it; it lands when both have.
- Order slices across parties by what each needs merged first, often the side
  that accepts a call before the side that makes it. A party slice can depend
  on another party's slice.
- `paths` are paths in that party's repository. When the party also proposes its
  own change for the app-internal detail and the same PR implements it, include
  that change's directory (`openspec/changes/<its-change>/**`).

The commits and PR description of a store slice carry the store-qualified
change id, which `specs next|slice --store <id>` packets give exactly:

```
OpenSpec-Change: <store-id>:<change>
OpenSpec-Slice: <slice>
```

An unqualified `OpenSpec-Change: <change>` is the party's own change and never
counts for the store's. Party tests link the store's scenarios as
`// spec: <store-id>:<capability> / <scenario>`.

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

Validate with `specs status <change>` (with `--store <id>` for a store's
change) until it returns without `INVALID_CONFIG`
and no requirement is `unplanned`. Check `specs next <change>` shows the slices
you expect to start first. Keep `tasks.md` as the per-step checklist and group
its steps by slice. Commit the plan with the change and report the dependency
order, which slices can run in parallel, and anything left uncertain.
