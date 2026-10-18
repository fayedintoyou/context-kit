// The Cloudflare edge, run in workerd by `wrangler dev` against a fake GitHub, the real HTTP
// origin and fixture origins for failure modes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const OWNER = { id: 4242, login: 'owner' };
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ORIGIN_TOKEN = randomBytes(32).toString('hex');
const GITHUB_CLIENT_ID = 'Iv-test-client';
const GITHUB_CLIENT_SECRET = 'github-test-secret';
const base64url = buffer => Buffer.from(buffer).toString('base64url');
const challengeOf = verifier => base64url(createHash('sha256').update(verifier).digest());

let base, children = [], servers = [];
const edges = {};
let github, fixture, origin;

function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
async function freePort() {
  const { server } = await listen(() => {});
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  servers = servers.filter(item => item !== server);
  return port;
}
const body = request => new Promise(resolve => {
  let data = '';
  request.on('data', chunk => { data += chunk; });
  request.on('end', () => resolve(data));
});
function waitFor(child, pattern, label) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${label} did not start:\n${output}`)), 60_000);
    const read = chunk => {
      output += chunk;
      const match = output.match(pattern);
      if (match) { clearTimeout(timer); resolve(match); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`${label} exited ${code}:\n${output}`)); });
  });
}

// GitHub's OAuth endpoints and /user, for whichever account the test signs in as.
async function fakeGithub() {
  const codes = new Map(), tokens = new Map();
  const state = { signInAs: OWNER };
  const { url } = await listen(async (request, response) => {
    const address = new URL(request.url, 'http://github.test');
    if (address.pathname === '/login/oauth/authorize') {
      const code = base64url(randomBytes(16));
      codes.set(code, { user: state.signInAs, challenge: address.searchParams.get('code_challenge'),
        clientId: address.searchParams.get('client_id'), redirectUri: address.searchParams.get('redirect_uri') });
      const back = new URL(address.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', address.searchParams.get('state'));
      response.writeHead(302, { Location: back.href }).end();
    } else if (address.pathname === '/login/oauth/access_token' && request.method === 'POST') {
      const form = new URLSearchParams(await body(request));
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const valid = grant && form.get('client_id') === GITHUB_CLIENT_ID && form.get('client_secret') === GITHUB_CLIENT_SECRET
        && form.get('redirect_uri') === grant.redirectUri && challengeOf(form.get('code_verifier') ?? '') === grant.challenge;
      if (!valid) return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad_verification_code' }));
      const token = `gho_${base64url(randomBytes(16))}`;
      tokens.set(token, grant.user);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: token, token_type: 'bearer' }));
    } else if (address.pathname === '/user') {
      const user = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!user) return response.writeHead(401).end();
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(user));
    } else response.writeHead(404).end();
  });
  return Object.assign(state, { url });
}

// An origin whose failure mode a test chooses; `target` records anything a redirect reaches.
async function fixtureOrigin() {
  const state = { mode: 'html', targetHits: [], originHits: 0 };
  const target = await listen((request, response) => {
    state.targetHits.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  const { url } = await listen((request, response) => {
    state.originHits++;
    if (state.mode === 'redirect') response.writeHead(307, { Location: `${target.url}/mcp` }).end();
    else if (state.mode === 'drop') request.socket.destroy();
    else if (state.mode === 'stall') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"jsonrpc":"2.0",'); }
    else if (state.mode === 'html404' || state.mode === 'html405') {
      response.writeHead(Number(state.mode.slice(4)), { 'Content-Type': 'text/html' }).end('<html><body>Not found</body></html>');
    } else if (state.mode === 'empty502') response.writeHead(502, { 'Content-Length': '0' }).end();
    else response.writeHead(530, { 'Content-Type': 'text/html' }).end('<html><body>Error 1033: Argo Tunnel error</body></html>');
  });
  return Object.assign(state, { url });
}

async function startOrigin() {
  const workspace = join(base, 'workspace');
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1', CONTEXT_KIT_MCP_TOKEN: ORIGIN_TOKEN };
  delete env.CONTEXT_KIT_ROOT;
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', workspace], { env });
  const child = spawn(process.execPath, [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--http', '0'], { env, cwd: base });
  children.push(child);
  const [, url] = await waitFor(child, /"(http:\/\/127\.0\.0\.1:\d+)[^"]*"/, 'origin');
  return { url };
}

async function startEdge(name, vars) {
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const all = { PUBLIC_URL: publicUrl, GITHUB_URL: github.url, GITHUB_API_URL: github.url, GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET, ALLOWED_GITHUB_IDS: String(OWNER.id), ...vars };
  const args = ['dev', '--config', join(kit, 'edge/cloudflare/wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', String(await freePort()), '--persist-to', join(base, `wrangler-${name}`), '--local',
    '--show-interactive-dev-session=false', '--log-level', 'info'];
  for (const [key, value] of Object.entries(all)) if (value !== undefined) args.push('--var', `${key}:${value}`);
  const child = spawn(join(kit, 'node_modules/.bin/wrangler'), args, { cwd: base,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' } });
  children.push(child);
  await waitFor(child, /Ready on http/, `edge ${name}`);
  edges[name] = publicUrl;
}

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-edge-')));
  github = await fakeGithub();
  fixture = await fixtureOrigin();
  origin = await startOrigin();
  await Promise.all([
    startEdge('main', { ORIGIN_URL: origin.url, ORIGIN_TOKEN }),
    startEdge('fixture', { ORIGIN_URL: fixture.url, ORIGIN_TOKEN, ORIGIN_TIMEOUT_MS: '1500' }),
    startEdge('closed', { ORIGIN_URL: `http://127.0.0.1:${await freePort()}`, ORIGIN_TOKEN }),
    startEdge('unconfigured', { ALLOWED_GITHUB_IDS: '', ORIGIN_URL: origin.url, ORIGIN_TOKEN }),
    startEdge('secretless', { ORIGIN_URL: fixture.url }),
  ]);
}, { timeout: 120_000 });
after(async () => {
  await Promise.all(children.map(child => child.exitCode !== null ? undefined
    : new Promise(resolve => { child.once('exit', resolve); child.kill(); })));
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  if (base) await rm(base, { recursive: true, force: true });
});

