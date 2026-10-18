# Spec Delta

## Purpose

Serve a workspace's Context Kit tools to remote MCP hosts, such as ChatGPT plugins and Claude connectors, over HTTP, admitting only the workspace owner.

## ADDED Requirements

### Requirement: HTTP transport
The MCP server SHALL serve Streamable HTTP at `/mcp` when started with `--http <port>`, offering the same tools and prompts as the stdio server for the same options, with equivalent results and coded errors.

#### Scenario: Same tools over HTTP
- **WHEN** a client lists tools and reads a hub's context over HTTP and over stdio from servers started with the same workspace and options
- **THEN** both list the same tools and return equivalent results

#### Scenario: Same prompts over HTTP
- **WHEN** a client lists prompts and gets a skill prompt over HTTP and over stdio
- **THEN** both return the same prompts and the same prompt text

#### Scenario: Same coded errors over HTTP
- **WHEN** a client reads a missing hub over HTTP and over stdio
- **THEN** both return a tool error with the same error code

#### Scenario: Read-only by default over HTTP
- **WHEN** a client lists tools on an HTTP server started without `--allow-write`
- **THEN** capture is absent

### Requirement: Origin token
The HTTP server SHALL refuse to start unless `CONTEXT_KIT_MCP_TOKEN` holds at least 32 characters, read only from the environment, and SHALL answer every request that does not carry it as a bearer token with HTTP 401 before any operation runs.

#### Scenario: Start without a token
- **WHEN** the server is started with `--http` and no token, or a token shorter than 32 characters
- **THEN** it exits nonzero with a coded error naming `CONTEXT_KIT_MCP_TOKEN`, without listening

#### Scenario: Missing or wrong token
- **WHEN** a client calls `/mcp` without a bearer token, or with a different one
- **THEN** the response is 401 and no tool runs

#### Scenario: Correct token
- **WHEN** a client calls `/mcp` with the configured bearer token
- **THEN** it can list and call tools

### Requirement: Loopback by default
The HTTP server SHALL listen on loopback unless `--host` names another address.

#### Scenario: Default address
- **WHEN** the server is started with `--http 0` and no `--host`
- **THEN** the listening URL it reports is on `127.0.0.1`

### Requirement: Host and origin checks
The HTTP server SHALL answer with HTTP 403, before checking the token or running any operation, a request whose `Host` is neither the loopback address and port it listens on nor a host given with `--public-host`, or that carries an `Origin` header not given with `--allow-origin`.

#### Scenario: Rebinding host
- **WHEN** a client sends a request with the correct token and `Host: attacker.example`
- **THEN** the response is 403 and no tool runs

#### Scenario: Browser origin
- **WHEN** a client sends a request with the correct token and `Origin: https://attacker.example`
- **THEN** the response is 403 and no tool runs

#### Scenario: Public host
- **WHEN** the server is started with `--public-host origin.example.com` and a client sends a request with the correct token and that `Host`
- **THEN** it can list and call tools

### Requirement: Client attribution over HTTP
The HTTP server SHALL keep a session per initialized client, so captures over HTTP are attributed to the client that initialized the session, as over stdio.

#### Scenario: Two clients capture
- **WHEN** two clients with different names connect over HTTP to a server with writes allowed and each captures a note
- **THEN** each note's actor names the client that captured it

### Requirement: OAuth edge
The Cloudflare edge SHALL be an OAuth 2.1 authorization server for its `/mcp` resource: it SHALL publish authorization server and protected resource metadata, accept dynamic client registration, and answer `/mcp` requests without a valid access token for that resource with 401 and a `WWW-Authenticate` header pointing to the resource metadata.

#### Scenario: Discovery for a new host
- **WHEN** a host calls `/mcp` on the edge without a token, then follows the metadata and registers a client
- **THEN** it receives 401 with the resource metadata location, metadata naming the authorize, token and registration endpoints, and a client ID

#### Scenario: Invalid token
- **WHEN** a host calls `/mcp` with an access token the edge did not issue
- **THEN** the response is 401 with the resource metadata location and nothing is forwarded

### Requirement: Registration redirect allowlist
The edge SHALL refuse dynamic client registration unless every redirect URI's host is on its configured redirect host allowlist.

