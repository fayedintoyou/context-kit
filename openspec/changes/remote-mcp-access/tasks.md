# Tasks

## 1. HTTP origin

- [ ] 1.1 Move tool, prompt and actor setup from `bin/mcp.mjs` into `lib/mcp/server.mjs` and verify the existing `test/e2e/mcp.test.mjs` passes unchanged
- [ ] 1.2 Add `--http <port>` and `--host <address>` serving stateless Streamable HTTP at `/mcp`, writing the listening URL as one JSON line to stderr; verify with `test/e2e/remote.test.mjs` linked to `remote-access / Same tools over HTTP` and `remote-access / Read-only by default over HTTP`
- [ ] 1.3 Refuse a non-loopback host without `CONTEXT_KIT_MCP_TOKEN`; verify with `test/e2e/remote.test.mjs` linked to `remote-access / Open address without a token`
- [ ] 1.4 Require the bearer token on every request when it is set, compared in constant time; verify with `test/e2e/remote.test.mjs` linked to `remote-access / Missing or wrong token` and `remote-access / Correct token`
- [ ] 1.5 Document `--http`, `--host` and the token in README "Agents over MCP", the `help` topics and `skills/context-kit/references`, and verify `node bin/hub.mjs validate` and `npm test` pass

## 2. Cloudflare edge

- [ ] 2.1 Add `@cloudflare/workers-oauth-provider` and `wrangler` as pinned root devDependencies and scaffold `edge/cloudflare/` (`wrangler.jsonc` with KV binding and variables for GitHub endpoints, allowlist and origin); verify `npx wrangler deploy --dry-run` builds it
- [ ] 2.2 Write the fake GitHub and the `wrangler dev` harness in `test/e2e/edge.test.mjs`, and implement the OAuth provider setup; verify the test linked to `remote-access / Discovery for a new host`
- [ ] 2.3 Implement GitHub sign-in with the allowlist, refusing an empty allowlist; verify `test/e2e/edge.test.mjs` linked to `remote-access / Allowlisted account` and `remote-access / Other account`
- [ ] 2.4 Implement forwarding with the origin token and the coded 502; verify `test/e2e/edge.test.mjs` linked to `remote-access / Authorized call reaches the workspace` and `remote-access / Origin unreachable`
- [ ] 2.5 Write `docs/remote.md` (origin as a launch agent, named Cloudflare Tunnel, GitHub OAuth app, KV, secrets, deploy, adding the endpoint to ChatGPT and Claude) and link it from README; add connecting real ChatGPT and Claude accounts to `test/manual-checks.md`; verify the guide's commands against a dry run

## 3. Integration

- [ ] 3.1 Deploy to the owner's Cloudflare account following `docs/remote.md` and connect ChatGPT and Claude; record the manual checks' outcome in the PR
