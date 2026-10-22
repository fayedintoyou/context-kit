# Design

## Context

See proposal.md for why. Today, from the code:

- `lib/repos.mjs` renders one `my-repos` skill into `.state/generated/`. If its
  description goes over 1,000 characters, it drops every alias at once and adds
  "(aliases in the skill)". The body hardcodes `cd "<root>" && npm run -s hub -- …`.
  `scanRepositories` checks the directory and its immediate subdirectories, and
  `checkout()` accepts only a path that is the top of its own checkout. A linked
  worktree passes that test, so a scan could record a `/tmp` worktree.
- `lib/install.mjs` has an `AGENTS` table with two entries. Each has a CLI, a
  frontmatter key filter (`CODEX_KEYS`, five keys) and a skills directory
  function. MCP servers are registered through the agent's CLI (`claude|codex mcp
  add`) with absolute paths for Node, the core's `bin/mcp.mjs` and `--root`.
  Install records (`.state/agents.json`) cover skills, MCP servers, git hooks and
  the merge guard. They are read and written per kind with an
  installed/changed/missing state, and nothing the installer didn't write gets
  overwritten.
- `lib/mcp/server.mjs` builds one server for both transports. `list_repos`
  returns `path` the same way on both.

The registry already works the same for one person on several machines as for a
team: the Repository concepts travel through the workspace's git, and each machine
keeps `.state/checkouts.json` and renders its own skill. This change keeps that
model. Everything machine-specific is rendered or recorded per machine, and
nothing machine-specific goes into a hub.

## Goals / Non-Goals

**Goals:**
- Any session, in any directory, on any supported harness, selects the routing skill
  when a request names one of the user's repositories, and can resolve it in one
  step.
- A new machine gets from "every repository missing" to "routed" with one command.
- Every write outside the workspace can be undone with `agents uninstall` and never
  overwrites user text.

**Non-Goals:**
- What "resolving" returns beyond the path. `repo-context` defines a resolve-and-load
  operation (repository context, pointers, a bounded tree). This change only
  requires the skill to name the workspace's resolve operation, so either change
  can land first.
- Mounted team hubs (`hub-federation`). Their Repository concepts feed the same
  registry, so they need nothing extra here.
- Plugin or marketplace packaging (open question 1).

## Decisions

### 1. The skill's frontmatter is the mechanism; a global rule is an optional extra

Harnesses load every installed skill's `name` and `description` at startup and pick
a skill by matching the request against its description. So a description naming
each repository's title and aliases routes from any directory, with nothing loaded
into the context beyond about 100–250 tokens. This is the pattern the owner already
relies on at work: a base template skill whose frontmatter is regenerated from the
repository list on install.

An always-loaded instruction file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`)
was considered as the primary mechanism and rejected:
- It costs tokens in every session, not only the ones that name a repository.
- It means splicing a managed block into a file the user owns.
- Codex reads only the first non-empty of `AGENTS.override.md` and `AGENTS.md`, so
  a block in one of them can be silently shadowed by the other.
- OpenCode stops reading `~/.claude/CLAUDE.md` as soon as
  `~/.config/opencode/AGENTS.md` exists, so creating that file changes behavior
  the user didn't ask to change.

The extra is `--global-rule`, and only where a harness has a rules directory the
installer can own a whole file in: Claude Code's `~/.claude/rules/` (or
`$CLAUDE_CONFIG_DIR/rules/`), which Claude Code loads in every project. The file
is `context-kit.md`, under 600 characters. It says: your repositories resolve from
any directory; use the `<server>` MCP server's resolve tool or `context-kit repos`;
read the checkout's `AGENTS.md`/`CLAUDE.md` before changing it. It never lists
repositories, so it doesn't grow with them. The opt-in is recorded, so a plain
reinstall keeps it. `--no-global-rule` or uninstall removes it. This differs on
purpose from `--allow-write`, which a reinstall without the flag drops: losing
write access by accident is safe, but a rule that disappears silently is not
(open question 7). Every other harness reports
`unsupported`. Managed blocks in `AGENTS.md` and similar files stay an open
question (2).

