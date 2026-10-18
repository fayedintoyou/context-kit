// Streamable HTTP adapter for the MCP server: an origin safe to reach through a public tunnel.
// Each request passes Host/Origin (403), then the bearer token (401), then the SDK transport.
import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { errorData, fail } from '../files.mjs';

const MAX_BODY = 4 * 1024 * 1024;

function integer(options, name, fallback, min) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!/^\d+$/.test(options[name]) || value < min) fail('INVALID_INPUT', `${name} must be an integer of at least ${min}`);
  return value;
}

// Validates the HTTP options and the token (environment only: arguments show in process listings).
export function httpOptions(options, env) {
  const token = env.CONTEXT_KIT_MCP_TOKEN ?? '';
  if (token.length < 32) fail('TOKEN_REQUIRED', 'HTTP mode requires CONTEXT_KIT_MCP_TOKEN in the environment, at least 32 characters');
  const port = integer(options, '--http', 0, 0);
  if (port > 65535) fail('INVALID_INPUT', '--http must be a port from 0 to 65535');
  return { token, port, host: options['--host'] ?? '127.0.0.1',
    publicHosts: (options['--public-host'] ?? []).map(host => host.toLowerCase()), allowOrigins: options['--allow-origin'] ?? [],
    maxSessions: integer(options, '--max-sessions', 16, 1), idleMs: integer(options, '--session-idle', 1800, 1) * 1000 };
}

const digest = value => createHash('sha256').update(value).digest();
const authorized = (header, token) => {
  const match = /^Bearer (\S+)$/i.exec(header ?? '');
  // Hashing both sides gives equal lengths, so the comparison takes constant time.
  return Boolean(match) && timingSafeEqual(digest(match[1]), digest(token));
};

function reply(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: errorData({ code, message }) }));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > MAX_BODY) fail('PAYLOAD_TOO_LARGE', 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_INPUT', 'Request body is not valid JSON'); }
}

export async function serveHttp(create, { token, port, host, publicHosts, allowOrigins, maxSessions, idleMs }) {
  const sessions = new Map();
  let allowedHosts = [];
  const drop = id => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    session.server.close().catch(() => {});
  };
  const touch = (id, session) => {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => drop(id), idleMs).unref();
  };
  // A session being initialized counts towards the limit until it has an ID or fails.
  let starting = 0;

  async function handle(req, res) {
    if ((req.url ?? '').split('?')[0] !== '/mcp') return reply(res, 404, 'NOT_FOUND', 'Not found');
    // X-Forwarded-* headers are deliberately ignored: only the connection's own Host and Origin count.
    if (!allowedHosts.includes((req.headers.host ?? '').toLowerCase())) return reply(res, 403, 'FORBIDDEN_HOST', 'Host not allowed');
    if (req.headers.origin !== undefined && !allowOrigins.includes(req.headers.origin)) return reply(res, 403, 'FORBIDDEN_ORIGIN', 'Origin not allowed');
    if (!authorized(req.headers.authorization, token)) return reply(res, 401, 'UNAUTHORIZED', 'Bearer token required', { 'WWW-Authenticate': 'Bearer' });
    // No standalone server-to-client stream: clients treat 405 as "none offered".
    if (req.method === 'GET') return reply(res, 405, 'METHOD_NOT_ALLOWED', 'No standalone stream; use POST', { Allow: 'POST, DELETE' });
    if (req.method !== 'POST' && req.method !== 'DELETE') return reply(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { Allow: 'POST, DELETE' });
    const id = req.headers['mcp-session-id'];
    if (id !== undefined) {
      const session = typeof id === 'string' && sessions.get(id);
      if (!session) return reply(res, 404, 'SESSION_NOT_FOUND', 'Unknown or expired session');
      touch(id, session);
      return session.transport.handleRequest(req, res, req.method === 'POST' ? await readJson(req) : undefined);
    }
    if (req.method === 'DELETE') return reply(res, 400, 'INVALID_INPUT', 'Mcp-Session-Id header required');
    const body = await readJson(req);
    if (!isInitializeRequest(body)) return reply(res, 400, 'INVALID_INPUT', 'Mcp-Session-Id header required');
    if (sessions.size + starting >= maxSessions) return reply(res, 503, 'SESSION_LIMIT', `At most ${maxSessions} sessions are allowed; try again later`, { 'Retry-After': '30' });
    const server = create();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
      onsessioninitialized: sessionId => { const session = { server, transport }; sessions.set(sessionId, session); touch(sessionId, session); } });
    server.onclose = () => { if (transport.sessionId) drop(transport.sessionId); };
    starting++;
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      starting--;
      if (!transport.sessionId) await server.close().catch(() => {});
    }
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) return res.destroy();
      const status = { PAYLOAD_TOO_LARGE: 413, INVALID_INPUT: 400 }[error.code];
      if (status) reply(res, status, error.code, error.message);
      else reply(res, 500, 'INTERNAL', 'Internal error');
    });
  });
  await new Promise((resolve, reject) => {
    http.once('error', error => reject(Object.assign(error, { code: 'LISTEN_FAILED' })));
    http.listen(port, host, resolve);
  });
  const address = http.address();
  const display = address.address.includes(':') ? `[${address.address}]` : address.address;
  allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`, `${display}:${address.port}`, ...publicHosts];
  process.stderr.write(JSON.stringify({ listening: true, url: `http://${display}:${address.port}/mcp`, host: address.address, port: address.port }) + '\n');
  const stop = () => { http.close(); http.closeAllConnections(); for (const id of [...sessions.keys()]) drop(id); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(); process.exit(0); });
}
