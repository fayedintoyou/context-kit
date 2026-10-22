---
name: context-kit
description: Explain and operate Context Kit, the toolkit for OKF knowledge hubs, captured notes, addons and agent installs. Use when the user asks how to use Context Kit, what a command or tool does, how to set it up or install it into an agent, or needs help with an error from it.
---

# Context Kit

Context Kit keeps knowledge in Git-backed hubs written in the Open Knowledge
Format (OKF) and gives people and agents one set of operations over them: a CLI
(`context-kit`, or `npm run hub --` inside a workspace) and an MCP server with the
same tools. A workspace is the user's own instance of the core; addons add
optional functionality.

To help, read the topic that fits. The same topics are available as
`context-kit help <topic>`, the `help` MCP tool, and files beside this skill
(`read_skill` with `file: "references/<topic>.md"`).

| Topic | Read when |
|---|---|
| `getting-started` | Setting up, or explaining what Context Kit is |
| `knowledge` | Hubs, OKF concepts, frontmatter, trust and freshness, validation |
| `navigating` | Finding things: context, browse, read, search, links |
| `capturing` | Saving findings as notes and reviewing them |
| `repositories` | Registering repositories, local checkouts, the `my-repos` skill |
| `mounts` | Using a hub from another git repository, pinned to a commit |
| `addons-and-install` | Choosing addons, installing into Claude Code or Codex |
| `remote` | Reaching a workspace from ChatGPT, Claude or a phone: origin, tunnel, edge, credentials, connecting hosts |
| `specs` | OpenSpec specs, shared stores and audits (specs addon) |
| `maps` | Behavior maps: drafting, checking and rendering journeys from specs (maps addon) |
| `skills` | Bundled and workspace skills, reflect and review |
| `commands` | Every CLI command and MCP tool |
| `troubleshooting` | Error codes and common problems |

When operating Context Kit for the user, prefer its MCP tools when connected;
otherwise use the CLI from their workspace. Start exploring a hub with
`browse_hub` at the root, then `read_concept` only what you need. Captures are
unreviewed notes; never present them as curated knowledge. When writing a
concept, follow "Writing concepts as an agent" in `knowledge`.
