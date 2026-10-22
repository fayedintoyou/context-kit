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
- Plugin or marketplace packaging (deferred; see Decided defaults).

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
- OpenCode (a later harness) stops reading `~/.claude/CLAUDE.md` as soon as
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
(adopted default). Every other harness reports `unsupported`. Managed blocks in
`AGENTS.md` and similar files are off (adopted default).

### 2. Effective trigger names, keyword budget, shards: one algorithm

**Limits.** The Agent Skills specification caps `description` at 1,024 characters,
counted here as Unicode code points, as the reference validator's Python `len`
does. Claude Code truncates `description` plus `when_to_use` at 1,536 in its
listing, and claude.ai and the Skills API reject non-standard keys. So the budget
is 1,024, and every fixed character counts against it: the lead, the shard marker,
separators and the tail.

**Input: effective trigger names.** The renderer asks the registry for each
repository's effective names (titles, aliases, keywords), never the raw concept
fields. Until another change narrows them, every valid name is effective.
`hub-federation` will narrow them with an ADDED requirement: workspace hubs win
over mounts, and a name two mounts claim is excluded, reachable by qualified id.
This change only depends on the registry returning, per repository,
`{title|null, aliases[], keywords[]}`, already filtered. A name over its length
bound (see below) is never effective. A repository's **primary name** is its
effective title, else its first effective alias (which then leaves the alias
round), else its id.

**Name bounds** (`validate`, new requirement *Repository keywords and name
bounds*): titles at most 80 characters, aliases and keywords at most 60. Keywords
must not equal another repository's title or alias, because that would route the
request to the wrong repository. The bounds guarantee that any single repository's
minimal entry fits a description on its own (80 + 60 + separators + fixed text,
about 300 characters).

**Rendering.** `description = lead + marker + entries.join("; ") + tail`, where an
entry is `primary` or `primary (n1, n2, …)` and names inside the parentheses are
joined by `", "`. The marker is empty for a single skill and `(k of n) ` for shards.
Its width is reserved at the maximum digits for `n`, so adding a shard never
overflows an earlier one.

**One algorithm** (deterministic: repositories in id order, names in concept order,
names deduplicated case-insensitively against the repository's names already
included):
1. *Partition.* Walk repositories in id order. Add a repository to the current
   shard if the description of the shard's minimal entries, with this one added,
   still fits. A minimal entry is the primary name plus the first effective alias,
   if any. Otherwise start the next shard. There is one shard iff all minimal
   entries fit together.
2. *Fill each shard* in rounds: alias round k = 1, 2, … (every repository's k-th
   remaining alias in id order), then keyword round k = 1, 2, …. A name that doesn't
   fit is skipped and the round continues, since a shorter later name may fit.
   Each candidate is measured against the full re-rendered description, so
   separators and parentheses opening are counted exactly.
3. *Report.* Results carry `skipped: {<repo-id>: [names]}`. The body's table and
   `metadata` keep every alias and keyword, so an agent that opens the skill sees
   them all.

Shard names are `my-repos`, `my-repos-2`, … (valid under the spec's `[a-z0-9-]`, no
`--`). Shards are generated skills, so the existing reconcile, sync and removal
rules apply to them. Round-robin rather than per-repository means one repository
with twenty aliases can't crowd out the others' first alias. Partitioning on
minimal entries rather than titles alone gives every repository at least its most
common nickname. The alternative, one skill per hub, was rejected: a single large
hub would still overflow. Tests sit at the exact boundaries (1,024 and 1,025), use
multi-code-point text (accents, emoji), the longest allowed singleton, and
shrinkage.

