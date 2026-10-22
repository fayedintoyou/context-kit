# Tasks

## 1. Open a repository with a default bootstrap (slice `open`)

- [ ] 1.1 Expose resolution details from `find()`/`listRepositories()` in `lib/repos.mjs` (matched field, registering concept, upstream, recorded path with source `machine`, stale records as missing) and add `lib/repo-context.mjs` with the read-only core operation `open_repo` (`repository`, optional `path`) and `repos open <repo> [<subpath>]`; verify with `test/e2e/repo-context.test.mjs` linked to `repository-context / Open by alias`, `How it resolved`, `Explicit name wins over the working directory`, `Ambiguous or unknown name`, `Not checked out here` and `Stale mapping`, asserting `.state/checkouts.json` is byte-identical after opening a missing or stale repository
- [ ] 1.2 Add the sanitized git runner (no `GIT_*` variables, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false`, only `rev-parse` and `ls-files -z --stage`) and the per-component containment walk (`lstat` each component, `O_NOFOLLOW`, real-path check); verify with `test/e2e/repo-context.test.mjs` linked to `Escaping or missing subpath` and `Instruction file symlink`
- [ ] 1.3 Add instruction-file pointers (`AGENTS.md`, `CLAUDE.md`, tracked or not, root down to the subpath) and the default bootstrap tree (index paths, depth 2, at most 150 entries, directory counts, 8 KiB compact-JSON allowance trimming the tree then pointers, `truncated`); verify with `test/e2e/repo-context.test.mjs` linked to `Nested instructions`, `Zero-configuration bootstrap` and `Large tree`, asserting `Buffer.byteLength(JSON.stringify(result)) <= 8192`
- [ ] 1.4 Offer `open_repo` on stdio MCP only, following `machine-setup`'s local-only rule; verify with `test/e2e/repo-context.test.mjs` (HTTP server harness from `test/e2e/remote.test.mjs`) asserting `open_repo` is absent over HTTP and fails with `UNKNOWN_OPERATION`, and is listed over stdio
- [ ] 1.5 Document `repos open`, its result, the local-only rule and the new codes in `skills/context-kit/references/repositories.md` and `commands.md`, and verify the `help / Help covers the tool` test passes

## 2. Routing skill (slice `routing`)

- [ ] 2.1 Add the "open it first" instruction with the exact `repos open <id>` command per repository (and `--role` when reviewing) to the `my-repos` body in `lib/repos.mjs`, leaving the frontmatter renderer, which `machine-setup` owns, untouched; verify with `test/e2e/repos.test.mjs` linked to `repository-context / One call to start`, asserting identical frontmatter with and without `context`

## 3. The `context` field and declared pointers (slice `fields`)

- [ ] 3.1 Validate the closed `context` schema at every level, the bounds, `verify`, concept references `[<hub-id>:]/<id>` through one resolver, MCP names, area paths, pack names (reserved `default`) and globs (no `.`/`..` segment, leading `/` or backslash; only `*`, `**`, `?`), and add the problems to `validate`; verify with `test/e2e/repo-context.test.mjs` linked to `Declared context validates`, `Unknown keys at any level`, `Over the bounds`, `Invalid verification commands`, `References across hubs`, `Unresolvable references`, `Names, not configuration`, `Bad area paths` and `Invalid packs`
- [ ] 3.2 Validate skill references against hub manifests and enabled addons, and emit skill pointers with the declaring `hub` and `reference`; verify with `test/e2e/repo-context.test.mjs` linked to `Every emitted skill pointer reads` (calling `read-skill` and `read_skill` for each pointer) and `Unreadable skill references`
- [ ] 3.3 Move `lib/landing.mjs`'s glob matcher unchanged into `lib/globs.mjs` and import it from landing, leaving `lib/specs/progress.mjs`'s matcher as is; verify `test/e2e/landing.test.mjs` passes unchanged
- [ ] 3.4 Return `verify` (never executed), declared pointers, area, role and pack summaries, the outermost-first area merge with the tree rooted at the subpath, `missing` pointers with warnings and `INVALID_CONTEXT` from `repos open`; verify with `test/e2e/repo-context.test.mjs` linked to `Declared checks are returned, not run`, `Pointers without bodies`, `Summarized declarations`, `Nested areas`, `Subpath outside every area` and `Deleted concept after validation`
- [ ] 3.5 Document the `context` schema and bounds in `docs/format.md` and `INVALID_CONTEXT` in the help references, and verify the help completeness test and `node bin/hub.mjs validate` pass

## 4. Packs and roles (slice `packs`)

- [ ] 4.1 Implement the canonical payload and `context_pack`/`repos pack <repo> <pack>`, including `default`: index candidates, containment walk, size check before reading, SHA-256, NUL-byte binary flag, raw-blob `dirty` against index blob IDs, missing selected files, payload hash with annotations beside it; stdio only. Verify with `test/e2e/repo-context.test.mjs` linked to `Pack for a release`, `Same over MCP`, `Rebuild, edit and delete`, `Concepts age`, `Same pack on two machines`, `Skipped files`, `Symlinked parent`, `Hostile checkout configuration` (fsmonitor, clean filter and process filter each writing a marker; `GIT_DIR` set elsewhere) and `Not offered over HTTP`, plus glob cases `a/**/b`, `**/x` and `docs/*`
- [ ] 4.2 Add limits and `--budget` (MCP `budget`) stopping before the file that would exceed them, with `truncated`; verify with `test/e2e/repo-context.test.mjs` linked to `Truncated by bytes` (asserting the 10 MiB file is never opened, by making it unreadable) and `Budget above the limit`
- [ ] 4.3 Add `--role` (MCP `role`) to `repos open` and `repos pack`, with `exclude`, `omit`, added pointers, instruction files kept and withheld counts, plus `UNKNOWN_ROLE`, `UNKNOWN_PACK` and `CHECKOUT_MISSING`; verify with `test/e2e/repo-context.test.mjs` linked to `A fresh reviewer never sees builder notes` (asserting neither output's JSON contains the withheld names), `Unknown role` and `Pack without a checkout`
- [ ] 4.4 Add `--seed` (MCP `seed`) producing the deterministic `ContextPack` frontmatter; verify with `test/e2e/repo-context.test.mjs` linked to `Seed becomes a concept`, which writes the seed into a temporary hub and runs `validate`
- [ ] 4.5 Document packs, roles, budgets (with the rough bytes-to-tokens rule), raw-byte `dirty`, binary files and the new error codes in the help references, and verify the help completeness test passes

## 5. MCP availability (slice `mcp-check`)

- [ ] 5.1 Add `--check-mcp` (MCP `checkMcp`, off by default) to `repos open` and `repos pack`, probing `claude mcp get` and `codex mcp get` with a timeout and never calling `mcp add` or `mcp remove`, with availability only in annotations; verify with `test/e2e/repo-context.test.mjs` linked to `Declared versus registered` and `No check by default`, using the logging fake agent CLIs from `test/e2e/agents.test.mjs`
- [ ] 5.2 Document `--check-mcp`, and that Context Kit never installs declared servers, in the help references, and verify the help completeness test passes

## 6. Integration

- [ ] 6.1 Run `npm test`, `node bin/hub.mjs validate`, `openspec validate repo-context --strict` and `specs archive --rehearse`, and check that every `repository-context` scenario is linked

## Workflow follow-up

- Land after the prerequisite change `slice-aware-links`, so each slice can keep `npm test` green
- Open one of the owner's repositories with no `context` and check that a fresh subagent told "work on <repo>" calls `repos open` once and starts work without scouting
- Add a `reviewer` role and a `release` pack to that Repository concept, then run a fresh reviewer through `repos open --role reviewer`
- Coordinate the reference form with `hub-federation`, and the routing body and local-only rule with `machine-setup`, before any of the three archives
- The openspec workflow archives the change after merge
