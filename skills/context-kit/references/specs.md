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
| Change progress | `specs status <change>` | `change_status` |
| Next slices to build | `specs next <change>` | `next_slices` |
| One slice's packet | `specs slice <change> <slice>` | `read_slice` |
| Reconcile a change | `specs reconcile <change>` | `reconcile_change` |
| Changes ready to archive | `specs archivable` | `archivable_changes` |
| Archive ready changes (no commit) | `specs archive --ready` | CLI only |

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

An invalid file (bad YAML, party name or upstream, a shared upstream, an
undeclared party, a contract with fewer than two parties, or a contract spec
that is neither canonical nor added by an active change) fails `specs parties`
and `specs list --store <id>` with `INVALID_CONFIG` naming the file and the
problem. Renaming or removing a contract spec in a change means updating
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
otherwise `blocked`. Requirements are `landed`, `partial`, `in_progress`,
`unstarted` or `unplanned`. Pull requests come from `gh` when it is installed
and authenticated; otherwise they are `not_collected` and git decides.
Repositories that squash-merge with custom messages should keep the trailers in
the PR description and have `gh` available.

`specs next` returns a packet for every ready slice: requirements with delta
text and the canonical text they replace, landed dependencies, paths and the
exact trailers. It does not claim slices. `specs slice` returns any slice's
packet, adding commits, branches, PRs and linked tests to review once it has
started. `specs reconcile` lists out-of-scope files per slice, files shared by
slices, stray trailers, uncovered requirements and unlinked scenarios. The
`reconcile-change` skill judges them and reviews one slice's PR through
`independent-review`. These operations read the workspace repository only, not
stores.

## Archiving after merge

A change is ready to archive when OpenSpec counts every task ticked and, with a
slice plan, every slice has landed. `specs archivable` lists each active change
with `ready` or its blockers: `no_tasks`, `tasks_incomplete` (an unticked task
also holds a change open on purpose), `slices_unlanded` (naming the slices) or
`invalid_plan`. `specs archive --ready` archives exactly the ready changes
through the pinned OpenSpec CLI, validates canonical specs strictly and reports
`archived` and `skipped`. It never commits and is not offered over MCP.

The reusable `.github/workflows/openspec.yml` runs this on every push to the
default branch, tests the result and pushes the archive commit, and on pull
requests fails when `openspec/specs/` is edited directly unless the PR has the
`canonical-edit` label. See `docs/delivery.md` for the caller workflow.
