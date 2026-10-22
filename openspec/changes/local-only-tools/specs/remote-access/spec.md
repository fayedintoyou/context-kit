# Spec Delta

## MODIFIED Requirements

### Requirement: HTTP transport
The MCP server SHALL serve Streamable HTTP at `/mcp` when started with `--http <port>`, offering the same tools and prompts as the stdio server for the same options, with equivalent results and coded errors, except that local-only tools are not offered and `list_repos` labels checkout paths as the serving machine's.

#### Scenario: Same tools over HTTP
- **WHEN** a client lists tools and reads a hub's context over HTTP and over stdio from servers started with the same workspace and options
- **THEN** both list the same tools apart from the local-only ones, which only stdio lists, and return equivalent results

#### Scenario: Same prompts over HTTP
- **WHEN** a client lists prompts and gets a skill prompt over HTTP and over stdio
- **THEN** both return the same prompts and the same prompt text

#### Scenario: Same coded errors over HTTP
- **WHEN** a client reads a missing hub over HTTP and over stdio
- **THEN** both return a tool error with the same error code

#### Scenario: No standalone stream
- **WHEN** a client sends `GET /mcp` with the correct token
- **THEN** the response is 405, and an MCP SDK client still initializes and calls tools without transport errors

#### Scenario: Read-only by default over HTTP
- **WHEN** a client lists tools on an HTTP server started without `--allow-write`
- **THEN** capture is absent

## ADDED Requirements

### Requirement: Local-only tools
Tools that resolve a path or checkout on this machine (such as `which_repo`, or a tool that opens a repository's local checkout) SHALL be local-only: offered over stdio and never over HTTP, and a call to one over HTTP SHALL fail with `UNKNOWN_OPERATION`. Each such tool SHALL declare itself local-only where it is defined.

#### Scenario: Local-only tools stay local
- **WHEN** a stdio client and an HTTP client list tools on servers started with the same workspace and options, and the HTTP client calls `which_repo` anyway
- **THEN** stdio lists `which_repo`, HTTP does not, and the HTTP call fails with `UNKNOWN_OPERATION` and no operation runs

#### Scenario: Every local-only tool is withheld
- **WHEN** the HTTP server's tool list is compared with every operation the core declares local-only
- **THEN** none of them is offered over HTTP

### Requirement: Serving machine paths
Over HTTP, `list_repos` SHALL name the serving machine (`--machine-name`, default its host name) and return each local checkout as `servingMachinePath` instead of `path`, and its description SHALL say these paths are on the serving machine. Over stdio it SHALL return `path` with no machine label.

#### Scenario: Remote client sees whose paths they are
- **WHEN** an HTTP client of a server started with `--machine-name studio` calls `list_repos` on a workspace with a located repository
- **THEN** the result names machine `studio`, gives that repository's `servingMachinePath` and no `path`, and the tool's description says the paths are on the serving machine

#### Scenario: Local clients unchanged
- **WHEN** a stdio client calls `list_repos` on the same workspace
- **THEN** it receives `path` as before and no machine label
