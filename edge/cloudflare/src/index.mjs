// Context Kit's OAuth edge: an OAuth 2.1 authorization server for remote MCP hosts that
// admits only allowlisted GitHub accounts and forwards /mcp to the workspace's HTTP origin.
import { OAuthProvider, AuthorizationError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';

const DEFAULT_REDIRECT_HOSTS = ['chatgpt.com', 'claude.ai', 'claude.com'];
const ORIGIN_TIMEOUT_MS = 30_000;
const MAX_ORIGIN_RESPONSE = 4 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'];
const RETURNED_HEADERS = ['content-type', 'mcp-session-id', 'allow'];

const list = value => String(value ?? '').split(/[\s,]+/).filter(Boolean);
const isLoopback = host => host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const jsonError = (status, code, message) =>
  Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
const page = (status, title, body, headers = new Headers()) => {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  // No form-action: browsers apply it to the redirect after a form post, and approving
  // redirects to GitHub (denying, to the client), so 'self' blocks the sign-in.
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  headers.set('X-Frame-Options', 'DENY');
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escape(title)}</title><style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}` +
    `button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style><h1>${escape(title)}</h1>${body}`, { status, headers });
};
const redirect = (location, headers = new Headers()) => {
  headers.set('Location', location);
  return new Response(null, { status: 302, headers });
};
const allowedIds = env => new Set(list(env.ALLOWED_GITHUB_IDS));
const github = (env, name, fallback) => (env[name] || fallback).replace(/\/+$/, '');
const publicUrl = env => {
  const url = new URL(env.PUBLIC_URL);
  return url.origin;
};

async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Errors the library validated may go back to the client; anything else is shown here.
function authorizationFailure(error) {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return redirect(error.redirectTo);
    return page(400, 'Sign-in failed', `<p>${escape(error.description || error.message)}</p><p>Start again from the app you were connecting.</p>`);
  }
  throw error;
}

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === 'POST') return approve(request, env);
  let authRequest;
  try { authRequest = await oauth.parseAuthRequest(request); }
  catch (error) { return authorizationFailure(error); }
  // The library requires PKCE only from public clients; this edge requires it from every client.
  if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') {
    return page(400, 'Sign-in refused', '<p>This server requires PKCE with S256.</p>');
  }
  if (!allowedIds(env).size) {
    return page(503, 'Sign-in is not configured', '<p>No GitHub accounts are allowed to sign in to this server yet.</p>');
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  const loopback = details.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : '';
  return page(200, 'Allow access to your Context Kit workspace?',
    `<p><strong>${escape(details.clientName)}</strong> wants to use your Context Kit workspace through the tools this server offers.</p>` +
    `<p>Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>${loopback}` +
    `<p>You will sign in with GitHub next.</p>` +
    `<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}">` +
    `<button name="action" value="allow">Allow</button><button name="action" value="deny">Deny</button></form>`,
    consent.headers);
}

async function approve(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  try {
    if (form.get('action') !== 'allow') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // Grant only this server's scope, whatever the client asked for.
    const approved = await oauth.approveConsent(request, handle, { scope: ['mcp'] });
    const verifier = randomToken();
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const target = new URL(`${github(env, 'GITHUB_URL', 'https://github.com')}/login/oauth/authorize`);
    target.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${publicUrl(env)}/callback`,
      state, code_challenge: await s256(verifier), code_challenge_method: 'S256', allow_signup: 'false' });
    return redirect(target.href, headers);
  } catch (error) { return authorizationFailure(error); }
}

async function callback(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  let resumed;
  try { resumed = await oauth.finishUpstream(request); }
  catch (error) { return authorizationFailure(error); }
  const { request: original, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  if (params.get('error') || !params.get('code')) return redirect(authorizationErrorRedirect(original, 'access_denied'), headers);
  const exchange = await fetch(`${github(env, 'GITHUB_URL', 'https://github.com')}/login/oauth/access_token`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
      code: params.get('code'), redirect_uri: `${publicUrl(env)}/callback`, code_verifier: data.verifier }),
  });
  const token = exchange.ok ? (await exchange.json()).access_token : undefined;
  if (!token) return page(502, 'GitHub sign-in failed', '<p>GitHub did not confirm the sign-in. Start again from the app you were connecting.</p>', headers);
  const userResponse = await fetch(`${github(env, 'GITHUB_API_URL', 'https://api.github.com')}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'context-kit-edge' },
  });
  const user = userResponse.ok ? await userResponse.json() : {};
  // Logins can be renamed and reclaimed by someone else; the numeric ID cannot.
  if (!Number.isInteger(user.id) || !allowedIds(env).has(String(user.id))) {
    return page(403, 'Account not allowed', `<p>The GitHub account <strong>${escape(user.login ?? 'unknown')}</strong> is not allowed to use this server.</p>`, headers);
  }
  const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: String(user.id),
    metadata: { login: user.login }, scope: original.scope, props: { githubId: user.id, login: user.login } });
  return redirect(redirectTo, headers);
}

