# Tasks

## 1. Open a repository with a default pack (slice `open`)

- [ ] 1.1 Expose resolution details from `find()`/`listRepositories()` in `lib/repos.mjs` (matched field, registering concept, upstream, path and its machine source) and add `lib/repo-context.mjs` with the read-only core operation `open_repo` (`repository`, optional `path`) and `repos open <repo> [<subpath>]` in `bin/hub.mjs`; verify with `test/e2e/repo-context.test.mjs` linked to `repository-context / Open by alias`, `How it resolved`, `Ambiguous or unknown name` and `Not checked out here`, asserting `.state/checkouts.json` is unchanged after opening a missing repository
- [ ] 1.2 Add the shared git runner (`-c core.fsmonitor=false -c core.hooksPath=/dev/null`, `GIT_OPTIONAL_LOCKS=0`), instruction-file pointers (`AGENTS.md`, `CLAUDE.md` at the root and down to the subpath) and the default pack tree (tracked paths, depth 2, 150 entries, directory counts, `truncated`); verify with `test/e2e/repo-context.test.mjs` linked to `Nested instructions`, `Zero-configuration pack` and `Large tree`
- [ ] 1.3 Add `repos open`, `open_repo` and the `repos open` result shape to `skills/context-kit/references/repositories.md` and `commands.md`, and verify the `help / Help covers the tool` test passes

## 2. Routing skill (slice `routing`)

- [ ] 2.1 Add the "open it first" instruction with the exact `repos open <id>` command per repository to the `my-repos` body in `lib/repos.mjs`, leaving the frontmatter untouched; verify with `test/e2e/repos.test.mjs` linked to `repository-context / One call to start`, asserting identical frontmatter with and without `context`

## 3. The `context` field and declared pointers (slice `fields`)

- [ ] 3.1 Parse and validate `context` on Repository concepts (allowed keys, `verify` as a list of single-line strings, concept references `[<hub-id>:]/<id>` through one resolver, skill references through the manifest resolver, MCP names, areas, pack and role shapes including reserved `default`, glob syntax, limits and list caps) and add the problems to `validate`; verify with `test/e2e/repo-context.test.mjs` linked to `Declared context validates`, `Unknown context key`, `Invalid verification commands`, `References across hubs`, `Unresolvable references`, `Names, not configuration`, `Bad area paths` and `Invalid packs`
- [ ] 3.2 Move the `*`/`**`/`?` glob matcher from `lib/landing.mjs` and `lib/specs/progress.mjs` into one shared helper and verify `npm test` still passes for landing and progress unchanged
- [ ] 3.3 Return `verify` commands (never executed), declared pointers, area and pack summaries, outermost-first area merge for a subpath, `missing` pointers with warnings and `INVALID_CONTEXT` from `repos open`; verify with `test/e2e/repo-context.test.mjs` linked to `Declared checks are returned, not run`, `Pointers without bodies`, `Summarized areas and packs`, `Nested areas`, `Subpath outside every area` and `Deleted concept after validation`
- [ ] 3.4 Document the `context` field in `docs/format.md` and `INVALID_CONTEXT` in the help references, and verify the help completeness test and `node bin/hub.mjs validate` pass

## 4. Declared packs (slice `packs`)

- [ ] 4.1 Implement pack expansion (`git ls-files` candidates, lstat skips with counts, SHA-256 of working-tree bytes, sort, include/exclude, `dirty`, the default pack's pointers, canonical manifest hash without path or availability) and the read-only core operation `context_pack` with `repos pack <repo> <pack>`, including `default`; verify with `test/e2e/repo-context.test.mjs` linked to `Pack for a release`, `Same over MCP`, `Rebuild unchanged`, `Same pack on two machines` and `Skipped files`, using `git init` fixtures with a tracked symlink, a deleted tracked file and a `core.fsmonitor` command whose marker file must never appear
- [ ] 4.2 Add limits and `--budget` (MCP `budget`) with the `truncated` report; verify with `test/e2e/repo-context.test.mjs` linked to `Truncated by bytes` and `Budget above the limit`
- [ ] 4.3 Add roles (`--role`, MCP `role`) with inheritance, `exclude`, `omit` and withheld counts, plus `UNKNOWN_ROLE`, `UNKNOWN_PACK` and `CHECKOUT_MISSING` with remedies; verify with `test/e2e/repo-context.test.mjs` linked to `Reviewer without builder notes`, `Unknown role` and `Pack without a checkout`
- [ ] 4.4 Add `--seed` (MCP `seed`) producing the deterministic `ContextPack` frontmatter; verify with `test/e2e/repo-context.test.mjs` linked to `Seed becomes a concept`, which writes the seed into a temporary hub and runs `validate`
- [ ] 4.5 Document packs, roles, budgets (with the rough bytes-to-tokens rule) and the new error codes in `skills/context-kit/references/repositories.md` and `commands.md`, and verify the help completeness test passes

## 5. MCP availability (slice `mcp-check`)

- [ ] 5.1 Add `--check-mcp` (MCP `checkMcp`) to `repos open` and `repos pack`, probing `claude mcp get` and `codex mcp get` from the located checkout with a timeout and never calling `mcp add` or `mcp remove`; verify with `test/e2e/repo-context.test.mjs` linked to `Declared versus registered` and `No check by default`, using the logging fake agent CLIs from `test/e2e/agents.test.mjs`
- [ ] 5.2 Document `--check-mcp`, and that Context Kit never installs declared servers, in the help references, and verify the help completeness test passes

## 6. Integration

- [ ] 6.1 Run `npm test`, `node bin/hub.mjs validate`, `openspec validate repo-context --strict` and `specs archive --rehearse`, and check that every `repository-context` scenario is linked

## Workflow follow-up

- Land after the prerequisite change `slice-aware-links`, so each slice can keep `npm test` green

- Open one of the owner's repositories with no `context` and check that a fresh subagent told "work on <repo>" calls `repos open` once and starts work without scouting, in about 1–2k tokens
- Add a `release` pack with a `reviewer` role to that Repository concept and compare the builder and reviewer manifests
- Coordinate the concept reference form with `hub-federation`, and the routing skill body with `machine-setup`, before any of the three archives
- The openspec workflow archives the change after merge
