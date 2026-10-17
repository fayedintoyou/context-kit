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

Specs either live beside a repository's code or in a **shared store** (an
OpenSpec planning repository registered with `openspec store register`). A store
is readable when a hub lists it in `specStores` or the repository references it
under `references:` in its OpenSpec config. Results always name their source and
are never merged.

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