**Keywords** are adopted now (owner decision): optional `keywords` on Repository
concepts, topic phrases distinct from aliases ("personal site", "portfolio"),
with priority titles → aliases → keywords. They aren't identifiers: `repos
locate|clone|which` don't accept them, and two repositories may share one.

### 3. Standard frontmatter, validated in tests

Generated skills emit only `name`, `description` and `metadata` (string to string,
as today). The installer's key filter for `~/.agents/skills` copies of bundled
skills becomes the six standard keys. `CODEX_KEYS` already lacks `compatibility`,
which is harmless, but the filter for the shared location is the full standard set.
The end-to-end test checks the specification's rules directly: allowed keys, the
name pattern, name equal to the directory, the description length, and string
metadata. Adopted default: an optional `npm run skills-ref` script runs the
reference validator at a pinned version (`uvx --from skills-ref==<pinned>`) on the
rendered skills when `uv` is available. It isn't a required CI job, because a Python
toolchain in this Node repository's CI is a cost the owner hasn't chosen.

### 4. Harnesses: confirmed from vendor documentation (2026-10-22)

| Harness | User skills | MCP registration | Rules dir |
|---|---|---|---|
| Claude Code (`claude`) | `$CLAUDE_CONFIG_DIR` or `~/.claude/skills`; doesn't read `~/.agents/skills` | `claude mcp add -s user` | `~/.claude/rules/` |
| Codex (`codex`) | `$HOME/.agents/skills` (USER scope in Codex's skills docs; `$CODEX_HOME/skills` no longer listed) | `codex mcp add` | none (`$CODEX_HOME/AGENTS.md` only) |
| Gemini CLI (`gemini`) | `~/.gemini/skills` or the `~/.agents/skills` alias, which wins within a tier | `gemini mcp add -s user`, `gemini mcp remove -s user` (`~/.gemini/settings.json`) | none (`~/.gemini/GEMINI.md`) |
| GitHub Copilot CLI (`copilot`) | `~/.copilot/skills` or `~/.agents/skills` | `$COPILOT_HOME/mcp-config.json` (`mcpServers.<name>: {type: "local", command, args, tools: ["*"]}`); `copilot mcp add` exists, but its get/remove aren't documented | none (`copilot-instructions.md`) |
| Cursor (`cursor`) | `~/.cursor/skills`, `~/.agents/skills`, and also `~/.claude/skills` and `~/.codex/skills` | `~/.cursor/mcp.json` (`mcpServers.<name>: {type: "stdio", command, args}`); no CLI | none: user rules aren't on the file system |

Sources: code.claude.com/docs/en/skills and /memory; learn.chatgpt.com/docs/build-skills
and /agent-configuration/agents-md (Codex); geminicli.com/docs/cli/skills,
/cli/gemini-md, /tools/mcp-server; docs.github.com Copilot CLI "add skills", "add
MCP servers" and "configuration directory"; cursor.com/docs/context/skills and
/context/mcp.

Precedence between directories a harness reads twice: Gemini CLI documents it
(`~/.agents/skills` wins over `~/.gemini/skills`), and we never write the latter.
Cursor reads `~/.claude/skills`, `~/.agents/skills` and `~/.codex/skills`, and its
docs give no precedence, so identical copies are reported as a warning, never
assumed harmless (requirement *Copies a harness may see twice*).

**Capacity limits.** The reviewer reports that Codex may shorten skill descriptions
or leave skills out of its listing when many are installed. I couldn't confirm the
exact thresholds in Codex's documentation. The discovery checks (decision 12)
record what each harness actually lists, and the install docs state each harness's
documented limits next to the table, saying "not documented" where they aren't.

**Later: OpenCode.** OpenCode reads `~/.agents/skills` and `~/.claude/skills`, so
its skills already work through decision 5. Its MCP registration has two config
shapes (v1 `mcp.<name>` with `enabled`, v2 `mcp.servers.<name>` with `disabled`),
JSONC files, and an `opencode mcp add` command. Supporting it properly means
detecting the version and choosing an adapter, refusing unknown shapes and
handling `.jsonc`. That is its own small change, so OpenCode isn't in `--agent`
here (review round 1). Its documented override precedence would also make its
two copies an override rather than a duplicate.

**Later: Antigravity CLI.** Google's pages disagree on its user skills directory
(`~/.gemini/config/skills` and `~/.gemini/antigravity/skills`), and its global
`mcp_config.json` path isn't documented. Gemini CLI's MCP page carries a notice
about Antigravity CLI replacing it for some users. That isn't verified further
here and doesn't change this plan. Antigravity is added once its documented paths
agree.

`AGENTS` entries gain `reads: [locations]`, `mcp: {kind: 'cli'|'json', …}` and
`rules: path|null`. `--agent` defaults stay `claude,codex`, so existing installs
and `setup` behave as before. `all` selects every entry.

### 5. Fewest skill locations

Locations: `claude` (Claude Code's directory) and `agents` (`~/.agents/skills`).
Read by: Claude Code {claude}; Codex, Gemini, Copilot {agents}; Cursor {claude,
agents}. The installer picks `claude` if Claude Code is selected, and `agents` if
Codex, Gemini or Copilot is, or if Cursor is otherwise uncovered. Cursor sees two
copies when both locations are needed. Generated copies are byte-identical,
because they use standard keys only. For bundled skills, the Claude copy may keep
Claude-only keys. With no documented precedence, install reports a warning
(adopted default: accept copies only where precedence is verified, and warn
otherwise). Symlinking one into the other was rejected: Cursor would still list
both, and Cowork skips symlinked user files.

One location record can serve several harnesses: records gain `agents: [...]`, and
uninstalling one harness removes a shared copy only when no other installed
harness still needs it.

**Codex's move, verified before removing.** For each record under the recorded
legacy path (the path in the record, not today's `$CODEX_HOME`):
1. install the replacement into `~/.agents/skills` (the normal conflict rules
   apply: foreign or edited destination → conflict);
2. verify that the replacement's hash matches the rendered or adapted source;
3. only then remove the legacy copy and its record.

If step 1 or 2 fails (conflict, unwritable directory, hash mismatch), the legacy
copy and its record stay, and the result says why. An edited legacy copy is never
removed without `--force`. The order means a failed upgrade leaves Codex with its
old, working skills.

### 6. MCP through JSON config files

Copilot and Cursor registrations follow the merge guard's file-handling
rules (`readSettings`/`writeSettings`): strict `JSON.parse`, with any failure,
JSONC comments included, refused as `CONFIG_MALFORMED` without writing. Writes go to
a temporary file plus rename, keeping the file's mode (new files `0600`). The
record holds the exact entry. State is installed, edited or missing, and uninstall
removes only an unedited entry, along with any containers it created. Stripping
comments from JSONC and re-serializing would lose the user's comments, so refusing
is the honest choice. The report says to move the comments or add the entry by
hand. Copilot uses the file rather than `copilot mcp add` so that status and
uninstall don't depend on undocumented subcommands. Copilot documents JSONC for
`settings.json`, but not for `mcp-config.json`. Either way a commented file is
refused, not rewritten. Project scope skips MCP for the three new harnesses. Their project config files are usually committed, which
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
<command>`. Every command in the body (clone, locate, concept read, recovery) goes
through the launcher. It ends with `Workspace: <root>` for humans only.

