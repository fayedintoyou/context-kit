# Specs (specs addon)

Reads canonical OpenSpec specs through the pinned OpenSpec CLI. Pending change
deltas are not canonical.

| Task | CLI | MCP tool |
|---|---|---|
| List specs | `specs list [--store <id>]` | `list_specs` |
| Read one | `specs read <spec-id> [--store <id>]` | `read_spec` |
| Structural audit | `specs audit [--store <id>]` | `audit_specs` |
| Garden spec structure | `specs garden [--store <id>]` | `garden_specs` |
| Readable shared stores | `specs stores` | `list_spec_stores` |
| A store's parties and contracts | `specs parties --store <id>` | `list_parties` |
| Change progress | `specs status <change> [--store <id>]` | `change_status` |
| Next slices to build | `specs next <change> [--store <id>]` | `next_slices` |
| One slice's packet | `specs slice <change> <slice> [--store <id>]` | `read_slice` |
| Reconcile a change | `specs reconcile <change> [--store <id>]` | `reconcile_change` |
| Changes ready to archive | `specs archivable [--store <id>]` | `archivable_changes` |
| Archive ready changes (no commit) | `specs archive --ready [--store <id>]` | CLI only |

Specs either live beside a repository's code or in a **shared store** (an
OpenSpec planning repository registered with `openspec store register`). A store
is readable when a hub lists it in `specStores` or the repository references it
under `references:` in its OpenSpec config. Results always name their source and
are never merged.

## Parties and contracts

A store may declare its **parties**, the repositories its specs bind, in
`openspec/parties.yaml`, and which specs are **contracts** between them
(fictional example):

```yaml
parties:
  site: https://github.com/example/site
  game: https://github.com/example/game
contracts:
  game-embedding: [site, game]
```

Party names are lowercase words joined by hyphens; upstreams are git URLs
(`https://github.com/<owner>/<name>`, SSH, ...), compared as `repos` compares
them, and two parties can't share one. A contract lists two or more declared
parties and names a canonical spec of the store (`canonical`) or a spec an
active change of the store adds (`proposed`), so a contract can be declared in
the change that creates it. `specs parties --store <id>` (`list_parties`) returns
the parties and contracts with the store as source; a store without the file
has none. Parties belong to stores: without a store the call fails with
`INVALID_INPUT`, and a repository's own `openspec/parties.yaml` is never read.

Store specs are labelled with their contract: `specs list --store <id>` and
`specs read <spec-id> --store <id>` give each spec `contract: { parties: [...] }`
when the parties file names it, otherwise `contract: null`. When a repository's
`specs list` includes a referenced store, each of that store's specs also
carries `party`: the contract party whose upstream matches any of the
repository's git remotes (SSH and HTTPS forms match), or `null` when it plays
none, isn't a git checkout, or the spec is no contract (`contract: null`). When
its remotes match more than one party of a contract (say `origin` is one party
and `upstream` another), it plays the first of them in the contract's listed
order. Remotes come from the git checkout containing the repository, which for
an OpenSpec root nested in a larger repository is the outer one. The
repository's own specs carry neither field.

An invalid file (bad YAML, party name or upstream, a shared upstream, an
undeclared party, a contract with fewer than two parties, or a contract spec
that is neither canonical nor added by an active change) fails `specs parties`,
`specs list --store <id>` and `specs read --store <id>` with `INVALID_CONFIG`
naming the file and the problem. In a repository's listing, a referenced store
with an invalid file becomes a `warning` reference carrying that issue, and the
repository's own specs are still listed. Renaming or removing a contract spec in a change means updating
`parties.yaml` in the same change.

## Audits and gardening

Audits are structural only: strict validation, HEAD, dirty state and content
hashes, and a requirement checklist marked `not_assessed`. Referenced stores get
their own checklist with applicability `not_assessed`. For the evidence-based
semantic review, use the `audit-canonical-specs` skill.

Run against another repository with `context-kit --root <repository> specs ...`.

