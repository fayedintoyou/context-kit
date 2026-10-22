# Manual checks

Scenarios that describe an agent's reasoning rather than program behavior. Each
entry says how the scenario is verified. Format:
`- spec: <capability> / <scenario> — <how it is verified>`

- spec: canonical-spec-audit / Semantic review — skills/audit-canonical-specs/SKILL.md requires evidence per requirement and forbids silently rewriting canonical intent; check a sample audit report against it during independent review.

- spec: spec-gardening / Gardening proposes, never rewrites — During independent review, run skills/garden-canonical-specs/SKILL.md on a fixture copy with an oversized spec, a stale requirement and a locked requirement; hash canonical files before and after, inspect the single garden-<date> change for identical moved text and scenario names, a deferred lock, and a retirement question with no unconfirmed removal. Also check that a healthy tree creates no change.

- spec: change-progress / Divergence is surfaced, not absorbed — During independent review, run skills/reconcile-change/SKILL.md on a fixture change whose landed slice adds behavior outside its deltas (an out-of-scope file in `specs reconcile`); check the report names the divergence with commit and file evidence, recommends a proposal amendment or a separate change, and that the change's deltas and canonical specs are unchanged (hash before and after).

- spec: change-archival / Archived on merge — After merging this change, check the first run of .github/workflows/archive.yml on main archives the finished changes (repo-registry, spec-garden) in one bot commit that passed `npm test`; for the failure path, a run whose test command fails pushes nothing.
- spec: change-archival / Canonical edit in a pull request — Open a throwaway PR that edits a file under openspec/specs/: the canonical-guard check fails naming the file; adding the canonical-edit label re-runs it green. Close the PR without merging.

- remote-access (live hosts, beyond the end-to-end scenarios) — Following skills/context-kit/references/remote.md against a real Cloudflare account: `curl` to the tunnel hostname without the token returns 401; adding `https://<edge>/mcp` as a Claude custom connector and as a ChatGPT plugin each shows the consent page naming that host's domain, completes GitHub sign-in, and lists and calls Context Kit tools; the Claude connector then appears and works in Claude Code; signing in with another GitHub account is refused; stopping the origin gives `ORIGIN_UNREACHABLE` in the host.

- spec: agent-installation / Routing skill is discovered — Claude Code and Codex: `CONTEXT_KIT_HARNESS_SMOKE=1 node --test test/e2e/discovery.test.mjs` (end to end; 2026-10-22: Claude Code 2.1.303 and codex-cli 0.163.0 both list `my-repos` naming the repository). The others by hand: in a workspace with a registered repository, run `agents install --agent <harness>`, `cd "$(mktemp -d)"`, start the harness there and record its version, the date and whether `my-repos` is listed with a description naming the repository.
  - Gemini CLI: `gemini skills list` (or `/skills list` in a session). Result: not run yet (not installed on the owner's machine, 2026-10-22).
  - GitHub Copilot CLI: `copilot skill list` (or `/skills list`). Result: not run yet (not installed, 2026-10-22).
  - Cursor: open a window on the temporary directory, then Customize → Skills; `my-repos` is listed once per copy (see the `READ_TWICE` warning). Result: not run yet (not installed, 2026-10-22).

- spec: behavior-maps / Diagram shows on GitHub — Open test/e2e/fixtures/maps/pigeon/maps/alerts.md (its diagram written by `maps render alerts --write`, and kept current by the "Outdated diagram" test) on GitHub at the pull request's head and check GitHub draws the flowchart: a circle for the start, a diamond for the choice with both `when` labels on its exits, rounded boxes for the two states and a stadium for the end, with the labels as written. Result: see the `behavior-maps` journey pull request.
- spec: behavior-maps / Draft from specs — In a copy of test/e2e/fixtures/maps/pigeon without maps/, have an agent that has only skills/behavior-map/SKILL.md and the `maps` help topic draft a map of the `alerts` capability; check that `maps check --strict` passes, that every state cites a behavior, that the map claims no status, and have a reviewer confirm the labels say what a Pigeon user sees.