// A browser with a cookie jar per host, never following redirects by itself.
class Browser {
  jar = new Map();
  async fetch(url, init = {}) {
    const address = new URL(url);
    const cookies = this.jar.get(address.host) ?? new Map();
    const headers = new Headers(init.headers);
    if (cookies.size) headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const name = pair.slice(0, pair.indexOf('=')).trim(), value = pair.slice(pair.indexOf('=') + 1).trim();
      const expired = attributes.some(item => /^\s*max-age=0\s*$/i.test(item) || /^\s*expires=thu, 01 jan 1970/i.test(item));
      if (expired || !value) cookies.delete(name); else cookies.set(name, value);
    }
    this.jar.set(address.host, cookies);
    return response;
  }
}
const html = async response => response.text();
const handleOf = text => text.match(/name="handle" value="([^"]+)"/)?.[1];

async function register(edge, { redirectUris = [REDIRECT], confidential = false } = {}) {
  const response = await fetch(`${edge}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Host', redirect_uris: redirectUris,
      token_endpoint_auth_method: confidential ? 'client_secret_basic' : 'none', grant_types: ['authorization_code', 'refresh_token'] }) });
  return { status: response.status, client: await response.json() };
}
function authorizeUrl(edge, client, { pkce = 'S256', verifier = base64url(randomBytes(32)) } = {}) {
  const url = new URL(`${edge}/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
    state: 'host-state', scope: 'mcp', resource: `${edge}/mcp` });
  if (pkce === 'S256') { url.searchParams.set('code_challenge', challengeOf(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
  if (pkce === 'plain') { url.searchParams.set('code_challenge', verifier); url.searchParams.set('code_challenge_method', 'plain'); }
  return { url: url.href, verifier };
}
// Consent, GitHub sign-in and the callback; returns the browser and what reached the host.
async function signIn(edge, client, user = OWNER) {
  const browser = new Browser();
  const { url, verifier } = authorizeUrl(edge, client);
  const consent = await browser.fetch(url);
  assert.equal(consent.status, 200, 'consent page');
  const handle = handleOf(await html(consent));
  const approved = await browser.fetch(`${edge}/authorize`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, action: 'allow' }) });
  assert.equal(approved.status, 302, 'approval redirects to GitHub');
  github.signInAs = user;
  const fromGithub = await browser.fetch(approved.headers.get('location'));
  const callbackUrl = fromGithub.headers.get('location');
  const finished = await browser.fetch(callbackUrl);
  return { browser, verifier, callbackUrl, finished };
}
async function token(edge, form) {
  const response = await fetch(`${edge}/oauth/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  return { status: response.status, body: await response.json() };
}
async function authorized(edge = edges.main) {
  const { client } = await register(edge);
  const { finished, verifier } = await signIn(edge, client);
  const code = new URL(finished.headers.get('location')).searchParams.get('code');
  const { body } = await token(edge, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    client_id: client.client_id, code_verifier: verifier, resource: `${edge}/mcp` });
  return { client, tokens: body };
}
async function connect(edge, accessToken, name = 'edge-test') {
  const transport = new StreamableHTTPClientTransport(new URL(`${edge}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(transport);
  return client;
}
const initialize = (edge, accessToken) => fetch(`${edge}/mcp`, { method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }) });

