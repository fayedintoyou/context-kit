# Navigating

Spend context only on what you need: list, then open, then follow links.

| Step | CLI | MCP tool |
|---|---|---|
| Which hubs exist | `list` | `list_hubs` |
| A hub's curated starting documents | `context <hub>` | `get_context` |
| What a directory holds | `browse <hub> [dir] [--offset n]` | `browse_hub` |
| One concept with its links | `read <hub> <concept-id> [--frontmatter]` | `read_concept` |
| Text anywhere | `search <text>` | `search_context` |

`browse` returns concepts (type, title, description, trust, staleness, whether
curated) and subdirectories, 200 at a time with totals. `read` classifies each
link as `concept` (follow it with another read), `directory` (browse it), `file`,
`external`, `outside` (leaves the hub) or `missing` (not written yet).

Links reach mounted hubs (see `help mounts`) in two ways, answered only from
what is already fetched; following one never contacts a source:

- `[orders](shared:/tables/orders)`, with or without `.md`, names a concept in
  the mount `shared`. It is a `concept` link with `hub`, `id` and `ref`, or
  `missing` with `mount` when that mount has no such concept. When the mount is
  not fetched or is broken, it is `missing` with `reason: "unfetched"` or
  `"broken"`; a mount that is named like a workspace hub is not read, so its
  links are `missing` with `reason: "name-conflict"`. A scheme that names no
  declared mount stays `external`.
- A mounted concept's link that leaves its hub, such as `../platform/deploy.md`,
  is resolved in the mount's source repository. When another mount of the same
  source covers that path (the deepest one wins), it is classified there, with
  `hub` set to that mount; otherwise it stays `outside`.

Every concept in a result carries `ref`, a qualified reference
`<hub-id>:/<concept-id>` such as `personal/main:/preferences` or
`shared:/tables/orders`. Pass one to `read` alone (`read shared:/tables/orders`)
or as `concept` to `read_concept` with `id` omitted; a hub that disagrees with
the reference is `INVALID_INPUT`. Mounted hubs (see `help mounts`) read exactly
like the workspace's own, under their mount name.

Captured inbox notes are hidden unless you pass `--inbox` (`includeInbox: true`
over MCP), and are marked `inbox: true` when shown.
