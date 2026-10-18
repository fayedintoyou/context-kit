# Design

## Context

`lib/operations.mjs` is already the application core: `operations()` decides what a
caller is offered (writes, addon groups) and `execute()` validates and runs one
operation with coded errors. The CLI (`bin/hub.mjs`) and the stdio MCP server
(`bin/mcp.mjs`) are driving adapters around it. `bin/mcp.mjs` builds the tool and
prompt handlers inline, takes the capture actor from the connected client's
declared name and version, and connects to stdio. The core reads the workspace from
disk and runs the pinned OpenSpec CLI as a subprocess, so it cannot run inside a
Cloudflare Worker unchanged.

The owner already uses Cloudflare (DNS for `fayelore.com`, Pages for two sites) with
an API token that can write Workers, KV, tunnels and DNS. Zero Trust is not enabled.

## Goals / Non-Goals

**Goals:**
- One MCP server construction shared by stdio and HTTP, so `remote-access` and
  `agent-interface` cannot drift.
- An origin that is safe to expose through a public tunnel: it never runs without a
  token, and rejects rebinding hosts and browser origins.
- An edge any MCP host speaking OAuth 2.1 with dynamic client registration can use,
  admitting only the owner, with per-client consent.

**Non-Goals:**
- Running the core on the edge (needs a workspace snapshot and a reader port; later).
- Remote capture as commits or PRs; capture over HTTP behaves as over stdio.
- Host-specific tool shapes (ChatGPT `search`/`fetch`).
- Client ID Metadata Documents: both target hosts also support dynamic
  registration, and CIMD needs the edge to fetch public HTTPS documents, which the
  local test harness cannot serve. Enable later with a test that can.
- Managing the owner's tunnel, DNS or launch agent from the kit; the guide documents them.

## Decisions

### Ports and adapters

