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
- A new machine has every repository `missing`, `repos scan` looks only one level
  deep, and a scan can record a linked worktree. There is no guided flow.

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
  gains `--depth`, and a linked worktree is recorded as its main checkout.
- **Install safety, found in review.** Skill records identify the copy they
  installed: a copy put in its place is `replaced` and left alone, the installed
  content is taken back by the workspace that owns the launcher or with `--adopt`,
  and a replaced legacy Codex copy is left with its record dropped. Config-file
  edits are checked swaps (`MCP_CONFLICT` when one can't apply cleanly), replaced
  files are kept as previous versions for an hour, and installs take a
  per-workspace lock (`AGENTS_BUSY`). Two race residuals are stated, not hidden.
- **Moved to `local-only-tools`:** `repos which`/`which_repo`, the local-only tool
  rule over HTTP and serving-machine paths. That change carries the
  `remote-access` delta and waits for `remote-mcp-access` to archive.
- **Optional global rule.** `agents install --global-rule` writes a small
  Context Kit-owned rule file into Claude Code's `~/.claude/rules/`. It's off by
  default; harnesses without a rules directory report it unsupported, and nothing
  depends on it.

Out of scope: plugin and marketplace packaging (deferred); managed blocks in
`AGENTS.md`, `GEMINI.md` or `copilot-instructions.md` (off); what a
resolved repository's context contains (`repo-context`); mounted team hubs
(`hub-federation`); `repos which` and the remote policy (`local-only-tools`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-registry`: `keywords` and name bounds, effective trigger names, a
  keyword budget and shards for the routing skill, standard-only frontmatter, a
  path-free routing body, `repos setup`, and scan depth and worktrees. MODIFIES `Generated routing skill` (effective names within
  the budget) and `Scan a directory once` (depth becomes an option).
- `agent-installation`: the shared `~/.agents/skills` location, the harness table
  (Gemini CLI, Copilot CLI, Cursor), MCP registration by config file,
  the launcher, one workspace per user, moved-workspace detection, discovery
  checks, warnings for copies a harness reads twice, the optional global
  rule, replaced skill copies, one install at a time, checked config edits and
  previous versions of config files.
  MODIFIES `Install into agents` (Codex's user skill directory).

## Impact

- `lib/install.mjs`: harness table with skill locations, MCP adapters (agent CLI or
  JSON config file) and rule support; the launcher and rule record kinds; Codex
  migration.
- `lib/repos.mjs`: keyword budget, shards, path-free body, scan depth and
  worktrees, `setupRepositories`.
- `lib/operations.mjs`, `bin/hub.mjs`: `repos setup`, `repos scan --depth`.
- `docs/format.md`: Repository `keywords` and name bounds.
- Docs: README Install, `skills/context-kit/references/repositories.md`,
  `addons-and-install.md`, `commands.md`, help topics.
- Tests: `test/e2e/agents.test.mjs`, `repos.test.mjs`, with fake
  harness CLIs and temporary `HOME`, `XDG_*`, `CODEX_HOME`, `COPILOT_HOME` and
  `CLAUDE_CONFIG_DIR`; an opt-in `test/e2e/discovery.test.mjs` against real Claude
  Code and Codex; `test/manual-checks.md` entries for the other harnesses, run
  under the follow-up change `harness-discovery-checks`.
- No new runtime dependency.
- Slices merge to `main` one at a time.
- The owner's machine, after upgrading: `npm run agents -- install --agent
  claude,codex` (moves Codex's copies), then `repos setup` on any other machine.