// spec: remote-access / Discovery for a new host
test('a host discovers the edge, its metadata and registers', async () => {
  const challenge = await fetch(`${edges.main}/mcp`, { method: 'POST' });
  assert.equal(challenge.status, 401);
  const metadataUrl = challenge.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/)[1];
  const resource = await (await fetch(metadataUrl)).json();
  assert.equal(resource.resource, `${edges.main}/mcp`);
  const server = await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.equal(server.authorization_endpoint, `${edges.main}/authorize`);
  assert.equal(server.token_endpoint, `${edges.main}/oauth/token`);
  assert.equal(server.registration_endpoint, `${edges.main}/oauth/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  const { status, client } = await register(edges.main);
  assert.equal(status, 201);
  assert.ok(client.client_id);
});

// spec: remote-access / Invalid token
test('a token the edge did not issue is refused', async () => {
  const hits = fixture.originHits;
  const response = await initialize(edges.fixture, 'not-a-token');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
  assert.equal(fixture.originHits, hits);
});

// spec: remote-access / Unlisted redirect host
test('registration with a redirect host off the allowlist fails', async () => {
  const { status, client } = await register(edges.main, { redirectUris: ['https://attacker.example/callback'] });
  assert.equal(status, 400);
  assert.equal(client.error, 'invalid_redirect_uri');
  const mixed = await register(edges.main, { redirectUris: [REDIRECT, 'https://attacker.example/callback'] });
  assert.equal(mixed.status, 400);
});

// spec: remote-access / Consent shown first
test('authorization shows a consent page before any GitHub redirect', async () => {
  const { client } = await register(edges.main);
  const response = await new Browser().fetch(authorizeUrl(edges.main, client).url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  // A form-action limited to this site would block the approval's redirect to GitHub in browsers.
  assert.doesNotMatch(response.headers.get('content-security-policy'), /form-action/);
  const text = await html(response);
  assert.match(text, /Test Host/);
  assert.match(text, /tools this server offers/);
  assert.match(text, /claude\.ai/);
  assert.ok(handleOf(text));
});

// spec: remote-access / Cross-site approval
test('an approval without the browser binding is refused', async () => {
  const { client } = await register(edges.main);
  const shown = await new Browser().fetch(authorizeUrl(edges.main, client).url);
  const handle = handleOf(await html(shown));
  const forged = await fetch(`${edges.main}/authorize`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, action: 'allow' }) });
  assert.equal(forged.status, 400);
  assert.equal(forged.headers.get('location'), null);
});

// spec: remote-access / Replayed callback
test('a replayed GitHub callback issues no second code', async () => {
  const { client } = await register(edges.main);
  const { browser, callbackUrl, finished } = await signIn(edges.main, client);
  assert.equal(finished.status, 302);
  assert.ok(new URL(finished.headers.get('location')).searchParams.get('code'));
  const replay = await browser.fetch(callbackUrl);
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.get('location'), null);
});

// spec: remote-access / Authorization without PKCE
test('authorization without S256 PKCE is refused for public and confidential clients', async () => {
  for (const confidential of [false, true]) {
    const { client } = await register(edges.main, { confidential });
    for (const pkce of ['none', 'plain']) {
      const response = await new Browser().fetch(authorizeUrl(edges.main, client, { pkce }).url);
      const text = response.status === 302 ? '' : await html(response);
      assert.equal(handleOf(text), undefined, `${confidential ? 'confidential' : 'public'} client, ${pkce}`);
      assert.ok(response.status === 400 || (response.status === 302 && new URL(response.headers.get('location')).searchParams.get('error')),
        `${confidential ? 'confidential' : 'public'} client, ${pkce}: ${response.status}`);
    }
  }
});

// spec: remote-access / Wrong verifier
test('a code exchanged with the wrong verifier yields no token', async () => {
  const { client } = await register(edges.main);
  const { finished } = await signIn(edges.main, client);
  const code = new URL(finished.headers.get('location')).searchParams.get('code');
  const { status, body } = await token(edges.main, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    client_id: client.client_id, code_verifier: base64url(randomBytes(32)), resource: `${edges.main}/mcp` });
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_grant');
  assert.equal(body.access_token, undefined);
});

// spec: remote-access / Allowlisted account
test('the owner signs in and the host can call tools', async () => {
  const { tokens } = await authorized();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.resource ?? `${edges.main}/mcp`, `${edges.main}/mcp`);
  const client = await connect(edges.main, tokens.access_token);
  const result = await client.callTool({ name: 'list_hubs', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.ok(JSON.parse(result.content[0].text).hubs);
  await client.close();
});

// spec: remote-access / Other account with the owner's login
test('an account with the owner\'s login but another ID is not allowed', async () => {
  const { client } = await register(edges.main);
  const { finished } = await signIn(edges.main, client, { id: 9999, login: OWNER.login });
  assert.equal(finished.status, 403);
  assert.equal(finished.headers.get('location'), null);
  assert.match(await html(finished), /not allowed/);
});

// spec: remote-access / Empty allowlist
test('an edge without allowlisted accounts refuses to authorize', async () => {
  const { client } = await register(edges.unconfigured);
  const response = await new Browser().fetch(authorizeUrl(edges.unconfigured, client).url);
  assert.equal(response.status, 503);
  const text = await html(response);
  assert.match(text, /not configured/);
  assert.equal(handleOf(text), undefined);
});

// spec: remote-access / Refresh keeps access
test('a refreshed access token can call tools', async () => {
  const { client, tokens } = await authorized();
  const refreshed = await token(edges.main, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    client_id: client.client_id, resource: `${edges.main}/mcp` });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.access_token, tokens.access_token);
  const mcp = await connect(edges.main, refreshed.body.access_token);
  assert.ok((await mcp.listTools()).tools.length);
  await mcp.close();
});

// spec: remote-access / Authorized call reaches the workspace
test('calls through the edge reach the origin with its own token, which never comes back', async () => {
  const { tokens } = await authorized();
  const client = await connect(edges.main, tokens.access_token);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'get_context'));
  await client.close();
  const raw = await initialize(edges.main, tokens.access_token);
  assert.equal(raw.status, 200);
  const text = await raw.text();
  assert.ok(!text.includes(ORIGIN_TOKEN));
  assert.ok(![...raw.headers.values()].some(value => value.includes(ORIGIN_TOKEN)));
  // The origin accepts only its own token, so it can only have answered because the edge replaced the host's.
  const direct = await initialize(origin.url, tokens.access_token);
  assert.equal(direct.status, 401);
});

// spec: remote-access / Origin redirect
test('an origin redirect is not followed', async () => {
  const { tokens } = await authorized(edges.fixture);
  fixture.mode = 'redirect';
  fixture.targetHits.length = 0;
  const response = await initialize(edges.fixture, tokens.access_token);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'ORIGIN_UNREACHABLE');
  assert.equal(fixture.targetHits.length, 0);
});

// spec: remote-access / Origin unreachable
test('an unreachable origin is a coded 502', async () => {
  const { tokens } = await authorized(edges.closed);
  const response = await initialize(edges.closed, tokens.access_token);
  assert.equal(response.status, 502);
  const { error } = await response.json();
  assert.equal(error.code, 'ORIGIN_UNREACHABLE');
  assert.match(error.message, /unreachable/);
  const fromFixture = await authorized(edges.fixture);
  fixture.mode = 'drop';
  const dropped = await initialize(edges.fixture, fromFixture.tokens.access_token);
  assert.equal(dropped.status, 502);
  // Headers then silence: the deadline covers the whole response, not just its start.
  fixture.mode = 'stall';
  const started = Date.now();
  const stalled = await initialize(edges.fixture, fromFixture.tokens.access_token);
  assert.equal(stalled.status, 502);
  assert.equal((await stalled.json()).error.code, 'ORIGIN_UNREACHABLE');
  assert.ok(Date.now() - started < 10_000);
});

// spec: remote-access / Tunnel error page
test('a tunnel error page becomes the same coded 502', async () => {
  const { tokens } = await authorized(edges.fixture);
  fixture.mode = 'html';
  const response = await initialize(edges.fixture, tokens.access_token);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, 'ORIGIN_UNREACHABLE');
  assert.ok(!text.includes('<html'));
  for (const mode of ['html404', 'html405', 'empty502']) {
    fixture.mode = mode;
    const proxied = await initialize(edges.fixture, tokens.access_token);
    assert.equal(proxied.status, 502, mode);
    assert.equal((await proxied.json()).error.code, 'ORIGIN_UNREACHABLE', mode);
  }
});

// spec: remote-access / Missing origin secret
test('an edge without its origin token forwards nothing', async () => {
  const { tokens } = await authorized(edges.secretless);
  const hits = fixture.originHits;
  const response = await initialize(edges.secretless, tokens.access_token);
  assert.equal(response.status, 500);
  const { error } = await response.json();
  assert.equal(error.code, 'EDGE_MISCONFIGURED');
  assert.match(error.message, /ORIGIN_TOKEN/);
  assert.equal(fixture.originHits, hits);
});
