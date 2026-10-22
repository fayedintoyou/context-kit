# Tasks

## 1. Routing skill frontmatter (slice `skill-frontmatter`)

- [ ] 1.1 In `lib/repos.mjs`, build the description with the keyword budget (titles, then alias rounds, 1,024 characters) and return `skipped` aliases from `generatedSkills`; surface them in `repos sync` and `agents install` results; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Aliases beyond the budget`, `Everything fits` and `Skill names every repository`
- [ ] 1.2 Split into `my-repos`, `my-repos-2`, … when titles don't fit, each body listing only its repositories; the installer and `repos sync` add and remove shards; verify `test/e2e/agents.test.mjs` linked to `repository-registry / Too many titles` and `Shards shrink back`
- [ ] 1.3 Emit only standard frontmatter keys and check the Agent Skills rules (keys, name pattern, name equals directory, description length, string metadata) in the test; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Standard keys only`
- [ ] 1.4 Document the budget, skipped aliases and shards in `skills/context-kit/references/repositories.md`; verify `node bin/hub.mjs validate`

## 2. Shared skills location (slice `shared-skills`)

- [ ] 2.1 Add per-location installs to `lib/install.mjs`: `~/.agents/skills` with the six standard keys, Claude Code's directory, fewest locations for the selected harnesses, and records shared by several harnesses; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Install for Claude Code and Codex` (Codex now under `~/.agents/skills`) and `Claude Code with harnesses that share`
- [ ] 2.2 Move Codex's recorded copies out of `$CODEX_HOME/skills`, keeping edited ones; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Upgrade an existing Codex install`
- [ ] 2.3 Update README Install and `skills/context-kit/references/addons-and-install.md` with the locations; verify `node bin/hub.mjs validate`

## 3. More harnesses (slice `harnesses`)

- [ ] 3.1 Extend the harness table with `gemini`, `copilot`, `cursor`, `opencode` and `--agent all`, keeping the default `claude,codex`; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Unknown harness`, `Every harness` and `Harnesses that read either`
- [ ] 3.2 Register Gemini CLI through `gemini mcp add|remove -s user` with a fake `gemini` CLI; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Register with Gemini CLI`
- [ ] 3.3 Register Copilot CLI, Cursor and OpenCode through their JSON config files (strict JSON, atomic write, own entry only, edited kept); verify `test/e2e/agents.test.mjs` linked to `agent-installation / Other servers are kept`, `Unreadable config` and `Edited entry`
- [ ] 3.4 Project scope for the new harnesses (skills under `.agents/skills`, MCP skipped); verify `test/e2e/agents.test.mjs` linked to `agent-installation / Project install for Cursor`
- [ ] 3.5 Document the harness table with its sources and Antigravity CLI as later in `skills/context-kit/references/addons-and-install.md`, the `help` topic and README; verify `test/e2e/help.test.mjs` still passes and `node bin/hub.mjs validate`

## 4. Portable entry point (slice `portable-entry`)

- [ ] 4.1 Write, record, report (`onPath`) and uninstall the managed launcher in `$XDG_BIN_HOME` or `~/.local/bin`; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Run from anywhere` and `Foreign launcher`
- [ ] 4.2 Render the routing body around one resolve operation named by MCP server and launcher, with remedies through the launcher and no `cd`; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Body names the server and the launcher`, `Remedies use the launcher`, `Missing checkout guidance` and `Workflow guidance before changes`
- [ ] 4.3 Report `moved` in `agents status` for records naming another root, make the launcher fail with `WORKSPACE_MOVED`, and repair on install; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Move and repair`
- [ ] 4.4 Document the launcher and moving a workspace in `repositories.md`, `troubleshooting.md` and `commands.md`; verify `node bin/hub.mjs validate`

## 5. New-machine flow (slice `setup-and-which`)

- [ ] 5.1 Add `repos scan --depth` (default 1, at most 6), pruning hidden directories, `node_modules` and found checkouts; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Scan finds checkouts` and `Deeper scan`
- [ ] 5.2 Record a linked worktree's main checkout instead of the worktree; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Scan finds a worktree`
- [ ] 5.3 Add `repos setup [--scan <dir>]... [--depth <n>] [--clone <repos>] [--ask]` (CLI only) with prompts on a terminal or `--ask`, then refresh skills; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Fresh machine without prompts`, `Approved at a prompt` and `Named clone`
- [ ] 5.4 Add `repos which [<path>]` and stdio `which_repo`; verify `test/e2e/repos.test.mjs` linked to `repository-registry / Nested subdirectory`, `Linked worktree`, `Unrecorded checkout`, `Not a repository of the user's` and `Agent asks where it is` (its HTTP half uses the `remote.test.mjs` harness)
- [ ] 5.5 Document setup, depth, worktrees and `which` in `repositories.md`, `commands.md` and the `bin/hub.mjs` usage; verify `test/e2e/help.test.mjs` passes

## 6. Remote paths (slice `remote-paths`)

- [ ] 6.1 Pass the transport and `--machine-name` (default the host name) into the selection; over HTTP, return `machine` and `servingMachinePath` from `list_repos`, with the HTTP description; verify `test/e2e/remote.test.mjs` linked to `repository-registry / Remote client sees whose paths they are` and `test/e2e/repos.test.mjs` linked to `Local clients unchanged`
- [ ] 6.2 Document it in `skills/context-kit/references/remote.md`; verify `node bin/hub.mjs validate`

## 7. Optional global rule (slice `global-rule`)

- [ ] 7.1 Add `--global-rule`/`--no-global-rule`: a recorded, Context Kit-owned `context-kit.md` in Claude Code's user rules directory naming the resolve operation and no repositories, kept across plain reinstalls, `unsupported` elsewhere; verify `test/e2e/agents.test.mjs` linked to `agent-installation / Opt in`, `Off unless asked` and `Edited rule`
- [ ] 7.2 Document the opt-in in `addons-and-install.md` and README; verify `node bin/hub.mjs validate`

## 8. Integration

- [ ] 8.1 On the integration branch, run `npm test` (every scenario linked), `node bin/hub.mjs validate`, `npx openspec validate machine-setup --strict` and `specs archive --rehearse`
- [ ] 8.2 Upgrade the owner's workspace, run `agents install --agent claude,codex`, and check from a session started in `~` that naming a repository routes to its checkout in Claude Code and Codex; record the outcome on the integration PR

## Workflow follow-up

- Merge the integration branch `machine-setup` into `main`; the openspec workflow archives the change.
- On a second machine: `repos setup`, then `agents install`.