#### Scenario: Unlisted redirect host
- **WHEN** a client registers with a redirect URI on a host that is not allowlisted
- **THEN** registration fails with `invalid_redirect_uri` and no client is stored

### Requirement: Consent before sign-in
The edge SHALL show the owner a consent page naming the client and its redirect host before sending them to GitHub, and SHALL only continue from an approval made in the same browser that was shown the page; each consent and sign-in attempt SHALL work once.

#### Scenario: Consent shown first
- **WHEN** a registered client starts authorization
- **THEN** the edge responds with a consent page naming the client and its redirect host, which cannot be framed, and does not redirect to GitHub

#### Scenario: Cross-site approval
- **WHEN** an approval is posted with the consent page's handle but without the browser binding cookie
- **THEN** it is refused and nothing is redirected to GitHub

#### Scenario: Replayed callback
- **WHEN** GitHub's callback for a completed sign-in is sent a second time
- **THEN** it is refused and no second authorization code is issued

### Requirement: PKCE for every client
The edge SHALL require PKCE with `S256` on every authorization request, whatever the client's registration.

#### Scenario: Authorization without PKCE
- **WHEN** a registered client starts authorization without a code challenge, or with method `plain`
- **THEN** the edge refuses the request without showing a consent page

### Requirement: Owner-only sign-in
The edge SHALL sign users in with GitHub and SHALL complete authorization only for GitHub accounts whose numeric user ID is on its configured allowlist; it SHALL refuse to start authorization when the allowlist is empty.

#### Scenario: Allowlisted account
- **WHEN** a registered host completes authorization with PKCE and the user signs in to GitHub as an allowlisted account
- **THEN** the host receives an access and refresh token, and a tool call with the access token returns the workspace's result

#### Scenario: Other account with the owner's login
- **WHEN** the user signs in to GitHub as an account with the owner's login name but a different user ID
- **THEN** no authorization code is issued and the user sees that the account is not allowed

#### Scenario: Empty allowlist
- **WHEN** the edge has no allowlisted user IDs and a client starts authorization
- **THEN** the edge refuses with a message that sign-in is not configured

### Requirement: Token renewal
The edge SHALL issue refresh tokens with access tokens, and a refresh SHALL return a new access token for the same resource.

#### Scenario: Refresh keeps access
- **WHEN** a host exchanges its refresh token
- **THEN** it receives a new access token that can call tools

### Requirement: Forwarding to the origin
The edge SHALL forward authorized `/mcp` requests, including MCP session headers, to the configured origin's `/mcp`, replacing the host's authorization with the origin's bearer token, and SHALL never send that token anywhere else or to hosts.

#### Scenario: Authorized call reaches the workspace
- **WHEN** a host calls a tool through the edge with a valid access token
- **THEN** the origin receives its own bearer token instead of the host's access token, and the host receives the workspace's result without the origin token appearing in any response

#### Scenario: Origin redirect
- **WHEN** the origin answers a forwarded request with a redirect to another address
- **THEN** the edge does not follow it, the other address receives nothing, and the host receives a coded 502 JSON error

### Requirement: Origin failures
The edge SHALL answer with a coded 502 JSON error saying the workspace origin is unreachable when the origin cannot be reached, does not answer in time, or answers with a tunnel or proxy error instead of an MCP response.

#### Scenario: Origin unreachable
- **WHEN** a host calls a tool through the edge with a valid access token while the origin is not reachable
- **THEN** the response is 502 with a coded JSON error saying the workspace origin is unreachable

#### Scenario: Tunnel error page
- **WHEN** the origin address answers with an HTML error page, as a disconnected tunnel does
- **THEN** the response is 502 with the same coded JSON error, without the HTML

### Requirement: Edge configuration
The edge SHALL refuse to forward when its origin token is missing or shorter than 32 characters, or its origin URL is not `https` (or `http` on loopback).

#### Scenario: Missing origin secret
- **WHEN** a host calls a tool with a valid access token on an edge deployed without an origin token
- **THEN** the response is a coded 500 JSON error naming the missing configuration and nothing is forwarded
