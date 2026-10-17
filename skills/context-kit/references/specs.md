# Specs (specs addon)

Reads canonical OpenSpec specs through the pinned OpenSpec CLI. Pending change
deltas are not canonical.

| Task | CLI | MCP tool |
|---|---|---|
| List specs | `specs list [--store <id>]` | `list_specs` |
| Read one | `specs read <spec-id> [--store <id>]` | `read_spec` |
| Structural audit | `specs audit [--store <id>]` | `audit_specs` |
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