**One workspace per user per machine (adopted default: reject, not namespace).**
`my-repos` and the launcher are one per user already. Namespacing (`my-repos-work`,
`context-kit-work`) would double every harness's routing surface, and two skills
would both claim "my repositories". So `agents install` checks first. If the
launcher or a user-scope generated skill names another workspace root, it fails
with `WORKSPACE_CONFLICT` before writing anything. `--force` takes over only the
launcher and generated skills. A person with several workspaces should mount one
in the other (`hub-federation`).

### 8. One resolve operation, whichever change lands first

`routingSkill()` asks the operations table for the operation marked `resolve`.
That's `repo-context`'s resolve-and-load operation (`repos open <id>` / MCP
`open_repo`) when it exists, otherwise `list_repos` (CLI `repos`). The body names only that operation, so the skill's guidance comes
down to "resolve it, then read its `AGENTS.md`". The requirement doesn't name
`repo-context`'s operation, so the spec stays true in either landing order.
Whichever change lands second updates one table entry and its test.

### 9. `repos setup`, scan depth and worktrees

- `scanRepositories(root, directories, {depth})` walks breadth-first, sorted,
  skipping hidden directories, `node_modules` and the inside of any checkout found
  (`rev-parse --show-toplevel` equals the candidate). The depth is capped at 6
  because home directories are large.
- A linked worktree is detected by `git rev-parse --git-common-dir` differing from
  `--git-dir`. Its main worktree is the first entry of `git worktree list
  --porcelain`, not the common directory's parent, which is wrong for a
  `--separate-git-dir` checkout. An entry marked `bare`, or a path that no longer
  exists (`prunable`), means there's nothing to record, and the result says why.
  Every path is `realpath`-normalized before it's compared or recorded.
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