Gardening is read-only. Its report shares the audit's snapshot and requirement
keys, with spec sizes, archived requirement history (including renames), active
change locks, lexical overlap pairs, and scenario trace from `// spec:` links.
Overlap is a lead to investigate, not a semantic verdict. `historyAmbiguities`
names reused requirements whose same-day archive entries cannot be assigned to
a lineage; those disputed entries are omitted from definitive history. The highest scores are
kept when the output budget truncates the list (`truncated: true`). With no link
convention, or when reading a store, trace is `not_collected` and `untested` is
null. Store gardening reads only that store's history and locks.

Optionally declare intended domains in `openspec/taxonomy.yaml`:

```yaml
limits: { maxRequirements: 12, maxLines: 300, overlapThreshold: 0.35 }
domains:
  location-search:
    purpose: Finding locations by text, radius and filters.
    limits: { maxRequirements: 20 }
retired: [locations-platform]
```

Limits resolve from domain overrides, taxonomy defaults, then built-in defaults;
the report states each spec's applied limits. Identifiers use lowercase words or
numbers joined by hyphens (up to 64 characters). Invalid YAML, identifiers or
limits fail with `INVALID_CONFIG` naming the file and problem. Without the file,
domains are `unchecked`; otherwise taxonomy lists undeclared specs, empty domains
and retired names still in use.

Use `garden-canonical-specs` to investigate the signals against code, tests and
git history. It defers locked requirements and proposes one `garden-<date>`
change, or none when healthy. It asks about candidate retirements and never
rewrites canonical specs. Review and archive maintenance through the ordinary
OpenSpec lifecycle.

## Delivering a change in slices

An accepted change can be split into independently mergeable slices in
`openspec/changes/<change>/slices.yaml`: each slice names the change
requirements it implements (`<capability> / <requirement name>`), the slices it
depends on and optional path globs. The plan holds no status. Use the
`slice-change` skill to write one; invalid plans fail with `INVALID_CONFIG`.

Commits that implement a slice carry these lines anywhere in the message, and
PR descriptions repeat them:

```
OpenSpec-Change: <change>
OpenSpec-Slice: <slice>
```

`specs status` derives each slice's state on every call: `landed` when a trailer
commit is reachable from the base branch (the plan's `base`, else the remote's
default branch, else `main` or `master`; a local branch and its `origin/` copy
both count) or its PR merged; `in_progress` when trailer commits exist only on
other branches or a PR is open; `ready` when its dependencies have landed;
`unknown` when its evidence can't be read (a store slice whose party has no
recorded checkout, or whose checkout has no remote for the party upstream);
otherwise `blocked`. Requirements are `landed`, `partial`, `in_progress`,
`unstarted` or `unplanned`; an `unknown` covering slice counts as not landed,
so a requirement with nothing landed or in progress is `unstarted`. Pull
requests come from `gh` when it is installed and authenticated; otherwise they
are `not_collected` and git decides.
Repositories that squash-merge with custom messages should keep the trailers in
the PR description and have `gh` available.

`specs next` returns a packet for every ready slice: requirements with delta
text and the canonical text they replace, landed dependencies, paths and the
exact trailers. It does not claim slices. `specs slice` returns any slice's
packet, adding commits, branches, PRs and linked tests to review once it has
started. `specs reconcile` lists out-of-scope files per slice, files shared by
slices, stray trailers, uncovered requirements and unlinked scenarios. The
`reconcile-change` skill judges them and reviews one slice's PR through
`independent-review`.

These operations read the workspace repository's changes. With `--store <id>`
(`store` over MCP) they read a change planned in a shared store instead, under
the same rule as spec reads: the store must be declared by a hub or referenced
by the repository, otherwise the call fails with `UNKNOWN_STORE`. The store's
root is then the plan root, and results carry `source: { kind: "store", storeId }`.
A store with no slice plan is judged by its own git history. Without a store,
results are as before and carry no `source`.

A store holds no code, so every slice of a store's change names with `repo` the
party it lands in, one the store's `openspec/parties.yaml` declares:

```yaml
slices:
  - id: game-embed
    repo: game
    implements: [game-embedding / Embed handshake]
  - id: site-embed
    repo: site
    implements: [game-embedding / Embed handshake]
    depends_on: [game-embed]
```