### 2. Keyword budget, then shards

The Agent Skills specification caps `description` at 1,024 characters. Claude Code
truncates `description` plus `when_to_use` at 1,536 in its listing. claude.ai and
the Skills API reject non-standard keys. So the budget is 1,024, and the fixed
lead and tail sentences count against it.

Fill order, deterministic for the same inputs:
1. Every repository's title, in id order.
2. Round *k* for k = 1, 2, …: each repository's *k*-th alias in concept order,
   skipping aliases equal to a title already named (case-insensitive). A keyword
   that doesn't fit is skipped, and the round continues, because a shorter later
   alias may still fit.
3. Results (`repos sync`, `agents install`, `refreshGeneratedSkills`) carry
   `skipped: {<repo-id>: [aliases]}`. The body's YAML table and `metadata` still
   list every alias, so an agent that opened the skill sees them all.

Round-robin rather than per-repository: one repository with twenty aliases must
not crowd the others' first alias out. The first alias is usually the name people
use most.

If the titles alone don't fit, the repositories are split, in id order, into
consecutive runs whose titles plus first aliases fit. Each run becomes its own
shard: `my-repos`, `my-repos-2`, … (valid names under the spec's
`[a-z0-9-]`, no `--`). Each shard's body lists only its own repositories and
says how to list them all. Shards are generated skills, so the existing
reconcile, sync and removal rules apply to them unchanged. The alternative, one
skill per hub, was rejected: a single large hub would still overflow.

A `keywords` field on Repository concepts (trigger words that aren't names, such as
"my website") would feed round 2 after aliases. It's left as open question 3
because `repo-context` also extends Repository concepts.

### 3. Standard frontmatter, validated in tests

Generated skills emit only `name`, `description` and `metadata` (string to string,
as today). The installer's key filter for `~/.agents/skills` copies of bundled
skills becomes the six standard keys. `CODEX_KEYS` already lacks `compatibility`,
which is harmless, but the filter for the shared location is the full standard set.
The end-to-end test checks the specification's rules directly: allowed keys, the
name pattern, name equal to the directory, the description length, and string
metadata. Running the `skills-ref` reference validator (Python) in CI is open
question 4. It's a useful second opinion, but a Python toolchain in this Node
repository's CI is a cost the owner should choose.

### 4. Harnesses: confirmed from vendor documentation (2026-10-22)