const site = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') return authorize(request, env);
    if (pathname === '/callback' && request.method === 'GET') return callback(request, env);
    if (pathname === '/' && request.method === 'GET') {
      return new Response('Context Kit edge. Add this server to an MCP host at /mcp.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new Response('Not found\n', { status: 404 });
  },
};

function originConfig(env) {
  let url;
  try { url = new URL(env.ORIGIN_URL); } catch { return { problem: 'ORIGIN_URL is missing or not a URL' }; }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) {
    return { problem: 'ORIGIN_URL must use https (or http on loopback)' };
  }
  if (String(env.ORIGIN_TOKEN ?? '').length < 32) return { problem: 'ORIGIN_TOKEN is missing or shorter than 32 characters' };
  return { endpoint: new URL('/mcp', url), token: env.ORIGIN_TOKEN };
}

const unreachable = detail => jsonError(502, 'ORIGIN_UNREACHABLE', `The workspace origin is unreachable: ${detail}`);

// Reads the whole origin response under the deadline, so a stalled body becomes a 502 too.
async function readBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((size += value.length) > MAX_ORIGIN_RESPONSE) { await reader.cancel(); throw Object.assign(new Error('too large'), { name: 'TooLarge' }); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

const forward = {
  async fetch(request, env) {
    const { endpoint, token, problem } = originConfig(env);
    if (problem) return jsonError(500, 'EDGE_MISCONFIGURED', problem);
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('Authorization', `Bearer ${token}`);
    const timeout = Number(env.ORIGIN_TIMEOUT_MS) > 0 ? Number(env.ORIGIN_TIMEOUT_MS) : ORIGIN_TIMEOUT_MS;
    let response, body;
    try {
      response = await fetch(endpoint, { method: request.method, headers, redirect: 'manual',
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
        signal: AbortSignal.timeout(timeout) });
      body = await readBody(response);
    } catch (error) {
      if (error?.name === 'TooLarge') return unreachable('its response was too large');
      return unreachable(['TimeoutError', 'AbortError'].includes(error?.name) ? 'it did not answer in time' : 'it could not be reached');
    }
    // Never follow a redirect: it would carry the origin token somewhere else.
    if (response.status >= 300 && response.status < 400) return unreachable('it answered with a redirect');
    if (response.status === 401 || response.status === 403) return unreachable('it refused the edge; check ORIGIN_TOKEN and --public-host');
    // The origin answers in JSON, or with an empty 2xx for notifications and closed sessions.
    // Anything else (a tunnel's HTML page, an empty proxy error) is not the workspace speaking.
    const json = /^application\/json\b/i.test(response.headers.get('content-type') ?? '');
    const emptySuccess = body.length === 0 && response.status >= 200 && response.status < 300;
    if (!json && !emptySuccess) return unreachable(`it answered ${response.status} without an MCP response`);
    if (response.status >= 500 && response.status !== 503) return unreachable(`it answered ${response.status}`);
    const returned = new Headers({ 'Cache-Control': 'no-store' });
    for (const name of RETURNED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) returned.set(name, value);
    }
    return new Response(body.length ? body : null, { status: response.status, headers: returned });
  },
};

// The OAuth resource is this Worker's own /mcp, which is only known from its configuration.
// Providers are cached by every setting they capture, so a changed setting builds a new one
// even in an isolate that survived the deployment.
const providers = new Map();
function provider(env) {
  const base = publicUrl(env);
  const redirectHosts = list(env.ALLOWED_REDIRECT_HOSTS).length ? list(env.ALLOWED_REDIRECT_HOSTS) : DEFAULT_REDIRECT_HOSTS;
  const key = JSON.stringify([base, redirectHosts]);
  if (!providers.has(key)) {
    const hosts = new Set(redirectHosts.map(host => host.toLowerCase()));
    providers.set(key, new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: forward,
      defaultHandler: site,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['mcp'],
      resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base], resource_name: 'Context Kit workspace' },
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 86400,
      refreshTokenIdleTTL: 7 * 86400,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
        const allowed = uris.length > 0 && uris.every(uri => {
          try { return hosts.has(new URL(String(uri)).hostname); } catch { return false; }
        });
        if (!allowed) return { code: 'invalid_redirect_uri', description: 'Redirect URIs must be on this server\'s allowed hosts', status: 400 };
      },
    }));
  }
  return providers.get(key);
}

export default {
  fetch(request, env, ctx) {
    if (!env.PUBLIC_URL) return jsonError(500, 'EDGE_MISCONFIGURED', 'PUBLIC_URL is not set');
    return provider(env).fetch(request, env, ctx);
  },
};
