# Tasks

## 1. Routing skill frontmatter (slice `skill-frontmatter`)

- [ ] 1.1 Add optional `keywords` and name bounds (title 80, alias and keyword 60 code points; no keyword equal to another repository's title or alias, failing `validate` only when every repository involved is in a workspace hub; collisions involving a mount follow `hub-federation`'s warn-and-drop policy) to the registry and `validate`, and document them in `docs/format.md`; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Invalid keywords and long names`
- [ ] 1.2 Render only the registry's effective trigger names (all valid names until `hub-federation` defines its registry contract), with the primary-name fallbacks; verify `test/e2e/repos.test.mjs` linked to `repository-registry / All names are effective by default`, `Title not usable` and `Invalid keyword never rendered`
- [ ] 1.3 Implement the single partition-and-fill algorithm (code points, fixed text and separators counted, reserved shard marker) and return `skipped` names from `generatedSkills`, `repos sync` and `agents install`; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Aliases beyond the budget`, `Exact boundary`, `Characters, not bytes`, `Everything fits`, `Skill names every repository` and `Keywords reach the description`
- [ ] 1.4 Generate, install and remove shards; verify `test/e2e/agents.test.mjs` linked to `repository-registry / Too many repositories for one`, `Longest allowed names` and `Shards shrink back`
- [ ] 1.5 Emit only standard frontmatter keys and check the Agent Skills rules in the test; add an optional `npm run skills-ref` script that runs a pinned `skills-ref validate` on rendered skills when `uv` is available; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Standard keys only`
- [ ] 1.6 Document keywords, the budget, skipped names and shards in `skills/context-kit/references/repositories.md`; verify `node bin/hub.mjs validate`

## 2. Shared skills location (slice `shared-skills`)

- [ ] 2.1 Add per-location installs to `lib/install.mjs`: `~/.agents/skills` with the six standard keys, Claude Code's directory, fewest locations, and records shared by several harnesses (`agents: [...]`); verify `test/e2e/agents.test.mjs` linked to `agent-installation / Install for Claude Code and Codex` (Codex now under `~/.agents/skills`), `Claude Code with harnesses that share` and `Selective uninstall of shared copies`
- [ ] 2.2 Move Codex's recorded copies from their recorded legacy directory, removing each only after its replacement is installed and its hash verified; keep the legacy copy and record on conflict or failure; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Upgrade an existing Codex install`, `Destination blocked` and `Codex home changed since install`
- [ ] 2.3 Update README Install and `skills/context-kit/references/addons-and-install.md` with the locations; verify `node bin/hub.mjs validate`

## 3. More harnesses (slice `harnesses`)

- [ ] 3.1 Extend the harness table with `gemini`, `copilot`, `cursor` and `--agent all`, keeping the default `claude,codex`; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Unknown harness`, `Every harness` and `Cursor with or without Claude Code`
- [ ] 3.2 Warn when a harness reads the same skill from two directories with no documented precedence (Cursor); verify `test/e2e/agents.test.mjs` linked to `agent-installation / Cursor sees both directories`
- [ ] 3.3 Register Gemini CLI through `gemini mcp add|remove -s user` with a fake `gemini` CLI; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Register with Gemini CLI`
- [ ] 3.4 Register Copilot CLI and Cursor through their JSON config files (strict JSON, atomic write, own entry only, edited kept); verify `test/e2e/agents.test.mjs` linked to `agent-installation / Other servers are kept`, `Unreadable config` and `Edited entry`
- [ ] 3.5 Project scope for the new harnesses (skills under `.agents/skills`, MCP skipped); verify `test/e2e/agents.test.mjs` linked to `agent-installation / Project install for Cursor`
- [ ] 3.6 Add the opt-in `test/e2e/discovery.test.mjs` for real Claude Code and Codex (`CONTEXT_KIT_HARNESS_SMOKE=1`) and `test/manual-checks.md` entries for Gemini CLI, Copilot CLI and Cursor, all linked to `agent-installation / Routing skill is discovered`; run them once and record versions and outcomes
- [ ] 3.7 Document the harness table with its sources, documented capacity limits ("not documented" where none), and OpenCode and Antigravity CLI as later, in `addons-and-install.md`, the `help` topic and README; verify `test/e2e/help.test.mjs` passes and `node bin/hub.mjs validate`

## 4. Portable entry point (slice `portable-entry`)

- [ ] 4.1 Write, record, report (`onPath`) and uninstall the managed launcher in `$XDG_BIN_HOME` or `~/.local/bin`; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Run from anywhere` and `Foreign launcher`
- [ ] 4.2 Refuse a second workspace with `WORKSPACE_CONFLICT` before writing, and let `--force` take over the launcher and generated skills; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Second workspace`
- [ ] 4.3 Render the routing body around the operation marked `resolve` (`list_repos` until `repo-context` adds `open_repo`), naming the MCP server and the launcher, with every command through the launcher and no `cd`; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Body names the server and the launcher`, `Remedies use the launcher`, `Missing checkout guidance` and `Workflow guidance before changes`
- [ ] 4.4 Report `moved` in `agents status` for records naming another root, make the launcher fail with `WORKSPACE_MOVED`, and repair on install; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Move and repair`
- [ ] 4.5 Document the launcher, one workspace per user, and moving a workspace in `repositories.md`, `troubleshooting.md` and `commands.md`; verify `node bin/hub.mjs validate`

## 5. New-machine flow (slice `setup-flow`)

- [ ] 5.1 Add `repos scan --depth` (default 1, at most 6), pruning hidden directories, `node_modules` and found checkouts; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Scan finds checkouts` and `Deeper scan`
- [ ] 5.2 Record a linked worktree's main worktree from `git worktree list --porcelain` (realpath-normalized), and nothing for a bare or missing main; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Scan finds a worktree` and `Worktree of a bare or missing main`
- [ ] 5.3 Add `repos setup [--scan <dir>]... [--depth <n>] [--clone <repos>] [--ask]` (CLI only) with prompts on a terminal or `--ask`, then refresh skills; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Fresh machine without prompts`, `Approved at a prompt` and `Named clone`
- [ ] 5.4 Document setup, depth and worktrees in `repositories.md`, `commands.md` and the `bin/hub.mjs` usage; verify `test/e2e/help.test.mjs` passes

## 6. Optional global rule (slice `global-rule`)

- [ ] 6.1 Add `--global-rule`/`--no-global-rule`: a recorded, Context Kit-owned `context-kit.md` in Claude Code's user rules directory naming the resolve operation and no repositories, kept across plain reinstalls, `unsupported` elsewhere; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Opt in`, `Off unless asked` and `Edited rule`
- [ ] 6.2 Document the opt-in in `addons-and-install.md` and README; verify `node bin/hub.mjs validate`

## 7. Integration

- [ ] 7.1 After the last slice lands, run `npm test` (every scenario linked), `node bin/hub.mjs validate`, `npx openspec validate machine-setup --strict` and `specs archive --rehearse` on `main` after the last slice
- [ ] 7.2 Upgrade the owner's workspace, run `agents install --agent claude,codex`, and check from a session started in `~` that naming a repository routes to its checkout in Claude Code and Codex; record the outcome on the last slice's PR

## Workflow follow-up

- Once every slice and task has landed, the openspec workflow archives the change on `main`.
- On a second machine: `repos setup`, then `agents install`.