| Harness | User skills | MCP registration | Rules dir |
|---|---|---|---|
| Claude Code (`claude`) | `$CLAUDE_CONFIG_DIR` or `~/.claude/skills`; doesn't read `~/.agents/skills` | `claude mcp add -s user` | `~/.claude/rules/` |
| Codex (`codex`) | `$HOME/.agents/skills` (USER scope in Codex's skills docs; `$CODEX_HOME/skills` no longer listed) | `codex mcp add` | none (`$CODEX_HOME/AGENTS.md` only) |
| Gemini CLI (`gemini`) | `~/.gemini/skills` or the `~/.agents/skills` alias, which wins within a tier | `gemini mcp add -s user`, `gemini mcp remove -s user` (`~/.gemini/settings.json`) | none (`~/.gemini/GEMINI.md`) |
| GitHub Copilot CLI (`copilot`) | `~/.copilot/skills` or `~/.agents/skills` | `$COPILOT_HOME/mcp-config.json` (`mcpServers.<name>: {type: "local", command, args, tools: ["*"]}`); `copilot mcp add` exists, but its get/remove aren't documented | none (`copilot-instructions.md`) |
| Cursor (`cursor`) | `~/.cursor/skills`, `~/.agents/skills`, and also `~/.claude/skills` and `~/.codex/skills` | `~/.cursor/mcp.json` (`mcpServers.<name>: {type: "stdio", command, args}`); no CLI | none: user rules aren't on the file system |
| OpenCode (`opencode`) | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | `~/.config/opencode/opencode.json` (`mcp.<name>: {type: "local", command: [...], enabled: true}`); no add command | none (`AGENTS.md`, falling back to `~/.claude/CLAUDE.md`) |

Sources: code.claude.com/docs/en/skills and /memory; learn.chatgpt.com/docs/build-skills
and /agent-configuration/agents-md (Codex); geminicli.com/docs/cli/skills,
/cli/gemini-md, /tools/mcp-server; docs.github.com Copilot CLI "add skills", "add
MCP servers" and "configuration directory"; cursor.com/docs/context/skills and
/context/mcp; opencode.ai/docs/skills, /rules, /config, /mcp-servers.

**Later: Antigravity CLI.** Google's pages disagree on its user skills directory
(`~/.gemini/config/skills` and `~/.gemini/antigravity/skills`), and its global
`mcp_config.json` path isn't documented. Gemini CLI docs say Antigravity CLI
replaced Gemini CLI for unpaid users on 2026-06-18, so it's the next to add once
its documentation is consistent. It will very likely read `~/.agents/skills` with
no change here.

`AGENTS` entries gain `reads: [locations]`, `mcp: {kind: 'cli'|'json', …}` and
`rules: path|null`. `--agent` defaults stay `claude,codex`, so existing installs
and `setup` behave as before. `all` selects every entry.

### 5. Fewest skill locations

Locations: `claude` (Claude Code's directory) and `agents` (`~/.agents/skills`).
Read by: Claude Code {claude}; Codex, Gemini, Copilot {agents}; Cursor, OpenCode
{claude, agents}. The installer picks `claude` if Claude Code is selected, `agents`
if Codex, Gemini or Copilot is, and when only Cursor or OpenCode remain uncovered,
`agents`. Cursor and OpenCode still see two copies when both locations are
needed. For generated skills those copies are byte-identical, since they use
standard keys only. For bundled skills, the Claude copy may keep Claude-only keys.
Symlinking one into the other was rejected: those harnesses would still list both,
and Cowork skips symlinked user files. This is open question 5.

Codex's move: records under `$CODEX_HOME/skills` are reconciled like a disabled
addon's skills (unchanged ones removed, edited ones kept and reported), and the new
copies are recorded under `~/.agents/skills` with agent `codex`. One location
record can serve several harnesses: records gain `agents: [...]`, and uninstalling
one harness removes a shared copy only when no other installed harness still needs
it.

### 6. MCP through JSON config files

Copilot, Cursor and OpenCode registrations follow the merge guard's file-handling
rules (`readSettings`/`writeSettings`): strict `JSON.parse`, with any failure,
JSONC comments included, refused as `CONFIG_MALFORMED` without writing. Writes go to
a temporary file plus rename, keeping the file's mode (new files `0600`). The
record holds the exact entry. State is installed, edited or missing, and uninstall
removes only an unedited entry, along with any containers it created. Stripping
comments from JSONC and re-serializing would lose the user's comments, so refusing
is the honest choice. The report says to move the comments or add the entry by
hand. Copilot uses the file rather than `copilot mcp add` so that status and
uninstall don't depend on undocumented subcommands. Project scope skips MCP for
the four new harnesses. Their project config files are usually committed, which
`agent-installation / Scopes` already avoids for Claude Code.

### 7. Path portability: the MCP server by name, and a launcher

What breaks when the workspace moves is the absolute `cd` in the skill. The MCP
registration's `--root` breaks too. Options:

- **MCP tools only.** The server's name is stable and its tools work from any
  directory, but not every session has MCP connected (`claude -p` without it,
  sandboxed runs), and remedies like `repos clone` are CLI-only by design.
- **`npx github:fayedintoyou/context-kit`.** No fixed path, but it's slow, needs the
  network, and runs a core other than the instance's pinned one.
- **A launcher (chosen, alongside MCP).** `agents install` writes
  `${XDG_BIN_HOME:-~/.local/bin}/context-kit`, a managed `#!/bin/sh` script like
  the git hooks (`HOOK_MARK`, recorded hash) that execs this machine's Node, the
  instance's pinned `bin/hub.mjs` and `--root <workspace>`. The skill names it by
  that absolute home-relative path, which doesn't move with the workspace, and
  by `context-kit` when its directory is on `PATH`. When the workspace moves, the
  launcher fails with `WORKSPACE_MOVED`, naming the old path and `npm run agents
  -- install`. `agents status` compares each record's root with the current one
  and reports `moved`. One `agents install` rewrites the launcher, the MCP
  registrations and the skills. The skill's text doesn't change.

The body names one operation (decision 8) as `<server>`'s tool and as `context-kit
<command>`. It ends with `Workspace: <root>` for humans only. One workspace per user
per machine is assumed, as `my-repos` already does. A second workspace's launcher is
a conflict unless `--force` (open question 6).

### 8. One resolve operation, whichever change lands first

`routingSkill()` asks the operations table for `resolve`. That's
`repo-context`'s resolve-and-load operation when it exists, otherwise `list_repos`
(CLI `repos`). The body names only that operation, so the skill's guidance comes
down to "resolve it, then read its `AGENTS.md`". The requirement doesn't name
`repo-context`'s operation, so the spec stays true in either landing order.
Whichever change lands second updates one table entry and its test.

### 9. `repos setup`, scan depth and worktrees

- `scanRepositories(root, directories, {depth})` walks breadth-first, sorted,
  skipping hidden directories, `node_modules` and the inside of any checkout found
  (`rev-parse --show-toplevel` equals the candidate). The depth is capped at 6
  because home directories are large.
- A worktree is detected by `git rev-parse --git-common-dir` differing from
  `--git-dir`. The main checkout is the common directory's parent when that's a
  non-bare working tree.
- `repos setup`: CLI-only, a write (`cliOnly: true, write: true`). Steps: scan (default
  `$HOME`, depth 2), then a missing list. Prompts happen when `process.stdin.isTTY`
  or `--ask`, reading one line per missing repository: a path (locate), `clone`,
  `clone <path>`, or empty (skip). With piped answers and `--ask`, tests drive it.
  `--clone a,b` clones named repositories without asking. A repository is never
  cloned without being named or answered `clone`. It ends with
  `refreshGeneratedSkills` and reports the harnesses where the skill isn't
  installed yet (`agents install` next). An agent can run it for the user, but the
  routing skill tells agents to ask before cloning, as it does today.

### 10. `repos which` and `which_repo`

A pure lookup: `git rev-parse --show-toplevel` from the path, its remotes
normalized as in `locate`, matched against the registry. Status is `recorded`
(the top equals the recorded path), `worktree` (its common-dir main checkout is the
recorded path), or `unrecorded`. A path inside `<workspace>/hubs/<hub>` reports the
hub. Anything else reports `{repository: null}` with exit 0, because "not one of
mine" is an answer, not an error. `which_repo` takes an absolute path and is offered
only over stdio: over HTTP the path would be the client's, which the server can't
see (decision 11).

### 11. Remote path honesty

`serverFactory` already knows its transport (`bin/mcp.mjs` picks one). It passes
`transport: 'http'` in the selection, plus `machine` from `--machine-name` or
`os.hostname()`. `operations()` hides `which_repo` over HTTP. `list_repos` over HTTP
returns `machine` and `servingMachinePath`, and its description says so. Renaming
the key, rather than adding a label beside `path`, means a client that reads `path`
gets nothing instead of a wrong directory.

This is a deliberate exception to the in-flight `remote-access / HTTP transport`
requirement, under which HTTP offers "the same tools … with equivalent results" as
stdio. The new requirement states the exception without editing that one, so
either change can archive first. A later gardening pass can fold the exception
into `remote-access`. Making it depend on an option (`--machine-name`) instead
would keep strict equivalence, but an HTTP server started without the option
would silently send unlabeled paths again, which is the failure this fixes. Omitting paths entirely was considered.
But the owner on another device sometimes wants to know where a checkout lives on
the home machine, so a labeled path is more useful.

### Delivery

Slices merge into an integration branch, `machine-setup`, which merges to `main`
once every scenario is linked. The spec-link gate checks every scenario of an
in-flight change, so a slice can't pass it on `main` alone. This is the
`remote-mcp-access` precedent. The slices themselves are independent where their
code allows (slices.yaml).

### Testing

Everything is end-to-end through the CLI and stdio/HTTP MCP clients, with an
isolated machine as in `test/e2e/agents.test.mjs`: temporary `HOME`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `XDG_CONFIG_HOME`,
`XDG_BIN_HOME`, and a `PATH` with fake `claude`, `codex` and `gemini` CLIs that log
their calls. Git fixtures cover nested checkouts, hidden directories, linked
worktrees (`git worktree add`), and local bare upstreams for clones. Prompts are
driven with `--ask` and piped stdin. Fictional names only (`room`, `studio`,
`example/site`).

## Risks / Trade-offs

- [Harness docs change: Codex already moved its user skills directory] → paths live
  in one table with doc sources. `agents status` reports a recorded copy that went
  missing. Later moves are one-row changes.
- [Duplicate listings in Cursor and OpenCode when Claude Code and a shared-location
  harness are both selected] → generated copies are identical. Open question 5.
- [The launcher's directory isn't on `PATH`] → the skill uses its absolute path, and
  status reports `onPath: false` with the export line to add.
- [Refusing JSONC configs leaves OpenCode users without MCP] → the report gives the
  exact entry to paste. Skills still install, and the skill's CLI route through
  the launcher works without MCP.
- [Deep scans of a home directory are slow] → default depth 2, cap 6, pruning at
  checkouts and hidden directories. Setup reports what it scanned.
- [Shards split the routing guidance across several skills] → each shard's body is
  self-contained, and each says how to list every repository.
- [The skill can't stop an agent from searching anyway] → unchanged from today. This
  change only makes the right path cheaper.

## Migration Plan

Additive for Claude Code. For Codex, the next `agents install` moves the skills from
`$CODEX_HOME/skills` to `~/.agents/skills` (decision 5) and writes the launcher.
`agents status` before that install reports the routing skill `stale` (new body).
Rollback: `agents uninstall` removes the launcher, the rule and every copy. A
reinstall with the previous core restores the old locations.

## Open Questions

These are for the owner. The specs take the proposed default for each; a different
answer to 2, 5, 6 or 7 means a small spec edit, not a new approach.

1. **Plugin packaging.** Distribute the core and its skills as plugin packages built
   from one source: Agent Plugins 1.0 (agent-plugins.org: `plugin.json` +
   `skills/` + `mcp.json`, used by Copilot and VS Code and reportedly by Codex and
   Cursor), and a Claude Code `.claude-plugin` marketplace. docs/next.md keeps the
   npx installer for now. The generated `my-repos` skill is per machine, so it
   would stay with the installer even then.
2. **Managed instruction blocks.** Also offer an opt-in delimited block in
   `$CODEX_HOME/AGENTS.md` (or the non-empty `AGENTS.override.md`),
   `~/.gemini/GEMINI.md`, `$COPILOT_HOME/copilot-instructions.md` and
   `~/.config/opencode/AGENTS.md` (only when it already exists, since creating it
   disables OpenCode's `CLAUDE.md` fallback)? Default: no; skills are enough.
3. **`keywords` on Repository concepts.** Trigger words that aren't names. They need
   coordinating with `repo-context`, which also extends the concept.
4. **`skills-ref` in CI.** Run the reference validator (Python, `uvx`) on generated
   skills as well as the end-to-end rule checks?
5. **Duplicates in Cursor and OpenCode.** Accept identical copies (proposed), or let
   the owner drop one location with a flag?
6. **Several workspaces on one machine.** One launcher and one `my-repos` per user
   today. Should a second workspace (for example, a work one) get a suffixed
   launcher and skill (`context-kit-work`, `my-repos-work`)?
7. **Persistence of `--global-rule`.** Kept across plain reinstalls (proposed), or
   present only when each install passes the flag, as `--allow-write` is?