A pure lookup: `realpath` the input, take `git rev-parse --show-toplevel` from it,
which is the innermost checkout (a submodule's own top inside its parent), and
match its remotes, normalized as in `locate`, against the registry. It never
retries from the parent directory: an unrelated repository nested in one of yours
is "not yours", not yours by inheritance. If several remotes match different
registered repositories, `origin` decides. Without an `origin` match, the result
is `ambiguous` with the candidates in id order, and an exit status of 0. Status is
`recorded` (the top equals the recorded path), `worktree` (the main worktree from
`git worktree list --porcelain` is the recorded path), or `unrecorded`. A bare or
missing main gives `worktree` with `main: null` and a reason. A path inside `<workspace>/hubs/<hub>` reports the
hub. Anything else reports `{repository: null}` with exit 0, because "not one of
mine" is an answer, not an error. `which_repo` takes an absolute path and is offered
only over stdio: over HTTP the path would be the client's, which the server can't
see (decision 11).

### 11. Remote path honesty (this change owns the remote policy)

`serverFactory` already knows its transport (`bin/mcp.mjs` picks one). It passes
`transport: 'http'` in the selection, plus `machine` from `--machine-name` or
`os.hostname()`. Operations gain a `localOnly: true` flag beside `cliOnly`, and
`operations()` drops every local-only tool over HTTP, so a call to one is an
unknown tool. The rule is "tools that resolve a path or checkout on this machine
are local-only". `which_repo` is the first. `repo-context`'s `open_repo` and
`context_pack` declare the flag in that change; this one doesn't depend on their
names. `list_repos` over HTTP returns `machine` and `servingMachinePath`, and its
description says so. Renaming the key, rather than adding a label beside `path`,
means a client that reads `path` gets nothing instead of a wrong directory.
Omitting paths was considered, but the owner on another device sometimes wants to
know where a checkout lives on the home machine.

This MODIFIES `remote-access / HTTP transport` and its parity scenario, and ADDs
`Local-only tools` and `Serving machine paths` to `remote-access`. Tying the
behavior to an option (`--machine-name`) would have kept strict parity, but an HTTP
server started without it would silently send unlabeled paths, which is the
failure this fixes. **Ordering:** `remote-access` becomes canonical when
`remote-mcp-access` archives (its last task is the owner's live deploy check).
Changes archive by name, so until then the archive rehearsal reports
`machine-setup` as unarchivable. This change can't merge to `main` before
`remote-mcp-access` is archived.

### 12. Discovery checks

Files on disk aren't proof that a harness sees a skill. Each harness gets a
discovery check: install into an isolated home, start a session in a temporary
directory outside every checkout, and confirm the listing includes `my-repos`
with the repository's name.
- Claude Code and Codex: `test/e2e/discovery.test.mjs`, opt-in with
  `CONTEXT_KIT_HARNESS_SMOKE=1` and the real CLIs authenticated. It runs on the
  owner's machine, not in CI, which has neither CLI.
- Gemini CLI, Copilot CLI and Cursor: `test/manual-checks.md` entries, with the
  harness version, date and outcome recorded when run.

Both forms link the scenario *Routing skill is discovered*.

### Delivery

The slices are meant to merge to `main` one at a time once the prerequisite change
`slice-aware-links` makes the spec-link gate check only the scenarios of landed or
in-progress slices. Then the `base` line comes out of slices.yaml. Until that
lands, the slices merge into an integration branch, `machine-setup`, which merges
to `main` once every scenario is linked (the `remote-mcp-access` precedent).

**Landing order across the sibling plans** (coordinator, 2026-10-22):
1. `slice-aware-links`;
2. this change's routing and frontmatter slices (`skill-frontmatter`,
   `portable-entry`);
3. `repo-context`'s open/routing slices, which plug `repos open`/`open_repo` into
   decision 8 and mark them local-only;
4. `hub-federation`'s `mounted-repositories`, which narrows the effective trigger
   names.

The other slices here are independent of 3 and 4. `remote-mcp-access` must archive
before this change archives (decision 11). Whichever change archives later rebases
its MODIFIED routing requirements (`Generated routing skill`, `Routing skill
guidance`) on the one before.

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
- [Cursor lists two copies when Claude Code and a shared-location harness are both
  selected; precedence is undocumented] → generated copies are identical, and
  install warns.
- [A harness shortens descriptions or drops skills when many are installed] →
  discovery checks record what's actually listed, and documented limits are in the
  install docs.
- [The launcher's directory isn't on `PATH`] → the skill uses its absolute path, and
  status reports `onPath: false` with the export line to add.
- [Refusing commented configs leaves a Copilot user without MCP] → the report gives
  the exact entry to paste. Skills still install, and the skill's CLI route through
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

## Decided defaults (review round 1)

The owner's open questions, closed by the coordinator with these defaults:
1. Plugin packaging (Agent Plugins 1.0, Claude Code marketplaces from one source)
   is deferred. docs/next.md keeps the npx installer, and the per-machine
   `my-repos` would stay with the installer anyway.
2. Managed instruction blocks in `AGENTS.md`, `GEMINI.md` and similar files are off.
3. `keywords` ship now (decision 2).
4. `skills-ref` validation is optional and pinned, not a required CI job (decision
   3).
5. Copies a harness reads twice are accepted only where its precedence is
   documented; otherwise install warns (decision 5).
6. A second workspace on one machine is rejected with `WORKSPACE_CONFLICT`, not
   namespaced (decision 7).
7. `--global-rule` persists until `--no-global-rule` or uninstall (decision 1).
