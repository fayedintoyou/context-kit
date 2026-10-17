# Proposal

## Why

OpenSpec's archive step turns change history into current truth: deltas merge into
`openspec/specs/` and the change moves to the archive. Nothing turns current truth
into well-factored truth. Over time, capabilities accumulate requirements that
belong elsewhere, two specs describe the same behavior in different words, a spec
grows into a junk drawer, and requirements outlive the code they described.
`audit_specs` asks "does the code do what the specs say?" Nobody asks "are the
specs still shaped well?"

Asking an agent to "clean up the specs" gives vague, unrepeatable results, and
an agent that edits canonical specs directly skips the review that makes them
trustworthy. I want the same split the audit already uses: a deterministic
scanner that reports measurable signals with provenance, and a skill that
interprets them and proposes structural changes as an ordinary OpenSpec change,
which I review and archive like any other.

## What Changes

- New read-only operation `specs garden [--store <id>]` (MCP `garden_specs`) in
  the `specs` addon. It reports, for the canonical tree, against the same snapshot
  the audit uses (HEAD, dirty, canonical hash):
  - **Size**: lines, requirements and scenarios per spec, plus requirements with
    no scenarios, flagged against limits.
  - **History**: for each requirement, the archived changes that added, modified
    or renamed it, and the date of the most recent one.
  - **Locks**: active changes whose deltas touch a spec or requirement. The
    gardener must not restructure locked requirements.
  - **Overlap**: requirement pairs whose normalized wording overlaps above a
    threshold, within and across specs, labeled `lexical`. They are leads to
    investigate, not proof of duplication.
  - **Trace**: when the repository links tests to scenarios with
    `// spec: <capability> / <scenario>` (Context Kit's own convention), the
    scenarios with no linked test. Otherwise `not_collected`.
  - **Taxonomy**: when `openspec/taxonomy.yaml` declares the intended capability
    domains, specs it doesn't declare, declared domains with no spec, and retired
    names still in use.
- New bundled skill `garden-canonical-specs` in the `specs` addon. It runs the
  report, investigates the signals against specs, code, tests and git history,
  and either reports the tree healthy or writes one maintenance change (for
  example `openspec/changes/garden-2026-10-17/`). That change proposes splits,
  moves, merges, renames and candidate retirements, each with evidence and
  confidence. It never edits `openspec/specs/` directly, never retires a
  requirement without asking me, and leaves locked requirements alone.
- Optional `openspec/taxonomy.yaml`: the domains I intend, each with a purpose,
  optional per-domain limits and retired names. The gardener proposes changes to
  it in the same maintenance change, so the taxonomy evolves through review too.

## Capabilities

### New Capabilities
- `spec-gardening`: the deterministic garden report, the taxonomy file, and the
  rule that structural maintenance happens through ordinary changes.

### Modified Capabilities
- None. The `specs` addon gains an operation and a skill. Its catalog
  requirement already covers listing them.

## Impact

- `lib/specs/garden.mjs` (new) reuses the audit's snapshot and the OpenSpec
  adapter. It reads archived and active change deltas from the filesystem
  because OpenSpec has no API for them. `lib/operations.mjs`, `bin/hub.mjs` and
  `bin/mcp.mjs` gain the operation.
- `scripts/spec-links.mjs`: the link and scenario parsing moves into a shared
  module so the trace signal and `npm test` agree on what counts as a link.
- `skills/garden-canonical-specs/SKILL.md` (new), `addons/specs/addon.json`, the
  `specs` help topic, `skills/context-kit/references/specs.md`.
- No new dependencies. The taxonomy is parsed with the existing `yaml`
  dependency.
- Relation to the roadmap: this is "wiki upkeep" for specs, the same idea as
  linting hubs for orphans and stale concepts, applied to the canonical tree.
