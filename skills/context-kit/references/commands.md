# Commands and tools

CLI: `context-kit [--root <dir>] <command>`; inside a workspace, `npm run hub --
<command>` (the workspace is the root). Every result is JSON on stdout; errors are
`{"error": {"code", "message"}}` on stderr with a nonzero exit.

| CLI command | MCP tool | Does |
|---|---|---|
| `help [topic]` | `help` | Lists help topics, or shows one |
| `init <dir>` | | Creates a workspace (`--kit`, `--addons`) |
| `setup <dir>` | | Creates, installs and installs into agents |
| `agents install` / `agents status` / `agents uninstall` | | Manages agent installs |
| `addons` | `list_addons` | Available and enabled addons |
| `list` | `list_hubs` | Hubs |
| `validate` | `validate_hubs` | Checks every hub strictly |
| `context <hub>` | `get_context` | A hub's curated documents (`--inbox`) |
| `browse <hub> [dir]` | `browse_hub` | One directory (`--offset`, `--inbox`) |
| `read <hub> <concept-id>` | `read_concept` | One concept (`--frontmatter`, `--inbox`) |
| `search <text>` | `search_context` | Text across concepts (`--inbox`) |
| `capture <hub> <title>` | `capture_note` | New unreviewed note from stdin (`--by`) |
| `repos add <hub> [<upstream>]` | `add_repo` | Registers a repository in a hub (`--path`, `--alias`, `--title`, `--concept`, `--description`); MCP needs `--allow-write` and takes no path |
| `repos` | `list_repos` | Registered repositories and local checkouts |
| `repos locate <repo> <path>` | | Records an existing checkout (CLI only) |
| `repos clone <repo> [<path>]` | | Clones and records a repository (CLI only) |
| `repos scan <directory>` | | Records matching checkouts one level deep (CLI only) |
| `repos sync` | | Rebuilds the `my-repos` skill from Repository concepts (CLI only) |
| `skills` | `list_skills` | Declared skills |
| `read-skill <hub> <reference>` | `read_skill` | A skill or its files (`--file`) |
| `specs stores` | `list_spec_stores` | Readable shared stores (specs addon) |
| `specs list` | `list_specs` | Canonical specs (`--store`) |
| `specs read <id>` | `read_spec` | One spec (`--store`) |
| `specs audit` | `audit_specs` | Structural audit (`--store`) |
| `specs garden` | `garden_specs` | Spec gardening signals (`--store`) |
| `specs parties --store <id>` | `list_parties` | A store's parties and contracts |
| `specs status <change>` | `change_status` | Derived slice and requirement progress of a change (`--store`) |
| `specs next <change>` | `next_slices` | Work packets for slices ready to start (`--store`) |
| `specs slice <change> <slice>` | `read_slice` | One slice's packet and review inputs (`--store`) |
| `specs reconcile <change>` | `reconcile_change` | Facts for checking a change against what was built (`--store`) |
| `specs archivable` | `archivable_changes` | Which active changes are ready to archive, or their blockers (`--store`) |
| `specs archive --ready` | — | Archive ready changes and validate (CLI only, no commit; `--store`) |
| `specs archive --rehearse` | — | Archive every active change into a scratch copy and report what would fail validation (CLI only, changes nothing, non-zero on an issue; `--store`) |

MCP server (stdio): `context-kit-mcp --root <workspace> [--allow-write] [--no-skill-prompts]`
(`npm run mcp` in a workspace). Its root is fixed at startup; tools cannot change it.

Over HTTP: `CONTEXT_KIT_MCP_TOKEN=<32+ characters> context-kit-mcp --root <workspace>
--http <port> [--host <address>] [--public-host <host>]... [--allow-origin <origin>]...
[--max-sessions <n>] [--session-idle <seconds>]`. It serves `/mcp` with the same tools,
prompts and coded errors, requires `Authorization: Bearer <token>` (the token is only
ever read from the environment) and listens on `127.0.0.1` unless `--host` says
otherwise; `--http 0` picks a free port, reported as one JSON line on stderr. A request
whose `Host` is neither the server's own address nor a `--public-host`, or whose
`Origin` is not an `--allow-origin`, gets 403 before the token is checked. Sessions
(default 16, idle 1800 seconds) keep each client's name for captures; `GET /mcp` is 405.
