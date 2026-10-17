# Troubleshooting

| Code | Meaning and fix |
|---|---|
| `INVALID_INPUT` | Bad arguments; check `context-kit help commands` |
| `INVALID_OKF` | A hub file is not OKF; add frontmatter with a `type` (see `knowledge`) |
| `INVALID_MANIFEST` | `hub.json` has a missing, unknown or invalid field |
| `INVALID_CONFIG` | `context-kit.json`, an `addon.json` or install records are invalid |
| `INVALID_INBOX` | An unexpected file sits in a hub's `inbox/` |
| `INVALID_PATH`, `PATH_ESCAPE` | A path uses `..`, a dot directory, or a symlink leaving its root |
| `NOT_FOUND`, `UNKNOWN_HUB`, `UNKNOWN_CONCEPT`, `UNKNOWN_PATH`, `UNKNOWN_SKILL`, `UNKNOWN_SPEC`, `UNKNOWN_STORE`, `UNKNOWN_OPERATION`, `UNKNOWN_TOPIC` | Nothing by that name; list first |
| `NOT_A_CONCEPT` | A reserved or nonconformant file was read as a concept |
| `NO_HUBS` | The root has no `hubs/` or `examples/`; check `--root` |
| `ADDON_DISABLED` | Enable the addon in `context-kit.json`, then restart the agent |
| `WRITE_DISABLED` | Capture needs an explicit workspace, and over MCP `--allow-write` |
| `WORKSPACE_EXISTS` | `init`/`setup` only create new directories |
| `TOO_LARGE` | A file or result exceeds its limit; split it |
| `WRONG_SPEC_ROOT`, `ADAPTER_FAILED`, `ADAPTER_FORMAT` | OpenSpec resolved another root or failed; check the repository and stores |
| `SNAPSHOT_CHANGED` | Files changed during an audit; rerun on a stable tree |
| `DUPLICATE_REQUIREMENT` | A spec repeats a requirement name |
| `INVALID_REPOSITORY` | A Repository concept lacks a git `resource`, has bad `aliases`, or shares an alias (see `repositories`) |
| `UNKNOWN_REPOSITORY`, `AMBIGUOUS_REPOSITORY` | No repository, or more than one, has that name; use `repos` and the id |
| `NOT_A_CHECKOUT`, `REMOTE_MISMATCH` | `repos locate` needs the top of a git checkout whose remote is the upstream |
| `DESTINATION_EXISTS`, `CLONE_FAILED` | `repos clone` needs a new path and a reachable upstream |

## Common problems

- **Agent does not see new tools or skills**: restart it after `agents install` or
  changing addons.
- **MCP server fails after a Node upgrade**: `agents status` shows `broken`; rerun
  `agents install`.
- **Install reports a conflict**: a skill or MCP server with that name already
  exists and is not Context Kit's. Remove it, rename with `--name`, or `--force`.
- **Claude Code rejects a server name**: some names are reserved; pass `--name`.
- **`ls -t` fails**: your `ls` may be aliased; use `/bin/ls`.
