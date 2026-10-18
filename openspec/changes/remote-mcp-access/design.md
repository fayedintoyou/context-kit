# Design

## Context

`lib/operations.mjs` is already the application core: `operations()` decides what a
caller is offered (writes, addon groups) and `execute()` validates and runs one
operation with coded errors. The CLI (`bin/hub.mjs`) and the stdio MCP server
(`bin/mcp.mjs`) are driving adapters around it. `bin/mcp.mjs` builds the tool and
prompt handlers inline and connects them to stdio. The core reads the workspace
from disk and runs the pinned OpenSpec CLI as a subprocess, so it cannot run inside
a Cloudflare Worker unchanged.

The owner already uses Cloudflare (DNS for `fayelore.com`, Pages for two sites)
with an API token that can read Workers, KV and tunnels; whether it can write them
is checked when deploying, not assumed here.

## Goals / Non-Goals

**Goals:**
- One MCP server construction shared by stdio and HTTP, so `remote-access` and
  `agent-interface` cannot drift.
- An origin that is safe to expose through a tunnel: closed unless a token is set.
- An edge that any MCP host speaking OAuth 2.1 with discovery and dynamic client
  registration can use, admitting only the owner.

**Non-Goals:**
- Running the core on the edge (needs a workspace snapshot and a reader port; later).
- Remote capture as commits or PRs; capture over HTTP behaves as over stdio.
- Host-specific tool shapes (ChatGPT `search`/`fetch`).
- Managing the owner's tunnel, DNS or launch agent from the kit; the guide documents them.

## Decisions

### Ports and adapters

```
 ChatGPT / Claude ──OAuth──▶ edge (Worker)            [driving adapter: OAuth + forward]
                                │ bearer origin token, via Cloudflare Tunnel
                                ▼
 Claude Code / Codex ─stdio─▶ MCP server ◀─HTTP─ origin [driving adapters: transports]
 person ─────────────CLI───▶   │
                               ▼
                         operations core ──▶ workspace on disk, OpenSpec CLI [driven]
```

- `lib/mcp/server.mjs` exports a factory that builds a configured MCP `Server` for a
  selection and options (tools, skill prompts, actor from client info). `bin/mcp.mjs`
  picks the transport. Alternative, an HTTP server calling `execute()` directly with
  its own JSON shape: rejected, hosts need MCP and it would fork the tool list.
- Origin access is a single check in front of the HTTP transport: loopback with no
  token, or a configured bearer token. It is the port a later adapter (for example,
  validating a Cloudflare Access JWT) plugs into; only these two exist now.
- The edge is a separate deployable that talks to the origin only over HTTP. Hosts
  depend on the edge's OAuth contract, the edge depends on the origin's HTTP
  contract, and neither knows the other's internals.
- Driven ports for a snapshot-backed workspace and for publishing captures are named
  here so later changes slot in, but are not introduced: no second implementation
  exists yet to justify the abstraction.

### Stateless HTTP with JSON responses

Each request gets a fresh server and transport (the SDK's stateless mode,
`sessionIdGenerator: undefined`, `enableJsonResponse: true`). The tools need no
session state, requests may arrive through different Worker isolates, and plain
JSON responses forward through the edge without SSE handling. Alternative,
sessions: rejected, it needs affinity the edge cannot give and buys nothing here.

### Options and token handling

`--http <port>` (0 picks a free port), `--host <address>` (default `127.0.0.1`).
On listening, the server writes one JSON line to stderr with the URL, so tests and
scripts can use port 0. The token comes only from `CONTEXT_KIT_MCP_TOKEN` (arguments
appear in process listings), and is compared in constant time. With a token set,
loopback requests also need it, so a tunnel pointing at loopback is protected.

### Edge: a Worker with Cloudflare's OAuth provider

`edge/cloudflare/` is one Worker using `@cloudflare/workers-oauth-provider` (1.2.x)
in its single-Worker `OAuthProvider` shape (`apiRoute: '/mcp'`), which implements
authorization server metadata, protected resource metadata, dynamic client
registration, Client ID Metadata Documents (with the `global_fetch_strictly_public`
compatibility flag) and PKCE, storing only hashed grants in KV. Both registration
styles are on because ChatGPT and Claude each support either. Its default handler runs the
GitHub sign-in (an OAuth app owned by the user) and completes authorization only
for logins in `ALLOWED_GITHUB_LOGINS`. Its API handler forwards `/mcp` to
`ORIGIN_URL` with `Authorization: Bearer ORIGIN_TOKEN`, dropping the host's token.

Alternatives: Cloudflare Access managed OAuth in front of the tunnel (less code,
but its support for dynamic client registration with ChatGPT and Claude is not
documented, it needs a Zero Trust organization, and it cannot be run locally in
tests); a hosted identity provider (another account and vendor for a
single-owner server). GitHub sign-in matches where the workspace already lives.

GitHub's endpoints are Worker variables defaulting to github.com, so tests point
them at a fake GitHub. Wrangler and the OAuth library are root `devDependencies`:
instances install the kit as a dependency and so never install them, while
`npm ci` in this repository and CI does.

### Testing

End to end, per `docs/testing.md`:
- Origin: spawn `bin/mcp.mjs --http 0` and drive it with the SDK's Streamable HTTP
  client, comparing results with the stdio client in `test/e2e/mcp.test.mjs`.
- Edge: a test starts the origin with a token, a fake GitHub (a local HTTP server
  issuing codes for a chosen login), and `wrangler dev` with local KV and variables
  pointing at both; it registers a client, runs authorization with PKCE through the
  redirects, exchanges the code and calls a tool through the edge.
- Connecting real ChatGPT and Claude accounts is listed in `test/manual-checks.md`.

## Risks / Trade-offs

- [The tunnel hostname is public] → the origin rejects every request without its
  token; the token is long and random, set as a Worker secret and in the origin's
  environment only.
- [The owner's machine sleeps] → the edge answers with a coded 502 JSON error naming
  the origin as unreachable, so hosts show a clear failure.
- [Host OAuth quirks (CIMD-only clients, protocol revisions)] → manual checks with
  both hosts before calling the slice done; the library is pinned and upgraded deliberately.
- [`wrangler dev` makes the edge tests slow and heavy] → one test file, run once per
  `npm test`; the core's own tests do not depend on it.
- [Hub content reaches a hosted model] → only the owner's sign-in admits a host; this
  is the same content the owner's local agents already read.

## Migration Plan

Additive. Deploying is the owner's step from `docs/remote.md`: run the origin, create
a named tunnel to it, create the GitHub OAuth app, KV namespace and secrets, deploy
the Worker, then add `https://<edge>/mcp` to ChatGPT and Claude. Rollback: delete
the connector, the Worker and the tunnel; local stdio installs are untouched.
