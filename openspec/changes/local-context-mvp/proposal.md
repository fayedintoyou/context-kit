# Proposal
## Why
Agents need a small, consistent way to discover maintained context, capture findings, and inspect a repository's canonical specifications. Personal content must be separable from the public toolkit.
## What Changes
- Add explicit workspace selection, initialization, bounded retrieval/search, skill reading, and append-only capture.
- Expose shared operations through a local stdio MCP adapter, read-only unless writes are enabled.
- Add an internal spec-source port with an OpenSpec adapter and repeatable canonical-spec audit, reading either the selected repository or a hub-declared shared OpenSpec store.
- Use OpenSpec to define and maintain this project's behavior.
## Capabilities
### New Capabilities
- `context-workspaces`: discover context and capture unreviewed notes in an explicit workspace.
- `agent-interface`: expose shared operations to CLI and MCP callers.
- `canonical-spec-audit`: inspect canonical specs through an adapter and prepare evidence-based audits.
### Modified Capabilities
None.
## Impact
CLI, shared modules, tests, documentation and CI. Add pinned MCP SDK, Zod and OpenSpec dependencies. No remote hosting, credentials, external service writes or arbitrary command execution.
