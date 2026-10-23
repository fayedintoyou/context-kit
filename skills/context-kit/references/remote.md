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
settings and deploys it. The examples use `context.example.com` for the edge and
`context-origin.example.com` for the tunnel; use names on a zone in your Cloudflare
account. Keep both names one level below the zone: Cloudflare's free Universal SSL
certificate covers `*.example.com` but not `a.b.example.com`.

## Before you start: credentials an agent uses for you

An agent can do every Cloudflare step below with two values,
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Keep them in your OS secret
store (macOS Keychain, libsecret, a password manager's CLI), never in a repo, hub
or chat. The agent reads them into the environment of the one process that needs
them (`wrangler`, or `curl -K -`), never echoes them, and never passes them as
command-line arguments, which other processes can see.

Create a custom token for this, not a broad one: Account · Workers Scripts Edit,
Workers KV Storage Edit, Cloudflare Tunnel Edit; Zone (your zone only) · DNS Edit,
Workers Routes Edit. Don't give an agent a token that can edit API Tokens or
Billing.

Check the token itself rather than inferring its scope from notes or other
repositories. A token created under an account fails `user/tokens/verify` with
"Invalid API Token" even when it works, so verify it against the account, then read
its permissions:

```sh
printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
  curl -sK - "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify"
# then GET accounts/<account>/tokens/<id from the result> the same way and list
# result.policies[].permission_groups[].name
```

Use `user/tokens/verify` only for tokens created under your user profile. Set
`WRANGLER_SEND_METRICS=false` for wrangler commands an agent runs.

## 1. Run the origin

Create a token and keep it in your secret store. On macOS, generate it to the
clipboard and paste it at the prompt, so it never appears in a command line:

```sh
openssl rand -hex 32 | tr -d '\n' | pbcopy
security add-generic-password -a "$USER" -s CONTEXT_KIT_MCP_TOKEN -w
```

Run the server from your workspace:

```sh
CONTEXT_KIT_MCP_TOKEN="$(security find-generic-password -a "$USER" -s CONTEXT_KIT_MCP_TOKEN -w)" \
  npm run -s mcp -- --http 8788 --public-host context-origin.example.com
```

Add `--allow-write` only if remote hosts should capture notes. To keep it running,
wrap that command in a launch agent (macOS) or a user service (Linux) that reads the
token at start; without it the server refuses to start rather than run open. A
login service doesn't load your shell profile, so give the wrapper absolute paths
for `node` and the workspace.

Over HTTP the server offers the same tools as over stdio, except local-only ones:
tools that resolve a path or checkout on this machine, such as `which_repo` and
`open_repo`. The
client runs somewhere else, so a path it sends, or one it is sent back, would name
the wrong machine. They are not listed over HTTP, and a call to one fails with
`UNKNOWN_OPERATION` before anything runs. Each such tool declares `localOnly` where
it is defined in `lib/operations.mjs`.

## 2. Create the tunnel

With [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/):

```sh
cloudflared tunnel login
cloudflared tunnel create context-origin
cloudflared tunnel route dns context-origin context-origin.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: context-origin
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: context-origin.example.com
    service: http://127.0.0.1:8788
  - service: http_status:404
```

Then `cloudflared tunnel run context-origin`, or `cloudflared service install` to run
it at login. Leave `httpHostHeader` unset: the origin expects the tunnel's hostname,
as given to `--public-host`.

An agent with the API token can do the same without `tunnel login`: create the
tunnel with `config_src: cloudflare` (`POST accounts/<account>/cfd_tunnel`), set its
ingress (`PUT …/cfd_tunnel/<id>/configurations`), add a proxied `CNAME` to
`<id>.cfargotunnel.com`, keep the tunnel's run token in the secret store, and run
`cloudflared tunnel run` with it in `TUNNEL_TOKEN` rather than as an argument.

Either way, check the tunnel refuses requests without the token:

```sh
curl -si -X POST https://context-origin.example.com/mcp | head -1   # HTTP/2 401
```

## 3. Create the GitHub sign-in

Create a GitHub App (Settings → Developer settings → GitHub Apps) or an OAuth app
with the callback URL `https://context.example.com/callback`. For a GitHub App,
untick Webhook → Active (otherwise it demands a webhook URL), leave every permission
at No access, and pick "Only on this account". App names are unique across GitHub,
so use something like "<you> context"; it's the name you approve at sign-in.

The edge needs the **Client ID** (not secret; a GitHub App's starts with `Iv`) and a
**client secret** (shown once). It does not use a GitHub App's private key: don't
generate one, and if one is pasted anywhere, delete it under Private keys. Copy the
Client ID as text rather than reading it off a screenshot (`l` and `I`, `O` and `0`
look alike), and store both at the prompt, typing each command fresh:

```sh
security add-generic-password -a "$USER" -s CONTEXT_EDGE_GITHUB_CLIENT_ID -w
security add-generic-password -a "$USER" -s CONTEXT_EDGE_GITHUB_CLIENT_SECRET -w
```

Check the pair before deploying. With a dummy code, GitHub answers
`bad_verification_code` when the ID and secret are right, and `Not Found` otherwise;
a redirect from its authorization page proves nothing.

```sh
printf 'client_id=%s&client_secret=%s&code=bogus' \
  "$(security find-generic-password -a "$USER" -s CONTEXT_EDGE_GITHUB_CLIENT_ID -w)" \
  "$(security find-generic-password -a "$USER" -s CONTEXT_EDGE_GITHUB_CLIENT_SECRET -w)" |
  curl -s -H 'Accept: application/json' --data @- https://github.com/login/oauth/access_token
```

Find your numeric user ID, which is what the edge allows (logins can be renamed and
reclaimed): `gh api user -q .id`.

## 4. Deploy the edge

Copy the kit's `edge/cloudflare/wrangler.jsonc` into your workspace, for example as
`edge/wrangler.jsonc`, and fill it in:

- `main`: `../node_modules/context-kit/edge/cloudflare/src/index.mjs`, the kit your
  workspace pins, so the live edge matches the pin.
- `kv_namespaces[0].id`: from `npx wrangler kv namespace create OAUTH_KV`.
- `routes`: `[{ "pattern": "context.example.com", "custom_domain": true }]`.
- `vars`: `PUBLIC_URL` (`https://context.example.com`), `ALLOWED_GITHUB_IDS`,
  `ORIGIN_URL` (`https://context-origin.example.com`), `GITHUB_CLIENT_ID`.
  `ALLOWED_REDIRECT_HOSTS` defaults to `chatgpt.com, claude.ai, claude.com`.

Instances don't install the edge's dependencies (they are the kit's development
dependencies), so add them to your workspace at the versions in the kit's
`package.json`: `npm i -D -E wrangler@<version> @cloudflare/workers-oauth-provider@<version>`.
Then, from the workspace:

```sh
security find-generic-password -a "$USER" -s CONTEXT_EDGE_GITHUB_CLIENT_SECRET -w | tr -d '\n' | npx wrangler secret put GITHUB_CLIENT_SECRET --config edge/wrangler.jsonc
security find-generic-password -a "$USER" -s CONTEXT_KIT_MCP_TOKEN -w | tr -d '\n' | npx wrangler secret put ORIGIN_TOKEN --config edge/wrangler.jsonc
npx wrangler deploy --config edge/wrangler.jsonc
```

Check discovery:

```sh
curl -si -X POST https://context.example.com/mcp | grep -i www-authenticate
```

After re-pinning the kit, restart the origin and redeploy the edge if `edge/`
changed. If a fix must go live before it merges, deploy it from the branch, note it
in your workspace, and redeploy from the pin once it lands.

## 5. Connect hosts

**ChatGPT** (Settings → Apps & Connectors, or Plugins; your own plugins may need
developer mode):

| Field | Value |
|---|---|
| Connection | `https://context.example.com/mcp` |
| Resource | `https://context.example.com/mcp` (the edge issues tokens only for this) |
| Authorization server base | `https://context.example.com` |
| Auth, Token, Registration URL | discovered: `/authorize`, `/oauth/token`, `/oauth/register` |
| Client setup method | Dynamic client registration, not Client ID Metadata Documents |
| OIDC enabled | unticked |
| Scopes | `mcp` |

If ChatGPT rewrites Connection or Resource to `/` or `/authorize` after discovery,
retype both exactly. Tick "I understand and want to continue", then "Create as a
plugin", then Connect.

**Claude** (Settings → Connectors → Add custom connector): URL
`https://context.example.com/mcp`; Authentication **Sign in now**; OAuth client
**Register automatically**, not "Claude's published identity" (that is a Client ID
Metadata Document, which the edge doesn't support); no request headers. Connectors
added here also appear in Claude Code.

Each host opens the consent page. Check it names the host and that access goes to
its domain (`chatgpt.com`, `claude.ai`), click Allow once, and sign in with GitHub.
Then, in a new chat with the connector on, ask it to list your hubs: a returned
list is the check, not a "Connected" badge. A good sign-in shows in
`npx wrangler tail --config edge/wrangler.jsonc` as `/authorize`, then `/callback`,
`/oauth/token` and `POST /mcp`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ORIGIN_UNREACHABLE` | The origin or `cloudflared` is not running, or the machine is asleep. |
| `ORIGIN_UNREACHABLE`: "it refused the edge" | `ORIGIN_TOKEN` differs from the origin's token, or `--public-host` does not match the tunnel hostname. |
| `EDGE_MISCONFIGURED` | `ORIGIN_URL` or `ORIGIN_TOKEN` is missing or invalid. |
| "Sign-in is not configured" | `ALLOWED_GITHUB_IDS` is empty. |
| "Account not allowed" | You signed in to GitHub with an account whose ID is not listed. |
| Registration fails with `invalid_redirect_uri` | The host's callback domain is not in `ALLOWED_REDIRECT_HOSTS`. |
| Connect spins and the tail shows no `/authorize` | The browser blocked the sign-in popup. Allow popups for the host's site and click Connect again. |
| Allow fails, or a second click is refused | A consent page can be approved once. Start again from Connect. |
| Sign-in fails at the token step | The host's Resource is not exactly `https://<edge>/mcp`. |
| The tail shows nothing after a deploy | Deploying ends a running `wrangler tail`; start a new one. |
| A token check says "Invalid API Token" | The token is account-owned; verify it at `accounts/<account>/tokens/verify`. |