```
 ChatGPT / Claude ──OAuth──▶ edge (Worker)            [driving adapter: OAuth + forward]
                                │ origin token, via Cloudflare Tunnel
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
- The HTTP adapter puts two checks in front of the transport, in order: host/origin
  (403), then the bearer token (401). This is the origin access port; a later adapter
  (for example, validating a Cloudflare Access JWT) would replace the token check.
- The edge is a separate deployable that talks to the origin only over HTTP. Hosts
  depend on the edge's OAuth contract, the edge on the origin's HTTP contract.
- Driven ports for a snapshot-backed workspace and for publishing captures are named
  here so later changes slot in, but are not introduced: no second implementation
  exists yet to justify the abstraction.

### Sessions on the origin, JSON responses

The origin uses the SDK's stateful Streamable HTTP mode: a server and transport per
initialized session (`sessionIdGenerator: randomUUID`), kept in a map and closed after
an idle timeout (30 minutes) or on `DELETE`. A fresh server per request would lose
the client's declared name and version after `initialize`, so captures would be
attributed to `unknown-client` (found in plan review). Every request reaches the same
origin, so the edge needs no affinity; it forwards `Mcp-Session-Id` both ways.
`enableJsonResponse: true` keeps POST responses plain JSON. The SDK still offers a
standalone SSE stream on `GET /mcp`, which its client opens after initializing, so
the origin answers `GET` with 405 (the SDK client treats that as "no stream") and the
edge passes 404 and 405 through unchanged (found in plan review round 2). At most
`--max-sessions` (default 16) live at once; more get a coded 503. `--session-idle`
(default 1800 seconds) lets tests shorten expiry.

### Origin options and checks

- Options are parsed by `lib/arguments.mjs`, which gains repeatable options.
- `--http <port>` (0 picks a free port), `--host <address>` (default `127.0.0.1`),
  `--public-host <host>` (repeatable; the tunnel hostname), `--allow-origin <origin>`
  (repeatable; none by default). On listening, one JSON line on stderr gives the URL.
- The token is required in HTTP mode, at least 32 characters, only from
  `CONTEXT_KIT_MCP_TOKEN` (arguments appear in process listings), compared in
  constant time. There is no anonymous mode: a launch agent that loses the variable
  fails to start rather than exposing the workspace through the tunnel.
- Host and origin are checked by the adapter before the token, using the SDK's
  DNS-rebinding options where they fit, so a rebinding page cannot probe the token.
  Allowed hosts are `127.0.0.1:<port>`, `localhost:<port>`, the explicitly given
  `--host` address with the port, and each `--public-host`. A request with more than
  one `Host` header is refused (403), since the first and the last could differ.
  `X-Forwarded-*` headers are ignored.

### Edge: a Worker with Cloudflare's OAuth provider

`edge/cloudflare/` is one Worker using `@cloudflare/workers-oauth-provider`, pinned to
1.2.3, in its single-Worker `OAuthProvider` shape (`apiRoute: '/mcp'`). The library
publishes metadata, handles dynamic registration, tokens, refresh and resource
binding, and stores only hashes and encrypted grants in KV. The Worker adds:

- **Registration policy:** `clientRegistrationCallback` refuses redirect URIs whose
  host is not in `ALLOWED_REDIRECT_HOSTS` (default: `chatgpt.com`, `claude.ai`,
  `claude.com`). A stranger cannot register a client that sends tokens elsewhere.
- **Authorize:** `parseAuthRequest()`, then refuse requests without an `S256` code
  challenge (the library requires PKCE only for public clients; tests cover both kinds), then refuse when
  `ALLOWED_GITHUB_IDS` is empty, then `describeConsent()` + `beginConsent()` and render
  the consent page (client name, redirect host, escaped; no framing).
- **Approve:** `approveConsent()` (browser-bound handle), then `beginUpstream()` and
  redirect to GitHub with its own PKCE and the library's single-use, browser-bound
  `state`.
- **Callback:** `finishUpstream()`, exchange GitHub's code, fetch `/user`, and call
  `completeAuthorization()` only when the numeric `id` is in `ALLOWED_GITHUB_IDS`
  (logins can be renamed and reclaimed; found in plan review). Otherwise render a
  refusal and redirect `access_denied`. The GitHub token is discarded: the edge only
  needs to know who signed in.
- **Forward:** `apiHandler` checks `ORIGIN_URL` (`https`, or `http` on loopback for
  tests) and `ORIGIN_TOKEN` (32+ characters) or answers a coded 500. It forwards the
  method, body, `Content-Type`, `Accept`, `Mcp-Session-Id` and
  `Mcp-Protocol-Version` to `ORIGIN_URL` + `/mcp` with `Authorization: Bearer
  ORIGIN_TOKEN`, `redirect: 'manual'` and a 30-second timeout. A redirect, a
  connection failure, a timeout, or a response that is neither JSON nor an MCP status
  (Cloudflare's tunnel error pages are HTML with 502/530) becomes a coded 502
  `ORIGIN_UNREACHABLE` JSON error. Origin 401s become 502 too, since they mean the
  edge is misconfigured, not that the host's token is bad.
- Access tokens last an hour; refresh tokens 30 days, sliding by a week on use.

GitHub's endpoints are Worker variables defaulting to github.com, so tests point
them at a fake GitHub. Wrangler and the OAuth library are root `devDependencies`:
instances install the kit as a dependency and so never install them.

**Alternative considered: Cloudflare Access managed OAuth or an MCP server portal.**
Current Cloudflare docs document dynamic client registration for managed OAuth and
bearer-token upstreams for portals, so either could replace the Worker's OAuth code;
the origin would then validate the `Cf-Access-Jwt-Assertion` JWT. The owner chose
the Worker (2026-10-18): it needs no Zero Trust organization, it can be run and
tested end to end locally, and identity is pinned to a GitHub user ID. Access stays
a candidate adapter for the origin access port.

### Delivery

Following the precedent of `cross-repo-contracts`, slices merge into an integration
branch `remote-mcp-access`, which merges to `main` once every scenario is linked; the
spec-link gate checks all of a change's scenarios, so a single slice cannot pass it
on `main` alone (found in plan review).

### Testing

End to end, per `docs/testing.md`:
- Origin (`test/e2e/remote.test.mjs`): spawn `bin/mcp.mjs --http 0` with a token and
  drive it with the SDK's Streamable HTTP client and raw `fetch` for the 401/403 cases,
  comparing results with the stdio client.
- Edge (`test/e2e/edge.test.mjs`): start the origin, a fake GitHub (a local HTTP
  server issuing codes for a chosen user ID and login), and `wrangler dev` with local
  KV and variables pointing at both. A small client with a cookie jar registers,
  authorizes with PKCE through consent and the redirects, exchanges and refreshes
  tokens, and calls tools through the edge. Fixture upstreams cover a redirecting
  origin (and assert the redirect target receives nothing), an HTML 530 page and a
  closed port.
- Connecting real ChatGPT, Claude and the connector inside Claude Code is listed in
  `test/manual-checks.md`.

## Risks / Trade-offs

- [The tunnel hostname is public] → the origin cannot run without a long token, and
  checks Host and Origin before the token.
- [The owner signs in while a malicious client is registered] → registration only
  accepts allowlisted redirect hosts, and the consent page names the client and its
  redirect host before any GitHub redirect.
- [The owner's machine sleeps] → coded 502 `ORIGIN_UNREACHABLE` within 30 seconds.
- [Host OAuth quirks (CIMD-only clients, protocol revisions)] → manual checks with
  each host before the change is done; the library is pinned and upgraded deliberately.
- [`wrangler dev` makes the edge tests slow and heavy] → one test file; the core's
  own tests do not depend on it.
- [KV cannot make single-use atomic] → the library's binding cookie limits a race to
  the owner's own browser.
- [Hub content reaches a hosted model] → only the owner's sign-in admits a host; this
  is the same content the owner's local agents already read.

## Migration Plan

Additive. Deploying is the owner's step from `docs/remote.md`: run the origin with a
token and `--public-host`, create a named tunnel to it, create the GitHub OAuth app,
KV namespace and secrets, deploy the Worker, then add `https://<edge>/mcp` to ChatGPT
and Claude. Rollback: delete the connector, the Worker and the tunnel; local stdio
installs are untouched.
