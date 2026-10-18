# Remote access

Use a workspace from MCP hosts that only connect to remote servers: a ChatGPT
plugin, or a Claude custom connector (which Claude Code on the web, Desktop and
phone also picks up). On your own machine, the stdio server that `agents install`
registers is still the better connection.

```
ChatGPT / Claude ──OAuth──▶ edge (Cloudflare Worker) ──origin token──▶ Cloudflare Tunnel ──▶ mcp --http (your machine)
```

- The **origin** is the workspace's MCP server over HTTP. It never runs without a
  token, and refuses unexpected `Host` and `Origin` headers.
- The **edge** is an OAuth 2.1 server for the hosts. It shows a consent page for
  each new client, signs you in with GitHub, admits only the GitHub user IDs you
  list, and forwards to the origin with the origin token, which hosts never see.
- The workspace stays on your machine. While it sleeps, hosts get a coded
  `ORIGIN_UNREACHABLE` error.

The kit ships the edge in `edge/cloudflare/`; your workspace keeps its deployment
settings. The examples use `context.example.com` for the edge and
`origin.context.example.com` for the tunnel; use names on a zone in your Cloudflare
account.

## 1. Run the origin

Create a token and keep it somewhere private, such as the macOS Keychain:

```sh
security add-generic-password -a "$USER" -s CONTEXT_KIT_MCP_TOKEN -w "$(openssl rand -hex 32)"
```

Run the server from your workspace:

```sh
CONTEXT_KIT_MCP_TOKEN="$(security find-generic-password -a "$USER" -s CONTEXT_KIT_MCP_TOKEN -w)" \
  npm run -s mcp -- --http 8788 --public-host origin.context.example.com
```

Add `--allow-write` only if remote hosts should capture notes. To keep it running,
wrap that command in a launch agent (macOS) or a user service (Linux) that reads the
token at start; without it the server refuses to start rather than run open.

## 2. Create the tunnel

With [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/):

```sh
cloudflared tunnel login
cloudflared tunnel create context-origin
cloudflared tunnel route dns context-origin origin.context.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: context-origin
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: origin.context.example.com
    service: http://127.0.0.1:8788
  - service: http_status:404
```

Then `cloudflared tunnel run context-origin`, or `cloudflared service install` to run
it at login. Leave `httpHostHeader` unset: the origin expects the tunnel's hostname,
as given to `--public-host`. Check it refuses requests without the token:

```sh
curl -si -X POST https://origin.context.example.com/mcp | head -1   # HTTP/2 401
```

## 3. Create the GitHub sign-in

Create a GitHub OAuth app (or a GitHub App with webhooks off and no permissions)
with the callback URL `https://context.example.com/callback`, and generate a client
secret. Find your numeric user ID, which is what the edge allows (logins can be
renamed and reclaimed):

```sh
gh api user -q .id
```

## 4. Deploy the edge

Copy `edge/cloudflare/wrangler.jsonc` into your workspace, for example as
`edge/wrangler.jsonc`, and fill it in:

- `main`: the kit's `edge/cloudflare/src/index.mjs` (an absolute path, or relative to
  the copied file).
- `kv_namespaces[0].id`: from `npx wrangler kv namespace create OAUTH_KV`.
- `routes`: `[{ "pattern": "context.example.com", "custom_domain": true }]`.
- `vars`: `PUBLIC_URL` (`https://context.example.com`), `ALLOWED_GITHUB_IDS`,
  `ORIGIN_URL` (`https://origin.context.example.com`), `GITHUB_CLIENT_ID`.
  `ALLOWED_REDIRECT_HOSTS` defaults to `chatgpt.com, claude.ai, claude.com`.

The edge's dependencies are the kit's development dependencies, so deploy from a
kit checkout after `npm ci`:

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET --config ~/context/edge/wrangler.jsonc
security find-generic-password -a "$USER" -s CONTEXT_KIT_MCP_TOKEN -w | npx wrangler secret put ORIGIN_TOKEN --config ~/context/edge/wrangler.jsonc
npx wrangler deploy --config ~/context/edge/wrangler.jsonc
```

Check discovery:

```sh
curl -si -X POST https://context.example.com/mcp | grep -i www-authenticate
```

## 5. Connect hosts

Add `https://context.example.com/mcp` as a custom connector in Claude (Settings →
Connectors) or as a plugin's MCP server in ChatGPT. Each host opens the consent page:
check the client name and that access goes to that host's domain, allow it, and
sign in with GitHub. Connectors added in Claude also appear in Claude Code.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ORIGIN_UNREACHABLE` | The origin or `cloudflared` is not running, or the machine is asleep. |
| `ORIGIN_UNREACHABLE`: "it refused the edge" | `ORIGIN_TOKEN` differs from the origin's token, or `--public-host` does not match the tunnel hostname. |
| `EDGE_MISCONFIGURED` | `ORIGIN_URL` or `ORIGIN_TOKEN` is missing or invalid. |
| "Sign-in is not configured" | `ALLOWED_GITHUB_IDS` is empty. |
| "Account not allowed" | You signed in to GitHub with an account whose ID is not listed. |
| Registration fails with `invalid_redirect_uri` | The host's callback domain is not in `ALLOWED_REDIRECT_HOSTS`. |
