# Spec Delta

## Purpose

Serve a workspace's Context Kit tools to remote MCP hosts, such as ChatGPT plugins and Claude connectors, over HTTP, admitting only the workspace owner.

## ADDED Requirements

### Requirement: HTTP transport
The MCP server SHALL serve Streamable HTTP at `/mcp` when started with `--http <port>`, offering the same tools and prompts as the stdio server for the same options, with equivalent results and coded errors.

#### Scenario: Same tools over HTTP
- **WHEN** a client lists tools and reads a hub's context over HTTP and over stdio from servers started with the same workspace and options
- **THEN** both list the same tools and return equivalent results

#### Scenario: Read-only by default over HTTP
- **WHEN** a client lists tools on an HTTP server started without `--allow-write`
- **THEN** capture is absent

### Requirement: Loopback by default
The HTTP server SHALL listen on loopback unless `--host` names another address, and SHALL refuse to start on a non-loopback address when no access token is configured.

#### Scenario: Open address without a token
- **WHEN** the server is started with `--http` and a non-loopback `--host` and no token in the environment
- **THEN** it exits nonzero with a coded error naming `CONTEXT_KIT_MCP_TOKEN`, without listening

### Requirement: Token-protected origin
When `CONTEXT_KIT_MCP_TOKEN` is set, the HTTP server SHALL serve only requests carrying it as a bearer token, answering others with HTTP 401 before any operation runs. The token SHALL be read only from the environment, never from arguments.

#### Scenario: Missing or wrong token
- **WHEN** a client calls `/mcp` without a bearer token, or with a different one, on a server that has a token configured
- **THEN** the response is 401 and no tool runs

#### Scenario: Correct token
- **WHEN** a client calls `/mcp` with the configured bearer token
- **THEN** it can list and call tools

### Requirement: OAuth edge
The Cloudflare edge SHALL act as an OAuth 2.1 authorization server for `/mcp`: it SHALL publish authorization server and protected resource metadata, accept dynamic client registration, require PKCE, and answer `/mcp` requests without a valid access token with 401 and a `WWW-Authenticate` header pointing to the resource metadata.

#### Scenario: Discovery for a new host
- **WHEN** a host calls `/mcp` on the edge without a token, then follows the metadata and registers a client
- **THEN** it receives 401 with the resource metadata location, metadata naming the authorize, token and registration endpoints, and a client ID

### Requirement: Owner-only sign-in
The edge SHALL sign users in with GitHub and SHALL grant access only to GitHub accounts on its configured allowlist; it SHALL refuse to start authorization when the allowlist is empty.

#### Scenario: Allowlisted account
- **WHEN** a registered host completes authorization and the user signs in to GitHub as an allowlisted account
- **THEN** the host receives an access token, and a tool call with it returns the workspace's result

#### Scenario: Other account
- **WHEN** the user signs in to GitHub as an account not on the allowlist
- **THEN** no authorization code is issued and the user sees that the account is not allowed

### Requirement: Forwarding to the origin
The edge SHALL forward authorized `/mcp` requests to the configured origin, replacing the host's authorization with the origin's bearer token, and SHALL never send that token to hosts.

#### Scenario: Authorized call reaches the workspace
- **WHEN** a host calls a tool through the edge with a valid access token
- **THEN** the origin receives its own bearer token instead of the host's access token, and the host receives the workspace's result without the origin token appearing in any response

#### Scenario: Origin unreachable
- **WHEN** a host calls a tool through the edge with a valid access token while the origin is not reachable
- **THEN** the response is 502 with a coded JSON error saying the workspace origin is unreachable