`specs status <change> --store <id>` then gives each slice
`repo: { party, upstream, checkout }`. A store slice with no `repo` or with a party the
store doesn't declare (or a store with no parties file) fails with
`INVALID_CONFIG` naming `slices.yaml` and the slice, and so does a repository
plan whose slice names any `repo`: a repository's slices land in the repository
itself. A plan is a store's when the store is selected with `--store`, or when
its root is the store itself (`--root <store>`), which carries OpenSpec's
`.openspec-store/store.yaml`.

### Party evidence

A store holds no code, so a store slice is judged only in its party's
repository. Its commits and PR descriptions carry the store-qualified change id:

```
OpenSpec-Change: <store-id>:<change>
OpenSpec-Slice: <slice>
```

A party's own `<change>` of the same name, or another store's
`other:<change>`, never counts for it, and is neither its evidence nor a stray
trailer. Packets give the qualified trailers.

Evidence comes from the party's checkout as the workspace records it (the
`--root` the CLI or MCP server runs with), looked up by the party upstream
whether or not a hub registers it; record one with `repos locate` or
`repos clone`, which need the upstream registered as a Repository concept
(`repos add`). Nothing is fetched: fetch party checkouts before judging a
change finished. Inside the checkout:

- the **party remote** is the remote whose URL matches the party upstream
  (SSH and HTTPS forms match), never `origin` by assumption, so a fork's
  `origin` is ignored. A checkout with no such remote says nothing about the
  party: its slices are `unknown`, never judged from local branches;
- the **base branch** is the plan's `base`, else that remote's default branch
  (`refs/remotes/<remote>/HEAD`), else `main` or `master`;
- the **base commit** is that remote's tip of the branch, else the local
  branch when the remote has none (not yet fetched). Only it counts as landed, so a stale local `main` can't hide what
  landed upstream, and a commit not yet pushed is `in_progress`. Packets use it
  as their base.

Pull requests are read with `gh pr list -R <owner>/<name>` from the party
upstream (overriding any `gh` default or `GH_REPO`). A PR belongs to a slice
only when its description carries `OpenSpec-Change: <store-id>:<change>` and
the slice's `OpenSpec-Slice`; its head branch name alone never associates it,
since a fork and its upstream can share branch names for unrelated work. A
merged one lands its slice only when it merged into the party's base branch; either way it is named
with its `baseRefName` and `landed`. A merged PR into another branch leaves the
slice `in_progress`.

A store plan's status has no single `base` or `pullRequests`; `repos` lists
each party the plan names with its `upstream`, `checkout`, `remote`, `base` and
`pullRequests`. A party with no recorded checkout has `checkout: null` and
`reason: "checkout_missing"`, and its slices are `unknown` with that reason and
`remedies` (`repos locate <repository> <path>`, `repos clone <repository> [<path>]`,
naming the registered repository when there is one). A party whose checkout
has no remote matching its upstream has `reason: "remote_missing"`, and its
slices are `unknown` with that reason and `remedies`
(`git -C <checkout> remote add <remote> <upstream>`, `git -C <checkout> fetch <remote>`).
Either way they never look `ready`
or `landed`: their dependents are `blocked`, the requirements they cover are
not `landed`, and `specs next` offers no packet for them.

## Archiving after merge

A change is ready to archive when OpenSpec counts every task ticked and, with a
slice plan, every slice has landed. `specs archivable` lists each active change
with `ready` or its blockers: `no_tasks`, `tasks_incomplete` (an unticked task
also holds a change open on purpose), `slices_unlanded` (naming the slices) or
`invalid_plan`. `specs archive --ready` archives exactly the ready changes
through the pinned OpenSpec CLI, validates canonical specs strictly and reports
`archived` and `skipped`. It never commits and is not offered over MCP. Both
take `--store <id>` to read and archive a store's changes in the store's root.

The reusable `.github/workflows/openspec.yml` runs this on every push to the
default branch, tests the result and pushes the archive commit, and on pull
requests fails when `openspec/specs/` is edited directly unless the PR has the
`canonical-edit` label. See `docs/delivery.md` for the caller workflow.
