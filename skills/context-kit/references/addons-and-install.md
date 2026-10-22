# Addons and installing

## Addons

| Addon | Gives you |
|---|---|
| `core` (always) | Hubs, browse, read, search, capture, skills, help, and this skill |
| `specs` | OpenSpec specs and audits, and the `audit-canonical-specs` skill |
| `reflect` | The `reflect` skill |
| `review` | The `independent-review` skill |

The workspace's `context-kit.json` lists enabled addons:
`{"version": 1, "addons": ["reflect", "specs"]}`. `addons` shows what is
available and enabled. Disabled addons' tools disappear and their CLI commands
return `ADDON_DISABLED`. Choose at creation with `--addons a,b` or `--addons none`.

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

- `--agent` takes `claude`, `codex`, `gemini` (Gemini CLI) and `cursor`; the
  default is `claude,codex`. Gemini CLI and Cursor get skills only for now: their
  MCP registration and the merge tripwire are reported `unsupported`.
- Skills go to the fewest locations that cover the selection, one copy each:

  | Location | User scope | Project scope | Read by |
  |---|---|---|---|
  | Claude Code's | `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) | `<project>/.claude/skills` | Claude Code; Cursor (`~/.claude/skills` only) |
  | Shared | `~/.agents/skills` | `<project>/.agents/skills` | Codex, Gemini CLI, Cursor |

  Claude Code's directory is used when Claude Code is selected, the shared one when
  Codex or Gemini CLI is, or when Cursor isn't already covered. Shared copies keep
  only the Agent Skills standard keys (`name`, `description`, `license`,
  `compatibility`, `metadata`, `allowed-tools`); Claude Code's keep every key.
  Nothing is written to `$CODEX_HOME/skills` or `~/.gemini/skills`.
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
- One MCP server named after the workspace is registered through each agent's CLI.
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
  `--global-mcp`.
- When repositories are registered, the generated `my-repos` skill is installed
  too, always as a copy (see `repositories`).
- When the workspace is a git checkout, `post-merge` and `post-rewrite` hooks are
  added to its hooks directory. They run `repos sync` after every pull and never
  fail it. An existing hook that Context Kit didn't write is kept and reported as a
  conflict; add `npm run -s hub -- repos sync` to it yourself, or `--force`.
  Uninstall removes the hooks once no agent items remain.
- Claude Code gets the merge tripwire: a `PreToolUse` hook on Bash running the
  core's `bin/merge-guard.mjs`, which denies raw `gh pr merge` and `gh api` PUTs to
  a pull request's merge endpoint and points to `pr land` (see `commands`). User
  scope writes `$CLAUDE_CONFIG_DIR/settings.json` (default
  `~/.claude/settings.json`); project scope writes `<project>/.claude/settings.local.json`.
  Other keys and hooks are kept; malformed settings are refused untouched
  (`SETTINGS_MALFORMED`); an entry you edited is kept and reported `edited` unless
  `--force`. Codex has no such hook and is reported `unsupported`. The entry belongs
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
  `missing`; the rule is `installed`, `edited`, `missing`, `replaced` or `pending`.
  The launcher also reports `onPath`.

Restart the agent after installing or changing addons.
