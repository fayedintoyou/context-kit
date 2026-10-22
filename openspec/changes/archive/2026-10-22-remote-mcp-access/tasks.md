# Tasks

## 1. HTTP origin

- [x] 1.1 Move tool, prompt and actor setup from `bin/mcp.mjs` into `lib/mcp/server.mjs` and verify the existing `test/e2e/mcp.test.mjs` passes unchanged
- [x] 1.2 Add `--http <port>` and `--host <address>` serving stateful Streamable HTTP with JSON responses at `/mcp`, with idle session expiry, writing the listening URL as one JSON line to stderr; add repeatable options to `lib/arguments.mjs`; verify with `test/e2e/remote.test.mjs` linked to `remote-access / Same tools over HTTP`, `Same prompts over HTTP`, `Same coded errors over HTTP`, `No standalone stream`, `Read-only by default over HTTP`, `Default address`, `Two clients capture`, `Ended session` and `Session limit`
- [x] 1.3 Require `CONTEXT_KIT_MCP_TOKEN` (32+ characters, environment only, constant-time compare) in HTTP mode; verify with `test/e2e/remote.test.mjs` linked to `remote-access / Start without a token`, `Missing or wrong token` and `Correct token`
- [x] 1.4 Check Host and Origin before the token, with `--public-host` and `--allow-origin`; verify with `test/e2e/remote.test.mjs` linked to `remote-access / Rebinding host`, `Browser origin` and `Public host`
- [x] 1.5 Document the HTTP options and token in README "Agents over MCP", the `help` topics and `skills/context-kit/references`, and verify `node bin/hub.mjs validate` passes and `npm test` fails only on the edge's unlinked scenarios

## 2. Cloudflare edge

- [x] 2.1 Add `@cloudflare/workers-oauth-provider@1.2.3` and `wrangler@4.151.1` as exact root devDependencies and scaffold `edge/cloudflare/` (`wrangler.jsonc` with the KV binding and variables for GitHub endpoints, allowlists and origin); verify `npx wrangler deploy --dry-run` builds it
- [x] 2.2 Build the `test/e2e/edge.test.mjs` harness (origin, fake GitHub, `wrangler dev`, cookie-jar client) and the OAuth provider setup with the registration redirect allowlist; verify the tests linked to `remote-access / Discovery for a new host`, `Invalid token` and `Unlisted redirect host`
- [x] 2.3 Implement authorize, consent, approval and the GitHub callback with PKCE enforcement and the numeric ID allowlist; verify `test/e2e/edge.test.mjs` linked to `remote-access / Consent shown first`, `Cross-site approval`, `Replayed callback`, `Authorization without PKCE`, `Wrong verifier`, `Allowlisted account`, `Other account with the owner's login`, `Empty allowlist` and `Refresh keeps access`
- [x] 2.4 Implement forwarding with the origin token, session headers, no redirects, the timeout and failure normalization, and configuration checks; verify `test/e2e/edge.test.mjs` linked to `remote-access / Authorized call reaches the workspace`, `Origin redirect`, `Origin unreachable`, `Tunnel error page` and `Missing origin secret`
- [x] 2.5 Write `docs/remote.md` (origin as a launch agent with its token, named Cloudflare Tunnel with `--public-host`, GitHub OAuth app, KV, secrets, deploy, adding the endpoint to ChatGPT and Claude) and link it from README; add connecting ChatGPT, Claude and the connector in Claude Code to `test/manual-checks.md`; verify `npm test` passes with every scenario linked

## 3. Integration

- [x] 3.1 Deploy to the owner's Cloudflare account following `docs/remote.md` and connect ChatGPT, Claude and Claude Code; record the manual checks' outcome on the integration PR
