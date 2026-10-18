# Proposal

## Why

Context Kit reaches agents only as a local stdio MCP server, so hosts that connect
to remote MCP servers cannot use a workspace: ChatGPT plugins, Claude custom
connectors (which also appear in Claude Code on the web, Desktop and phone). Both
expect a public HTTPS Streamable HTTP endpoint protected by OAuth 2.1 with
discovery and dynamic client registration. `docs/next.md` already lists remote MCP
with deliberate authentication as the next step for phone access.

## What Changes

- The MCP server can also serve Streamable HTTP (`mcp --http <port>`), offering
  exactly the tools and prompts the stdio server offers, with the same results, coded
  errors and capture attribution.
- HTTP access is closed: the server binds to loopback by default, never runs without
  a long bearer token from the environment, and rejects requests whose `Host` or
  `Origin` it does not expect before any operation runs.
- An optional edge for Cloudflare Workers ships with the kit: an OAuth 2.1
  authorization server (discovery metadata, dynamic client registration limited to
  allowlisted redirect hosts, PKCE, refresh) that shows the owner a consent page per
  client, signs them in with GitHub, admits only allowlisted GitHub user IDs, and
  forwards MCP requests to the workspace's HTTP server through a Cloudflare Tunnel,
  adding the origin token. Hosts never see that token, and an unreachable origin is a
  clear coded error.
- A remote-access guide covers running the server, the tunnel, the edge, and adding
  the endpoint to ChatGPT and Claude.

Out of scope, for later changes: ChatGPT "company knowledge" `search`/`fetch`
tool shapes; Client ID Metadata Documents; serving a workspace without the owner's
machine (a snapshot on the edge); remote capture as commits or pull requests.

## Capabilities

### New Capabilities

- `remote-access`: serving a workspace's MCP tools over HTTP to remote hosts,
  with token-protected origins and an OAuth edge that admits only the owner.

### Modified Capabilities

None. The stdio server's requirements in `agent-interface` stay as they are;
`remote-access` requires HTTP to match them.

## Impact

- `bin/mcp.mjs`: server construction moves into a shared module used by both
  transports; a new `--http` option.
- New `edge/cloudflare/` Worker. Cloudflare's OAuth provider library and Wrangler
  become root `devDependencies`, so instances, which install the kit as a
  dependency, never install them.
- Docs: README, `docs/remote.md`, help topic for remote access.
- No new runtime dependency for the core; the MCP SDK already ships the HTTP
  transport.
