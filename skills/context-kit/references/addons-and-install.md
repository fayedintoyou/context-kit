# Addons and installing

## Addons

| Addon | Gives you |
|---|---|
| `core` (always) | Hubs, browse, read, search, capture, skills, help, and this skill |
| `specs` | OpenSpec specs and audits, and the `audit-canonical-specs` skill |
| `maps` (opt-in) | Behavior maps checked and rendered from specs, and the `behavior-map` skill |
| `reflect` | The `reflect` skill |
| `review` | The `independent-review` skill |

The workspace's `context-kit.json` lists enabled addons:
`{"version": 1, "addons": ["reflect", "specs"]}`. `addons` shows what is
available and enabled. Disabled addons' tools disappear and their CLI commands
return `ADDON_DISABLED`. Choose at creation with `--addons a,b` or `--addons none`.
Without `--addons`, a new workspace gets every kit addon except opt-in ones
(`maps`): name them, as in `--addons maps,specs`, or add them to
`context-kit.json` later.

**Your own skills** become an addon: create `addons/<name>/addon.json`
(`{"name", "description", "skills": ["my-skill"]}`) and
`addons/<name>/skills/my-skill/SKILL.md` in the workspace, then enable it.
Workspace addons carry skills only, never code.

## Installing into agents

```sh
npm run agents -- install [--agent claude,codex] [--scope user|project] [--project <dir>]
                          [--name <server>] [--link] [--allow-write] [--force] [--adopt] [--global-mcp]
                          [--global-rule | --no-global-rule]
npm run agents -- status
npm run agents -- uninstall [--agent claude,codex]
```

- `--agent` takes `claude`, `codex`, `gemini` (Gemini CLI), `copilot` (GitHub
  Copilot CLI), `cursor` or `all`; the default is `claude,codex`. Any other name
  fails with `INVALID_INPUT` naming them, before anything is written. `status`
  covers every harness, and `uninstall` without `--agent` removes them all.

  | Harness | User skills it reads | MCP registration | Documented limits |
  |---|---|---|---|
  | Claude Code | `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) | `claude mcp add -s user` | listing truncates `description` plus `when_to_use` at 1,536 characters |
  | Codex | `~/.agents/skills` | `codex mcp add` | not documented |
  | Gemini CLI | `~/.agents/skills` (wins over `~/.gemini/skills`) | `gemini mcp add -s user` (`~/.gemini/settings.json`) | not documented |
  | Copilot CLI | `~/.agents/skills`, `~/.copilot/skills` | `mcpServers` in `$COPILOT_HOME/mcp-config.json` (default `~/.copilot`) | not documented |
  | Cursor | `~/.agents/skills`, `~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`, no precedence given | `mcpServers` in `~/.cursor/mcp.json` | not documented |

  Sources (checked 2026-10-22): code.claude.com/docs/en/skills;
  learn.chatgpt.com/docs/build-skills; geminicli.com/docs/cli/skills and
  /docs/tools/mcp-server; docs.github.com Copilot CLI "Adding skills", "Adding MCP
  servers" and "Configuration directory"; cursor.com/docs/context/skills and
  /docs/context/mcp. OpenCode and Antigravity CLI come later: OpenCode has two MCP
  config shapes, and Antigravity CLI reads its own skills directory
  (`~/.gemini/antigravity-cli/skills`, not `~/.agents/skills`; its IDE reads
  `~/.gemini/config/skills`) with MCP in `~/.gemini/config/mcp_config.json`
  (antigravity.google/docs/skills and /docs/mcp), so it needs a location of its own.
  `GEMINI_CLI_HOME` moves Gemini CLI's skills under it, so an install for Gemini CLI
  with it set away from your home is refused (`GEMINI_HOME_UNSUPPORTED`) before
  anything is written.
- Skills go to the fewest locations that cover the selection, one copy each:

  | Location | User scope | Project scope | Read by |
  |---|---|---|---|
  | Claude Code's | `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) | `<project>/.claude/skills` | Claude Code; Cursor (`~/.claude/skills` only) |
  | Shared | `~/.agents/skills` | `<project>/.agents/skills` | Codex, Gemini CLI, Copilot CLI, Cursor |

  Claude Code's directory is used when Claude Code is selected, the shared one when
  Codex, Gemini CLI or Copilot CLI is, or when Cursor isn't already covered. Shared copies keep
  only the Agent Skills standard keys (`name`, `description`, `license`,
  `compatibility`, `metadata`, `allowed-tools`); Claude Code's keep every key.
  Nothing is written to `$CODEX_HOME/skills`, `~/.gemini/skills`,
  `~/.copilot/skills` or `~/.cursor/skills`.
