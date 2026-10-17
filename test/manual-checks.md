# Manual checks

Scenarios that describe an agent's reasoning rather than program behavior. Each
entry says how the scenario is verified. Format:
`- spec: <capability> / <scenario> — <how it is verified>`

- spec: canonical-spec-audit / Semantic review — skills/audit-canonical-specs/SKILL.md requires evidence per requirement and forbids silently rewriting canonical intent; check a sample audit report against it during independent review.

- spec: spec-gardening / Gardening proposes, never rewrites — During independent review, run skills/garden-canonical-specs/SKILL.md on a fixture copy with an oversized spec, a stale requirement and a locked requirement; hash canonical files before and after, inspect the single garden-<date> change for identical moved text and scenario names, a deferred lock, and a retirement question with no unconfirmed removal. Also check that a healthy tree creates no change.

- spec: change-progress / Divergence is surfaced, not absorbed — During independent review, run skills/reconcile-change/SKILL.md on a fixture change whose landed slice adds behavior outside its deltas (an out-of-scope file in `specs reconcile`); check the report names the divergence with commit and file evidence, recommends a proposal amendment or a separate change, and that the change's deltas and canonical specs are unchanged (hash before and after).
