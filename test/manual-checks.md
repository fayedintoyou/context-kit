# Manual checks

Scenarios that describe an agent's reasoning rather than program behavior. Each
entry says how the scenario is verified. Format:
`- spec: <capability> / <scenario> — <how it is verified>`

- spec: canonical-spec-audit / Semantic review — skills/audit-canonical-specs/SKILL.md requires evidence per requirement and forbids silently rewriting canonical intent; check a sample audit report against it during independent review.

- spec: spec-gardening / Gardening proposes, never rewrites — During independent review, run skills/garden-canonical-specs/SKILL.md on a fixture copy with an oversized spec, a stale requirement and a locked requirement; hash canonical files before and after, inspect the single garden-<date> change for identical moved text and scenario names, a deferred lock, and a retirement question with no unconfirmed removal. Also check that a healthy tree creates no change.

- spec: change-progress / Divergence is surfaced, not absorbed — During independent review, run skills/reconcile-change/SKILL.md on a fixture change whose landed slice adds behavior outside its deltas (an out-of-scope file in `specs reconcile`); check the report names the divergence with commit and file evidence, recommends a proposal amendment or a separate change, and that the change's deltas and canonical specs are unchanged (hash before and after).

- spec: change-archival / Archived on merge — After merging this change, check the first run of .github/workflows/archive.yml on main archives the finished changes (repo-registry, spec-garden) in one bot commit that passed `npm test`; for the failure path, a run whose test command fails pushes nothing.
- spec: change-archival / Canonical edit in a pull request — Open a throwaway PR that edits a file under openspec/specs/: the canonical-guard check fails naming the file; adding the canonical-edit label re-runs it green. Close the PR without merging.

- remote-access (live hosts, beyond the end-to-end scenarios) — Following docs/remote.md against a real Cloudflare account: `curl` to the tunnel hostname without the token returns 401; adding `https://<edge>/mcp` as a Claude custom connector and as a ChatGPT plugin each shows the consent page naming that host's domain, completes GitHub sign-in, and lists and calls Context Kit tools; the Claude connector then appears and works in Claude Code; signing in with another GitHub account is refused; stopping the origin gives `ORIGIN_UNREACHABLE` in the host.