- **Copies Cursor reads twice.** With Claude Code and Codex, Gemini CLI or Copilot
  CLI selected, Cursor reads both copies, and its documentation doesn't say which
  wins. `install` then lists a `warnings` entry per skill (`READ_TWICE`, naming the
  harness, the skill and both paths, and whether the copies are identical).
  Generated skills such as `my-repos` are byte-identical in both; bundled skills
  with keys only Claude Code reads differ.
- A shared copy's record lists every agent it serves. `uninstall --agent codex`
  keeps a copy Gemini CLI still uses (reported `kept`, `STILL_USED`) and status
  then reports it for Gemini CLI only; the last agent's uninstall removes it.
- **Codex's old copies move.** An older core installed Codex skills in
  `$CODEX_HOME/skills`. A user-scope install for Codex installs each into
  `~/.agents/skills`, checks the copy matches its source, and only then removes the
  old copy from the directory its record names (not today's `$CODEX_HOME`),
  reporting it `moved`. The old copy and its record stay, reported `kept` with a
  code, when the old copy was edited (`SKILL_EDITED`, until `--force`) or its
  replacement wasn't installed: a skill of that name Context Kit didn't write
  (`SKILL_FOREIGN`), a shared copy edited since install (`SKILL_EDITED`), a
  directory that isn't writable (`NOT_WRITABLE`), or a symbolic link in the path to
  `~/.agents/skills` (`SYMLINKED_PATH`; Context Kit writes and deletes there only
  through real directories). The rest still move; rerun install once it's fixed.
- One MCP server named after the workspace is registered for each agent: through
  its CLI for Claude Code, Codex and Gemini CLI (`-s user`; Gemini CLI has no
  `mcp get`, so status reads `~/.gemini/settings.json`), and by editing the config
  file for Copilot CLI (`{"type": "local", "command", "args", "tools": ["*"]}`) and
  Cursor (`{"type": "stdio", "command", "args"}`). A config file is edited in place:
  one entry under `mcpServers` is added, every other byte is kept, and uninstall
  removes only that entry (and `mcpServers`, the file or its directory if the
  install created them, and an empty object's own whitespace), so the file is as it
  was. It must be plain JSON with no key listed twice: anything else is refused
  untouched (`refused`, `CONFIG_MALFORMED`, with the path and the `entry` to add
  by hand), and the skills still install. A server of that name that Context Kit
  didn't add is a conflict (`MCP_FOREIGN`) until `--force`; an entry you edited is
  kept and reported `edited` by install and uninstall until `--force`.
  - Every write is checked against the file it was computed from: a temporary file
    beside the target, keeping its mode (a new file is `0600`), swapped in only
    while a hard-link snapshot shows the very file that was read, unchanged, and
    the path still holds it just before the rename. A change made before that, by
    the harness or by hand, means nothing is written and the edit is computed
    again from the new content, up to four times; then it stops with
    `MCP_CONFLICT` and the file as the other writer left it. A change made in
    place during the swap itself is detected afterwards and that writer's bytes
    are put back, also reported `MCP_CONFLICT`; rerun install to apply the entry.
    A version that can't be put back is kept beside the file under a new
    `<file>.context-kit-displaced-<time>-<pid>-<n>` name, never over an existing
    one. Uninstall removes the entry from what the file holds at that moment and
    deletes a file it created only while nothing else is in it.
  - **Residual:** there is no conditional rename on POSIX, so a writer that
    replaces the file by its own rename in the instant between the last check
    and Context Kit's rename loses its change, with no copy kept. Measured on one
    Mac with a writer replacing the file by rename continuously (random gaps of
    up to 1–200 ms) during 1,840 installs and uninstalls: 3 of 16,581 writes
    were lost, all with gaps of 60–200 ms and 2 of them while the machine was
    under load; with shorter gaps installs stopped with `MCP_CONFLICT` instead.
    Installing while the harness isn't running avoids it.
  - The record holds the file's resolved target and identity. A symbolic link to
    the file or its directory is written through and kept; a link to nothing is
    refused (`CONFIG_LINK_BROKEN`). A link retargeted to another file since
    install makes it someone else's file: status says `replaced`, install reports
    `MCP_REPLACED` until `--force`, and uninstall skips it. A file rewritten in
    place since install (the harness saving it) still loses our entry, but the
    file and `mcpServers` the install created are then left.
  - A file Context Kit replaced or deleted is kept beside it as a previous version
    (`.<file>.context-kit-<pid>-<ms>-v<hash>`), since a harness that has it open
    may still write to it. A later install, uninstall or `repos sync` deletes it once
    it is an hour old and still holds exactly what it held (the hash in its name);
    one that holds anything else is moved to a displaced copy and listed in the
    result (`displaced`; for `repos sync`, a `leftover` item in `results`). A write
    that lands in the instant between that hash check and the delete, at least an
    hour after the swap, is lost, as is any write after the delete; the hour is the
    margin. What an interrupted write leaves follows the same rule; a
    file an interrupted uninstall moved aside is put back. A directory the install
    created goes once only such files were in it, even after uninstall
    (`.state/leftovers.json` remembers them).
- One install, uninstall or `repos sync` runs at a time per workspace: each takes
  `.state/.lock-agents` (created exclusively, with its pid; a dead holder's lock is
  taken over), and another waits up to five minutes, then fails with
  `AGENTS_BUSY`. Records are read back after each save (`RECORDS_CHANGED` if they
  differ), and uninstall checks it still holds the lock before each item it
  removes, so one that lost the lock stops with `AGENTS_BUSY` before deleting
  more (the next uninstall finishes). Temporaries a killed save left in `.state`
  (`agents.json.<pid>-<ms>`, `leftovers.json.<pid>-<ms>`) are removed by the next
  lock holder once their process is gone or they are over an hour old (so a reused
  pid doesn't keep one forever).
- A harness CLI that fails is reported with a fixed code (`MCP_ADD_FAILED`,
  `MCP_REMOVE_FAILED`, `MCP_CLI_TIMEOUT`, `MCP_CLI_NOT_RUNNABLE`) and never its
  output. A remove that failed while the server is still registered is reported
  `kept` with state `failed`, and its record stays so the next uninstall retries.
- `install` is a sync: rerun it after changing addons or upgrading the core.
- It never overwrites or removes a skill it did not create or that you edited;
  `--force` overrides. A copy is built beside its destination and swapped in by
  rename, so a failure leaves the previous copy in place; leftovers older than an
  hour from an interrupted install are swept on the next one. A skill, hook or
  settings file that can't be written is reported `failed` with a code
  (`NOT_WRITABLE`, `WRITE_FAILED`, `NOT_READABLE`, `READ_FAILED`) rather than
  stopping the install, and what was already done stays recorded. A hook that
  can't be read is never replaced. The records (`.state/agents.json`) are written
  by temporary file and rename, and `install`, `uninstall` and `repos sync` first
  check they can be written: if not, they fail with `RECORDS_UNWRITABLE` before
  changing anything. An invalid `--name` fails before anything is written. Before
  swapping a copy in, install records it as `pending`: its new mode, source, content
  hash and the built copy's identity. An install interrupted after the swap is
  completed by the next one (`unchanged`, `recovered: true`) only when that very
  file is in place. A copy with no record, or one an equal hash alone would match,
  is never claimed: it stays `SKILL_FOREIGN`.
- Each record remembers which copy it installed: inode and birth time where the
  platform reports one (macOS; Linux through statx on file systems such as ext4),
  otherwise device and inode. A path that now holds another file is `replaced`,
  and its record is kept, so status and every install name it with the remedy:
  - The installed content (a Time Machine or Migration Assistant restore, `cp -R`,
    a sync service, a dotfile manager's symlink to it) is taken back by the
    workspace that owns the launcher: `unchanged`, `readopted: true`. Since one
    workspace per user owns it, another workspace's copies are never claimed.
    Without the launcher, it is reported `SKILL_REPLACED` until `install --adopt`
    takes back such copies (never edited ones, and never the launcher itself).
  - Different content stays foreign (`SKILL_REPLACED`): remove it and reinstall,
    or `--force` to replace it. Uninstall and cleanup leave it, even with `--force`.
  - A replaced legacy Codex copy is left in place and its record dropped.
  Without a birth time, a reused inode can't be told apart. Records from older
  cores are judged by content until the next install adds an identity.
- `--link` symlinks skills so edits apply immediately (not possible in the shared
  location when a skill needs adapted frontmatter).
- Project scope keeps Claude Code's server private to the project; Codex needs
  `--global-mcp`. Gemini CLI, Copilot CLI and Cursor get skills under the
  project's `.agents/skills`, and their MCP registration is reported `skipped`,
  since their project config files are usually committed.
- When repositories are registered, the generated `my-repos` skill is installed
  too, always as a copy (see `repositories`).
- When the workspace is a git checkout, `post-merge` and `post-rewrite` hooks are
  added to its hooks directory. They run `repos sync` after every pull and never
  fail it. Their output is discarded, so a previous version that sync displaces
  from a hook isn't shown: the copy stays on disk beside its config file as
  `<file>.context-kit-displaced-*`, and a later run doesn't report it again.
  An existing hook that Context Kit didn't write is kept and reported as a
  conflict; add `npm run -s hub -- repos sync` to it yourself, or `--force`.
  Uninstall removes the hooks once no agent items remain.
- Claude Code gets the merge tripwire: a `PreToolUse` hook on Bash running the
  core's `bin/merge-guard.mjs`, which denies raw `gh pr merge` and `gh api` PUTs to
  a pull request's merge endpoint and points to `pr land` (see `commands`). User
  scope writes `$CLAUDE_CONFIG_DIR/settings.json` (default
  `~/.claude/settings.json`); project scope writes `<project>/.claude/settings.local.json`.
  Other keys and hooks are kept; malformed settings are refused untouched
  (`SETTINGS_MALFORMED`); an entry you edited is kept and reported `edited` unless
  `--force`. The other harnesses are reported `unsupported`. The entry belongs
  to the core it runs, so workspaces run from the same core share one entry, and
  uninstalling either of them removes it (the other then reports it `missing`).
- `--global-rule` (off by default) writes a Claude Code user rule,
  `$CLAUDE_CONFIG_DIR/rules/context-kit.md` (default `~/.claude/rules/`), which
  Claude Code loads in every project. It is under 600 characters: your
  repositories resolve from any directory through the server's `list_repos` tool
  or the launcher's `repos`, and the checkout's `AGENTS.md` or `CLAUDE.md` comes
  first. It never lists repositories; the `my-repos` description does the routing.
  The opt-in is recorded, so later installs keep and refresh it until
  `--no-global-rule` or `uninstall` removes it. It is user scope only (a project
  install reports it `skipped`); Codex, Gemini CLI and Cursor report it
  `unsupported`. A `context-kit.md` Context Kit didn't write is never replaced or
  removed, even with `--force` (`RULE_FOREIGN`, or `RULE_REPLACED` when another
  file took its place). An edited one is kept and reported `edited`
  (`RULE_EDITED`) by install, `--no-global-rule` and uninstall until `--force`. It
  is written by temporary file and link or rename, and only through real
  directories (`SYMLINKED_PATH`). Status shows it with `enabled`.
- A managed `context-kit` launcher goes to `$XDG_BIN_HOME` or `~/.local/bin`, and
  one workspace per user owns it and `my-repos` (`WORKSPACE_CONFLICT` otherwise;
  see `repositories`).
- `status` reports each item `installed`, `changed`, `stale` (source changed;
  reinstall), `missing`, `replaced` (another copy in its place) or `pending` (an
  interrupted install), `broken` if the Node path moved, and `moved` if it was
  installed from another workspace path; the tripwire is `installed`, `edited` or
  `missing`; the rule is `installed`, `edited`, `missing`, `replaced` or `pending`;
  a config-file registration is `installed`, `edited`, `missing`, `replaced`,
  `pending` or `malformed`.
  The launcher also reports `onPath`.
- Discovery checks: `CONTEXT_KIT_HARNESS_SMOKE=1 node --test test/e2e/discovery.test.mjs`
  proves that real Claude Code and Codex sessions started outside any checkout list
  `my-repos`; Gemini CLI, Copilot CLI and Cursor are checked by hand
  (`test/manual-checks.md`).

Restart the agent after installing or changing addons.
