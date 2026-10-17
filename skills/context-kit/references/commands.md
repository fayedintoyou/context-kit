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
| `skills` | `list_skills` | Declared skills |
| `read-skill <hub> <reference>` | `read_skill` | A skill or its files (`--file`) |
| `specs stores` | `list_spec_stores` | Readable shared stores (specs addon) |
| `specs list` | `list_specs` | Canonical specs (`--store`) |
| `specs read <id>` | `read_spec` | One spec (`--store`) |
| `specs audit` | `audit_specs` | Structural audit (`--store`) |

MCP server: `context-kit-mcp --root <workspace> [--allow-write] [--no-skill-prompts]`
(`npm run mcp` in a workspace). Its root is fixed at startup; tools cannot change it.
