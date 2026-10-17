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
                          [--name <server>] [--link] [--allow-write] [--force] [--global-mcp]
npm run agents -- status
npm run agents -- uninstall [--agent claude,codex]
```

- Skills go to Claude Code (`~/.claude/skills`, or `<project>/.claude/skills`) and
  Codex (`$CODEX_HOME/skills`, or `<project>/.agents/skills`).
- One MCP server named after the workspace is registered through each agent's CLI.
- `install` is a sync: rerun it after changing addons or upgrading the core.
- It never overwrites or removes a skill it did not create or that you edited;
  `--force` overrides.
- `--link` symlinks skills so edits apply immediately (not possible for Codex when
  a skill needs adapted frontmatter).
- Project scope keeps Claude Code's server private to the project; Codex needs
  `--global-mcp`.
- `status` reports each item `installed`, `changed`, `stale` (source changed;
  reinstall) or `missing`, and `broken` if the Node path moved.

Restart the agent after installing or changing addons.
