# Proposal

## Why

An agent can start in any directory. It doesn't need to start in the repository it
ends up working on; it needs a skill it reliably selects when a request names one
of the user's repositories, and enough in that skill to find the checkout on this
machine and go there. The generated `my-repos` skill is that mechanism. It works
for one person on several of their own machines the same way as for a team: the
repository list is shared through the workspace's hubs, and each machine records
its own checkouts. It is fragile today:

- Its description is capped at 1,000 characters. Past that, every alias is dropped
  at once, silently, so a workspace with many repositories stops matching the names
  people actually use.
- It is installed only into `~/.claude/skills` and `$CODEX_HOME/skills`, for two
  harnesses. Current Codex documentation lists `$HOME/.agents/skills` as the user
  skills location, which Gemini CLI, GitHub Copilot CLI, Cursor and OpenCode also
  read. Claude Code doesn't.
- Its body says `cd /abs/workspace && npm run -s hub -- repos`, which breaks when
  the workspace moves and costs every agent a `cd`.
- A new machine has every repository `missing`, and `repos scan` looks only one
  level deep. There is no guided flow, and no way to ask "which repository is
  this directory?" from a nested subdirectory or a worktree.
- `list_repos` served over HTTP returns the serving machine's paths unlabeled, so
  a remote client can be sent to a path that doesn't exist where it runs.

## What Changes

- **The skill's frontmatter is the mechanism.** The description is rebuilt on every
  install and sync from the registry's effective trigger names. Today that is
  every title, alias and new optional `keywords` entry; `hub-federation` will
  remove names that mounts dispute. Names are budgeted: primary names first, then
  aliases in rounds, then keywords, within the Agent Skills limit of 1,024
  characters. What doesn't fit is reported by name, never dropped silently. When
  the repositories' minimal entries don't fit together, the routing skill splits
  into numbered shards. `validate` bounds name lengths. Generated skills use only
  the six Agent Skills standard frontmatter keys.
- **One shared skills location.** `agents install` installs into `~/.agents/skills`
  for every harness that reads it, keeps `~/.claude/skills` for Claude Code, and
  writes the fewest locations that cover the selected harnesses. Codex moves from
  `$CODEX_HOME/skills` to `~/.agents/skills`. An old copy is removed only after
  its replacement is verified. Where a harness reads two copies and doesn't
  document which wins (Cursor), install warns.
- **More harnesses.** Gemini CLI, GitHub Copilot CLI and Cursor join Claude Code and
  Codex. Their skill and MCP locations are confirmed from each vendor's
  documentation (design.md). Each harness gets a discovery check that proves it
  lists the skill. OpenCode (two MCP config shapes) and Antigravity CLI
  (inconsistent documented paths) come later.
- **A stable entry point.** `agents install` writes a managed `context-kit`
  launcher in the user's bin directory, which stays put when the workspace moves.
  The routing skill points agents to one resolve operation, through the
  workspace's MCP server by name or through the launcher, with no `cd` into the
  workspace. A moved workspace shows up in `agents status`, and one `agents install`
  fixes it. A second workspace on the same machine is refused
  (`WORKSPACE_CONFLICT`) unless forced.
- **New-machine flow.** `repos setup` works through every `missing` repository: it
  scans to a configurable depth, records what it finds, offers to locate or clone
  the rest, never clones without being asked, and refreshes the skills. `repos scan`
  gains `--depth`. `repos which [<dir>]` (and read-only `which_repo` over stdio MCP)
  maps any path, including nested subdirectories and linked worktrees, back to its
  repository, concept and hub.
- **Remote path honesty.** This change owns the remote policy. It amends
  `remote-access / HTTP transport` parity: tools that resolve this machine's
  checkouts are local-only and aren't served over HTTP (`which_repo` here, and
  `repo-context`'s open tools by the same rule), and `list_repos` over HTTP names
  the serving machine and returns `servingMachinePath`.
- **Optional global rule.** `agents install --global-rule` writes a small
  Context Kit-owned rule file into Claude Code's `~/.claude/rules/`. It's off by
  default; harnesses without a rules directory report it unsupported, and nothing
  depends on it.

Out of scope: plugin and marketplace packaging (deferred); managed blocks in
`AGENTS.md`, `GEMINI.md` or `copilot-instructions.md` (off); what a
resolved repository's context contains (`repo-context`); mounted team hubs
(`hub-federation`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-registry`: `keywords` and name bounds, effective trigger names, a
  keyword budget and shards for the routing skill, standard-only frontmatter, a
  path-free routing body, `repos setup`, scan depth and worktrees, and `repos
  which`/`which_repo`. MODIFIES `Generated routing skill` (effective names within
  the budget) and `Scan a directory once` (depth becomes an option).
- `remote-access`: MODIFIES `HTTP transport` (parity except local-only tools and
  labeled paths), and ADDs `Local-only tools` and `Serving machine paths`. It needs
  `remote-mcp-access` archived first, because `remote-access` isn't canonical yet.
- `agent-installation`: the shared `~/.agents/skills` location, the harness table
  (Gemini CLI, Copilot CLI, Cursor), MCP registration by config file,
  the launcher, one workspace per user, moved-workspace detection, discovery
  checks, warnings for copies a harness reads twice, and the optional global
  rule.
  MODIFIES `Install into agents` (Codex's user skill directory).

## Impact

- `lib/install.mjs`: harness table with skill locations, MCP adapters (agent CLI or
  JSON config file) and rule support; the launcher and rule record kinds; Codex
  migration.
- `lib/repos.mjs`: keyword budget, shards, path-free body, scan depth and
  worktrees, `setupRepositories`, `whichRepository`.
- `lib/operations.mjs`, `bin/hub.mjs`, `lib/mcp/server.mjs`, `lib/mcp/http.mjs`:
  `repos setup`, `repos which`, `which_repo`, the transport-aware `list_repos`,
  `--machine-name`.
- `docs/format.md`: Repository `keywords` and name bounds.
- Docs: README Install, `skills/context-kit/references/repositories.md`,
  `addons-and-install.md`, `remote.md`, `commands.md`, help topics.
- Tests: `test/e2e/agents.test.mjs`, `repos.test.mjs`, `remote.test.mjs`, with fake
  harness CLIs and temporary `HOME`, `XDG_*`, `CODEX_HOME`, `COPILOT_HOME` and
  `CLAUDE_CONFIG_DIR`; an opt-in `test/e2e/discovery.test.mjs` against real Claude
  Code and Codex; `test/manual-checks.md` entries for the other harnesses.
- No new runtime dependency.
- Slices merge to `main` one at a time. No part of this change merges to `main`
  before `remote-mcp-access` has archived, because the `remote-access` delta needs
  that spec to be canonical (tasks.md 0.1).
- The owner's machine, after upgrading: `npm run agents -- install --agent
  claude,codex` (moves Codex's copies), then `repos setup` on any other machine.
