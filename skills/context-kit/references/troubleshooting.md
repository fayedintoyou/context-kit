# Troubleshooting

| Code | Meaning and fix |
|---|---|
| `INVALID_INPUT` | Bad arguments; check `context-kit help commands` |
| `INVALID_OKF` | A hub file is not OKF; add frontmatter with a `type` (see `knowledge`) |
| `INVALID_MANIFEST` | `hub.json` has a missing, unknown or invalid field |
| `INVALID_CONFIG` | `context-kit.json` (including its `mounts`), an `addon.json`, install records, `openspec/taxonomy.yaml`, a store's `openspec/parties.yaml` or a change's `slices.yaml` are invalid, or a plan's base branch is missing |
| `INVALID_INBOX` | An unexpected file sits in a hub's `inbox/` |
| `INVALID_PATH`, `PATH_ESCAPE` | A path uses `..`, a dot directory, or a symlink leaving its root |
| `NOT_FOUND`, `UNKNOWN_HUB`, `UNKNOWN_CONCEPT`, `UNKNOWN_PATH`, `UNKNOWN_SKILL`, `UNKNOWN_SPEC`, `UNKNOWN_STORE`, `UNKNOWN_MAP`, `UNKNOWN_OPERATION`, `UNKNOWN_TOPIC` | Nothing by that name; list first |
| `NOT_A_CONCEPT` | A reserved or nonconformant file was read as a concept |
| `NO_HUBS` | The root has no `hubs/` or `examples/`; check `--root` |
| `NOT_A_GIT_REPOSITORY` | Change progress is derived from git; run `specs status` in a git checkout |
| `ADDON_DISABLED` | Enable the addon in `context-kit.json`, then restart the agent |
| `WRITE_DISABLED` | Capture needs an explicit workspace, and over MCP `--allow-write` |
| `TOKEN_REQUIRED` | `mcp --http` needs `CONTEXT_KIT_MCP_TOKEN` in the environment, at least 32 characters; it is never taken from arguments |
| `UNAUTHORIZED`, `FORBIDDEN_HOST`, `FORBIDDEN_ORIGIN` | HTTP 401/403 from `mcp --http`: send `Authorization: Bearer <token>`, and use a `Host` the server listens on or was given with `--public-host`, and no `Origin` unless given with `--allow-origin` |
| `SESSION_NOT_FOUND`, `SESSION_LIMIT` | HTTP 404 for an ended or expired session (initialize again); 503 when `--max-sessions` are live |
| `WORKSPACE_EXISTS` | `init`/`setup` only create new directories |
| `TOO_LARGE` | A file or result exceeds its limit; split it |
| `WRONG_SPEC_ROOT`, `ADAPTER_FAILED`, `ADAPTER_FORMAT` | OpenSpec resolved another root or failed; check the repository and stores |
| `SNAPSHOT_CHANGED` | Files changed during an audit, or a map file while `maps render --write` or `maps pin` ran; rerun on a stable tree |
| `PIN_UNSAFE` | `maps pin` would have changed more than the map's pins, or left it unparseable; nothing was written. Remove the `pins` key and pin again |
| `DUPLICATE_REQUIREMENT` | A spec repeats a requirement name |
| `INVALID_REPOSITORY` | A Repository concept lacks a git `resource`, has bad `aliases`, or shares an alias (see `repositories`) |
| `INVALID_CONTEXT` | A Repository concept's `context` breaks its closed schema or bounds, or (in `validate`) names a concept or skill that doesn't resolve; each problem names the concept and key path (see docs/format.md) |
| `UNKNOWN_ROLE`, `UNKNOWN_PACK` | `--role` or a pack name the repository's `context` doesn't declare; the message and `details` list the declared roles, or `default` and the declared packs |
| `CHECKOUT_MISSING` | `repos pack` needs this machine's recorded checkout; run the `repos locate` or `repos clone` command it gives |
| `UNKNOWN_REPOSITORY`, `AMBIGUOUS_REPOSITORY` | No repository, or more than one, has that name; use `repos` and the id |
| `NOT_A_CHECKOUT`, `REMOTE_MISMATCH` | `repos locate` needs the top of a git checkout whose remote is the upstream |
| `REPOSITORY_EXISTS`, `CONCEPT_EXISTS` | `repos add` found the upstream, an alias or the concept already in use |
| `DESTINATION_EXISTS`, `CLONE_FAILED` | `repos clone` needs a new path and a reachable upstream |
| `MOUNT_EXISTS` | A mount or workspace hub already has that name; pick another mount name |
| `MOUNT_BUSY` | Another command is changing that mount or `context-kit.json`, or took over its lock (nothing was changed), or a read met a mount mid-switch; run it again, or remove its `.state/mounts/.lock-*` file if no such command is running |
| `UNKNOWN_MOUNT` | No mount has that name; run `mounts` |
| `MOUNT_NOT_FETCHED` | The mount is declared but not fetched on this machine at its pin; run `mounts fetch <name>` |
| `MOUNT_BROKEN` | The mount's fetched commit is not a loadable hub (the message names the file); pin a commit that is, or `mounts remove` it. From `mounts upgrade`, the candidate commit is not a hub and the pin did not move |
| `READ_ONLY_MOUNT` | Mounts are read-only; change the hub in its own repository, then move the pin |
| `NOT_A_HUB` | The mounted `--path` has no `hub.json`, or its curated documents are not OKF concepts |
| `FETCH_FAILED` | A mount's source, ref or pinned commit could not be fetched; for "authentication failed", set up a git credential helper or SSH key (see `mounts`) |
| `WORKSPACE_CONFLICT` | `agents install`: the launcher or `my-repos` belongs to another workspace on this machine; install from that one, or `--force` to take them over |
| `WORKSPACE_MOVED` | The `context-kit` launcher's workspace is gone; run `npm run agents -- install` in its new location |
| `LAUNCHER_BROKEN` | The Node or core the launcher runs is gone; run `npm install` and `agents install` in the workspace |

## Common problems

- **Agent does not see new tools or skills**: restart it after `agents install` or
  changing addons.
- **MCP server fails after a Node upgrade**: `agents status` shows `broken`; rerun
  `agents install`.
- **Install reports a conflict**: a skill or MCP server with that name already
  exists and is not Context Kit's. Remove it, rename with `--name`, or `--force`.
- **my-repos misses a repository after a pull**: the workspace wasn't a git
  checkout when you installed, or a hook you wrote was kept. Check `agents status`,
  run `agents install` again, and `repos sync`.
- **Claude Code rejects a server name**: some names are reserved; pass `--name`.
- **Moved or renamed the workspace**: `agents status` shows `moved` items; run
  `agents install` once from the new location.
- **`context-kit: command not found`**: the launcher's directory isn't on `PATH`;
  `agents status` gives the line to add. The skill uses its absolute path meanwhile.
- **`ls -t` fails**: your `ls` may be aliased; use `/bin/ls`.
