import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { request } from 'node:http';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, realpath, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { localOnlyOperations } from '../../lib/operations.mjs';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const token = 'remote-test-token-0123456789abcdef0123456789';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-remote-')));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  delete env.CONTEXT_KIT_ROOT;
  delete env.CONTEXT_KIT_MCP_TOKEN;
  const workspace = join(base, 'workspace');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', workspace], { env });
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : null));
    await exec('chmod', ['-R', 'u+w', base]).catch(() => {}); // Fetched mounts are read-only.
    await rm(base, { recursive: true, force: true });
  });
  // Starts bin/mcp.mjs --http and resolves with the URL from its first stderr line (secret null: no token set).
  const serve = async (flags = [], { secret = token } = {}) => {
    const child = spawn(process.execPath, [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--http', '0', ...flags],
      { env: { ...env, ...(secret === null ? {} : { CONTEXT_KIT_MCP_TOKEN: secret }) }, cwd: base, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = '';
    const line = await new Promise((resolve, reject) => {
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('\n')) resolve(stderr.split('\n')[0]); });
      child.once('exit', () => reject(new Error('server exited: ' + stderr)));
    });
    const { url, error } = JSON.parse(line);
    if (error) {
      const code = await new Promise(resolve => child.exitCode === null ? child.once('exit', resolve) : resolve(child.exitCode));
      throw Object.assign(new Error('server exited: ' + line), { exitCode: code });
    }
    return { url, port: new URL(url).port, line };
  };
  const stdio = async (...flags) => {
    const client = new Client({ name: 'context-kit-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, ...flags], env, cwd: base, stderr: 'pipe' }));
    t.after(() => client.close());
    return client;
  };
  const remote = async (url, info = { name: 'context-kit-test', version: '0.0.0' }, secret = token) => {
    const client = new Client(info);
    client.onerror = error => { throw error; };
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  };
  return { base, workspace, env, serve, stdio, remote, hub: join(workspace, 'hubs/personal') };
}
const parse = result => JSON.parse(result.content[0].text);
const frontmatter = text => parseYaml(text.match(/^---\n([\s\S]*?)\n---\n\n/)[1]);
const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const initialize = (name = 'raw-client') => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } });
// Raw HTTP, because fetch does not let a caller set Host.
function raw(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { Accept: 'application/json, text/event-stream', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
// Raw socket, for requests with repeated headers that http.request cannot send.
function socketRequest(port, headerLines, body) {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(['POST /mcp HTTP/1.1', ...headerLines, 'Accept: application/json, text/event-stream', 'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body].join('\r\n'));
    });
    let text = '';
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => resolve({ status: Number(text.slice(9, 12)), text }));
    socket.on('error', reject);
  });
}
const bearer = { Authorization: `Bearer ${token}` };
const toolCall = (name, args) => rpc('tools/call', { name, arguments: args }, 2);
// A copy of a stdio result as HTTP gives it: the named keys renamed with the servingMachine
// prefix in place, and machine first when any was there.
function labeled(result, keys, machine) {
  const entries = Object.entries(result).map(([key, value]) => keys.includes(key) ? [`servingMachine${key[0].toUpperCase()}${key.slice(1)}`, value] : [key, value]);
  return machine === undefined ? Object.fromEntries(entries) : { machine, ...Object.fromEntries(entries) };
}

// spec: remote-access / Same tools over HTTP
test('HTTP lists the same tools and returns the same context as stdio', async t => {
  const { serve, stdio, remote } = await fixture(t);
  const { url } = await serve();
  const [http, local] = [await remote(url), await stdio()];
  // The same tools apart from the local-only ones, which only stdio lists.
  const localTools = (await local.listTools()).tools;
  assert.ok(localTools.some(tool => tool.name === 'which_repo'));
  // Descriptions match too, except where a tool's says its paths are the serving machine's.
  const httpTools = (await http.listTools()).tools;
  const withoutDescription = ({ description, ...tool }) => tool;
  assert.deepEqual(httpTools.map(withoutDescription), localTools.filter(tool => !localOnlyOperations().includes(tool.name)).map(withoutDescription));
  for (const tool of httpTools) if (tool.name !== 'list_repos') assert.equal(tool.description, localTools.find(item => item.name === tool.name).description, tool.name);
  // Equivalent results: the same, with the workspace root labeled as the serving machine's.
  const call = client => client.callTool({ name: 'get_context', arguments: { id: 'personal/main' } });
  const [overHttp, overStdio] = [await call(http), await call(local)];
  assert.ok(!overHttp.isError);
  assert.deepEqual(overHttp.structuredContent, labeled(overStdio.structuredContent, ['root'], hostname()));
  assert.deepEqual(parse(overHttp), overHttp.structuredContent);
});

// spec: remote-access / Local-only tools stay local
test('which_repo is listed over stdio, not over HTTP, and an HTTP call to it is unknown and runs nothing', async t => {
  const { base, workspace, serve, stdio, remote } = await fixture(t);
  const { url, port } = await serve();
  const [http, local] = [await remote(url), await stdio()];
  assert.ok((await local.listTools()).tools.some(tool => tool.name === 'which_repo'));
  assert.ok(!(await http.listTools()).tools.some(tool => tool.name === 'which_repo'));
  // Over stdio it runs; over HTTP the same call, and calls that would fail its validation or
  // its lookup if it ran, are all unknown.
  assert.ok(!(await local.callTool({ name: 'which_repo', arguments: { path: workspace } })).isError);
  for (const args of [{ path: workspace }, { path: 'relative' }, { path: join(base, 'missing') }, {}]) {
    const called = await http.callTool({ name: 'which_repo', arguments: args });
    assert.equal(called.isError, true);
    assert.equal(parse(called).error.code, 'UNKNOWN_OPERATION', JSON.stringify(args));
    assert.equal(called.structuredContent, undefined);
  }
  // A raw tools/call in a raw session, as a client that never listed tools would send.
  const init = await raw(url, { headers: { ...bearer, Host: `127.0.0.1:${port}` }, body: initialize() });
  const session = init.headers['mcp-session-id'];
  const called = await raw(url, { headers: { ...bearer, Host: `127.0.0.1:${port}`, 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-06-18' },
    body: toolCall('which_repo', { path: workspace }) });
  const { result } = called.json();
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, 'UNKNOWN_OPERATION');
});

// spec: remote-access / Every local-only tool is withheld
test('no operation the core declares local-only is listed or callable over HTTP, whatever the options', async t => {
  const { workspace, serve, stdio, remote } = await fixture(t);
  const declared = localOnlyOperations();
  assert.ok(declared.includes('which_repo'));
  // Every addon group enabled and writes allowed, so nothing else keeps a tool off the list.
  await writeFile(join(workspace, 'context-kit.json'), JSON.stringify({ version: 1, addons: ['maps', 'reflect', 'review', 'specs'] }));
  const { url } = await serve(['--allow-write']);
  const [http, local] = [await remote(url), await stdio('--allow-write')];
  const offered = (await http.listTools()).tools.map(tool => tool.name);
  const stdioOffered = (await local.listTools()).tools.map(tool => tool.name);
  for (const name of declared) {
    assert.ok(!offered.includes(name), name);
    assert.ok(stdioOffered.includes(name), name);
    assert.equal(parse(await http.callTool({ name, arguments: {} })).error.code, 'UNKNOWN_OPERATION', name);
  }
  assert.deepEqual(offered, stdioOffered.filter(name => !declared.includes(name)));
});

// spec: remote-access / Same prompts over HTTP
test('HTTP offers the same skill prompts as stdio', async t => {
  const { serve, stdio, remote } = await fixture(t);
  const { url } = await serve();
  const [http, local] = [await remote(url), await stdio()];
  const { prompts } = await http.listPrompts();
  assert.ok(prompts.length > 0);
  assert.deepEqual(prompts, (await local.listPrompts()).prompts);
  assert.deepEqual(await http.getPrompt({ name: prompts[0].name }), await local.getPrompt({ name: prompts[0].name }));
});

// spec: remote-access / Same coded errors over HTTP
test('a missing hub is the same coded tool error over HTTP and stdio', async t => {
  const { serve, stdio, remote } = await fixture(t);
  const { url } = await serve();
  const [http, local] = [await remote(url), await stdio()];
  const call = client => client.callTool({ name: 'get_context', arguments: { id: 'missing/hub' } });
  const [overHttp, overStdio] = [await call(http), await call(local)];
  assert.equal(overHttp.isError, true);
  assert.equal(overStdio.isError, true);
  assert.equal(parse(overHttp).error.code, 'UNKNOWN_HUB');
  assert.deepEqual(parse(overHttp), parse(overStdio));
});

// spec: remote-access / No standalone stream
test('GET /mcp is 405 and an SDK client still works', async t => {
  const { serve, remote } = await fixture(t);
  const { url } = await serve();
  const get = await raw(url, { method: 'GET', headers: bearer });
  assert.equal(get.status, 405);
  assert.equal(get.json().error.code, 'METHOD_NOT_ALLOWED');
  const errors = [];
  const client = await remote(url);
  client.onerror = error => errors.push(error);
  assert.ok((await client.listTools()).tools.length > 0);
  assert.ok(!(await client.callTool({ name: 'list_hubs', arguments: {} })).isError);
  await sleep(200);
  assert.deepEqual(errors, []);
});

// spec: remote-access / Read-only by default over HTTP
test('capture is absent over HTTP without --allow-write', async t => {
  const { serve, remote, hub } = await fixture(t);
  const client = await remote((await serve()).url);
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'capture_note'));
  const call = await client.callTool({ name: 'capture_note', arguments: { id: 'personal/main', title: 'x', body: 'y' } });
  assert.equal(parse(call).error.code, 'WRITE_DISABLED');
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
});

// spec: remote-access / Default address
test('the server listens on loopback unless told otherwise', async t => {
  const { serve } = await fixture(t);
  const { url, line } = await serve();
  assert.match(url, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/mcp$/);
  assert.deepEqual(Object.keys(JSON.parse(line)), ['listening', 'url', 'host', 'port']);
  assert.equal(JSON.parse(line).host, '127.0.0.1');
});

// spec: remote-access / Two clients capture
test('each capture over HTTP is attributed to the client that captured it', async t => {
  const { serve, remote, workspace } = await fixture(t);
  const { url } = await serve(['--allow-write']);
  const first = await remote(url, { name: 'alpha-agent', version: '1.2.3' });
  const second = await remote(url, { name: 'beta-agent', version: '4.5.6' });
  const capture = async (client, title) => {
    const result = await client.callTool({ name: 'capture_note', arguments: { id: 'personal/main', title, body: 'Body.' } });
    assert.ok(!result.isError, result.content[0].text);
    return frontmatter(await readFile(join(workspace, result.structuredContent.path), 'utf8')).generated.by;
  };
  // Interleaved on purpose: attribution follows the session, not the latest initialize.
  assert.equal(await capture(first, 'From alpha'), 'alpha-agent/1.2.3');
  assert.equal(await capture(second, 'From beta'), 'beta-agent/4.5.6');
  assert.equal(await capture(first, 'Alpha again'), 'alpha-agent/1.2.3');
});

// spec: remote-access / Ended session
test('a deleted session is gone and runs nothing', async t => {
  const { serve, remote, hub } = await fixture(t);
  const { url } = await serve(['--allow-write']);
  const client = await remote(url);
  const id = client.transport.sessionId;
  assert.ok(id);
  await client.transport.terminateSession();
  const headers = { ...bearer, 'Mcp-Session-Id': id, 'Mcp-Protocol-Version': '2025-06-18' };
  const after = await raw(url, { headers, body: toolCall('capture_note', { id: 'personal/main', title: 'After delete', body: 'Body.' }) });
  assert.equal(after.status, 404);
  assert.equal(after.json().error.code, 'SESSION_NOT_FOUND');
  const again = await raw(url, { method: 'DELETE', headers: { ...bearer, 'Mcp-Session-Id': id } });
  assert.equal(again.status, 404);
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
});

// spec: remote-access / Ended session
test('a session expires after inactivity, not age, and runs nothing once expired', async t => {
  const { serve, hub } = await fixture(t);
  const { url } = await serve(['--allow-write', '--session-idle', '1']);
  const opened = await raw(url, { headers: bearer, body: initialize() });
  assert.equal(opened.status, 200);
  const headers = { ...bearer, 'Mcp-Session-Id': opened.headers['mcp-session-id'], 'Mcp-Protocol-Version': '2025-06-18' };
  // Requests inside the idle window keep the session alive well past its first deadline (1 s after opening).
  for (let i = 0; i < 4; i++) {
    await sleep(600);
    assert.equal((await raw(url, { headers, body: rpc('tools/list', {}) })).status, 200, `request ${i}`);
  }
  await sleep(1600);
  const after = await raw(url, { headers, body: toolCall('capture_note', { id: 'personal/main', title: 'After expiry', body: 'Body.' }) });
  assert.equal(after.status, 404);
  assert.equal(after.json().error.code, 'SESSION_NOT_FOUND');
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
});

// spec: remote-access / Session limit
test('sessions beyond --max-sessions get 503 and existing ones keep working', async t => {
  const { serve, remote } = await fixture(t);
  const { url } = await serve(['--max-sessions', '1']);
  const first = await remote(url);
  const second = await raw(url, { headers: bearer, body: initialize('second') });
  assert.equal(second.status, 503);
  assert.equal(second.json().error.code, 'SESSION_LIMIT');
  assert.ok(!(await first.callTool({ name: 'list_hubs', arguments: {} })).isError);
  // Ending the first session frees the slot.
  await first.transport.terminateSession();
  assert.equal((await raw(url, { headers: bearer, body: initialize('third') })).status, 200);
});

// spec: remote-access / Session limit
test('a malformed initialize allocates no session and leaves capacity', async t => {
  const { serve } = await fixture(t);
  const { url } = await serve(['--max-sessions', '1']);
  const params = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bad', version: '1.0' } };
  const malformed = [JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params }),
    JSON.stringify({ jsonrpc: '2.0', id: null, method: 'initialize', params }),
    JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'initialize', params }),
    JSON.stringify({ id: 1, method: 'initialize', params }),
    JSON.stringify([JSON.parse(initialize())]),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    '{"jsonrpc"'];
  for (const body of malformed) {
    const response = await raw(url, { headers: bearer, body });
    assert.equal(response.status, 400, body);
    assert.equal(response.json().error.code, 'INVALID_INPUT');
    assert.equal(response.headers['mcp-session-id'], undefined);
  }
  // The single slot is still free, and then taken.
  assert.equal((await raw(url, { headers: bearer, body: initialize('good') })).status, 200);
  assert.equal((await raw(url, { headers: bearer, body: initialize('over') })).status, 503);
});

// spec: remote-access / Start without a token
test('HTTP mode refuses to start without a long enough token', async t => {
  const { serve } = await fixture(t);
  for (const secret of [null, '', 'a'.repeat(31)]) {
    const error = await serve([], { secret }).then(() => assert.fail('should not listen'), error => error);
    assert.equal(error.exitCode, 1);
    const parsed = JSON.parse(error.message.slice('server exited: '.length));
    assert.equal(parsed.error.code, 'TOKEN_REQUIRED');
    assert.match(parsed.error.message, /CONTEXT_KIT_MCP_TOKEN/);
    assert.ok(!('listening' in parsed));
  }
  // The token is read only from the environment.
  const { env, workspace } = await fixture(t);
  const flagged = await exec(process.execPath, [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--http', '0', '--token', token], { env }).catch(error => error);
  assert.equal(flagged.code, 1);
  assert.equal(JSON.parse(flagged.stderr).error.code, 'INVALID_INPUT');
  // Numeric options must be safe integers, and --session-idle must fit a timer (2147483 s at most).
  const bad = [['--http', '65536'], ['--max-sessions', '0'], ['--max-sessions', '9007199254740993'], ['--max-sessions', '1e3'],
    ['--session-idle', '0'], ['--session-idle', '2147484'], ['--session-idle', '99999999999999999999']];
  for (const flags of bad) {
    const refused = await exec(process.execPath, [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--http', '0', ...flags],
      { env: { ...env, CONTEXT_KIT_MCP_TOKEN: token } }).catch(error => error);
    assert.equal(refused.code, 1, flags.join(' '));
    assert.equal(JSON.parse(refused.stderr).error.code, 'INVALID_INPUT', flags.join(' '));
  }
  assert.equal((await serve(['--session-idle', '2147483'])).line.includes('listening'), true);
});

// spec: remote-access / Missing or wrong token
test('requests without the bearer token get 401 and run nothing', async t => {
  const { serve, remote, hub } = await fixture(t);
  const { url } = await serve(['--allow-write']);
  const id = (await remote(url)).transport.sessionId;
  const capture = toolCall('capture_note', { id: 'personal/main', title: 'Sneaky', body: 'Body.' });
  const attempts = [{}, { Authorization: 'Bearer ' + 'x'.repeat(token.length) }, { Authorization: `Bearer ${token.slice(1)}` },
    { Authorization: `Basic ${token}` }, { Authorization: token }];
  for (const headers of attempts) {
    for (const body of [initialize(), capture]) {
      const response = await raw(url, { headers: { ...headers, 'Mcp-Session-Id': id }, body });
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal(response.json().error.code, 'UNAUTHORIZED');
      assert.ok(!response.text.includes(token));
    }
  }
  assert.equal((await raw(url, { method: 'GET' })).status, 401);
  assert.equal((await raw(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': id } })).status, 401);
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
  await assert.rejects(remote(url, undefined, 'y'.repeat(token.length)), /401|Unauthorized/i);
});

// spec: remote-access / Correct token
test('the correct bearer token lists and calls tools', async t => {
  const { serve, remote } = await fixture(t);
  const client = await remote((await serve()).url);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'get_context'));
  const result = await client.callTool({ name: 'list_hubs', arguments: {} });
  assert.equal(result.structuredContent.hubs[0].id, 'personal/main');
});

// spec: remote-access / Rebinding host
test('a foreign Host header gets 403 before the token is checked and runs nothing', async t => {
  const { serve, remote, hub } = await fixture(t);
  const { url } = await serve(['--allow-write']);
  const id = (await remote(url)).transport.sessionId;
  const capture = toolCall('capture_note', { id: 'personal/main', title: 'Rebound', body: 'Body.' });
  for (const host of ['attacker.example', 'attacker.example:80', 'localhost', '127.0.0.1']) {
    const response = await raw(url, { headers: { ...bearer, Host: host, 'Mcp-Session-Id': id }, body: capture });
    assert.equal(response.status, 403, host);
    assert.equal(response.json().error.code, 'FORBIDDEN_HOST');
  }
  // Forwarded headers do not make a host acceptable, and the Host check precedes the token check.
  const forwarded = await raw(url, { headers: { Host: 'attacker.example', 'X-Forwarded-Host': `127.0.0.1:${new URL(url).port}` }, body: initialize() });
  assert.equal(forwarded.status, 403);
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
});

// spec: remote-access / Rebinding host
test('a request with more than one Host header gets 403 in either order and runs nothing', async t => {
  const { serve, remote, hub } = await fixture(t);
  const { url, port } = await serve(['--allow-write']);
  const id = (await remote(url)).transport.sessionId;
  const good = `Host: 127.0.0.1:${port}`;
  const auth = `Authorization: Bearer ${token}`;
  for (const hosts of [[good, 'Host: attacker.example'], ['Host: attacker.example', good], [good, good]]) {
    for (const body of [initialize(), toolCall('capture_note', { id: 'personal/main', title: 'Doubled', body: 'Body.' })]) {
      const response = await socketRequest(port, [...hosts, auth, `Mcp-Session-Id: ${id}`], body);
      assert.equal(response.status, 403, hosts.join(' / '));
      assert.match(response.text, /FORBIDDEN_HOST/);
    }
  }
  // A single correct Host over the same raw path is still accepted.
  assert.equal((await socketRequest(port, [good, auth], initialize())).status, 200);
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
});

// spec: remote-access / Browser origin
test('a request with an unlisted Origin gets 403 and runs nothing', async t => {
  const { serve, remote, hub } = await fixture(t);
  const { url } = await serve(['--allow-write', '--allow-origin', 'https://app.example']);
  const id = (await remote(url)).transport.sessionId;
  const capture = toolCall('capture_note', { id: 'personal/main', title: 'Cross-site', body: 'Body.' });
  for (const origin of ['https://attacker.example', 'null', 'https://app.example.attacker.example']) {
    const response = await raw(url, { headers: { ...bearer, Origin: origin, 'Mcp-Session-Id': id }, body: capture });
    assert.equal(response.status, 403, origin);
    assert.equal(response.json().error.code, 'FORBIDDEN_ORIGIN');
  }
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
  // Only origins given with --allow-origin pass.
  const allowed = await raw(url, { headers: { ...bearer, Origin: 'https://app.example' }, body: initialize() });
  assert.equal(allowed.status, 200);
});

// spec: remote-access / Public host
test('a --public-host is accepted as the Host header', async t => {
  const { serve } = await fixture(t);
  const { url } = await serve(['--public-host', 'origin.example.com']);
  const headers = { ...bearer, Host: 'origin.example.com' };
  const opened = await raw(url, { headers, body: initialize() });
  assert.equal(opened.status, 200);
  const session = { ...headers, 'Mcp-Session-Id': opened.headers['mcp-session-id'], 'Mcp-Protocol-Version': '2025-06-18' };
  const listed = await raw(url, { headers: session, body: rpc('tools/list', {}) });
  assert.equal(listed.status, 200);
  assert.ok(listed.json().result.tools.some(tool => tool.name === 'get_context'));
  const called = await raw(url, { headers: session, body: toolCall('list_hubs', {}) });
  assert.equal(called.json().result.structuredContent.hubs[0].id, 'personal/main');
  assert.equal((await raw(url, { headers: { ...bearer, Host: 'other.example.com' }, body: initialize() })).status, 403);
});

// spec: hub-federation / Remote client reads a mount
test('an authorized HTTP client reads a mounted hub exactly as a stdio client does', async t => {
  const { base, workspace, env, serve, stdio, remote } = await fixture(t);
  // A hub in another local git repository, mounted as shared (no network, no user git config).
  const gitEnv = { ...env, HOME: join(base, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const source = join(base, 'shared-context');
  await mkdir(join(source, 'tables'), { recursive: true });
  await writeFile(join(source, 'hub.json'), JSON.stringify({ version: 1, id: 'team/data', description: 'Data.', documents: ['README.md'], skills: [], links: [] }));
  await writeFile(join(source, 'README.md'), '---\ntype: Guide\n---\n\n# Data\n');
  await writeFile(join(source, 'tables/orders.md'), '---\ntype: Table\ntitle: Orders\n---\n\n# Orders\n\nOne row per heron order.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'first']]) await exec('git', args, { cwd: source, env: gitEnv });
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source, env: gitEnv })).stdout.trim();
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, 'mounts', 'add', 'shared', `file://${source}`], { env: gitEnv });
  const mount = { name: 'shared', source: `file://${source}`, path: '', commit };
  // Over HTTP the file: source is a path on the serving machine, labeled as such.
  const remoteMount = labeled(mount, ['source']);

  const { url } = await serve();
  const [http, local] = [await remote(url), await stdio()];
  for (const [name, args] of [['list_hubs', {}], ['read_concept', { concept: 'shared:/tables/orders' }], ['search_context', { query: 'heron order' }]]) {
    const [overHttp, overStdio] = [await http.callTool({ name, arguments: args }), await local.callTool({ name, arguments: args })];
    assert.ok(!overHttp.isError, JSON.stringify(overHttp.content));
    const here = overStdio.structuredContent;
    const result = overHttp.structuredContent;
    assert.equal(result.machine, hostname());
    assert.deepEqual(parse(overHttp), result);
    if (name === 'list_hubs') {
      assert.deepEqual(here.hubs.find(hub => hub.id === 'shared'), { id: 'shared', description: 'Data.', manifestId: 'team/data', mount });
      assert.deepEqual(result.hubs.find(hub => hub.id === 'shared'), { id: 'shared', description: 'Data.', manifestId: 'team/data', mount: remoteMount });
    }
    if (name === 'read_concept') {
      assert.deepEqual([here.hub, here.ref, here.mount, here.okf.trust], ['shared', 'shared:/tables/orders', mount, 'unverified']);
      assert.deepEqual(result, labeled({ ...here, mount: remoteMount }, ['root'], hostname()));
    }
    if (name === 'search_context') {
      assert.deepEqual(here.results.map(({ hub, ref, mount: provenance }) => ({ hub, ref, mount: provenance })), [{ hub: 'shared', ref: 'shared:/tables/orders', mount }]);
      assert.deepEqual(result.results.map(({ hub, ref, mount: provenance }) => ({ hub, ref, mount: provenance })), [{ hub: 'shared', ref: 'shared:/tables/orders', mount: remoteMount }]);
    }
  }
});

// A workspace with every kind of local path a result can carry, all under the fixture's
// temporary directory: located repositories, a mounted hub from a file: source, a capture, the
// workspace's own OpenSpec specs and a sliced change, a map, and a hub declaring a shared store
// which the workspace repository also references. The store's parties are recorded: site is
// fetched, game's checkout lost its remote and kiosk's was never fetched, so their remedies quote
// checkouts. Agents are installed for Codex in the temporary HOME, and the installed my-repos was
// then replaced, so a skill refresh reports a reason naming its directory. Git and gh are
// isolated: PATH holds only git and a stand-in codex, so nothing reaches a network.
async function pathsWorkspace({ base, workspace, env }) {
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  // A stand-in Codex CLI that accepts MCP registrations.
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nprocess.exit(process.argv[2] === 'mcp' && process.argv[3] === 'get' ? 1 : 0);\n`, { mode: 0o755 });
  Object.assign(env, { PATH: bin, HOME: join(base, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  await mkdir(env.HOME);
  const put = async (root, path, content) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); };
  const git = (cwd, ...args) => exec('git', args, { cwd, env });
  const hub = (...args) => exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, ...args], { env });
  const commitAll = async root => { await git(root, 'init', '-q', '-b', 'main'); await git(root, 'add', '-A'); await git(root, 'commit', '-qm', 'start'); };
  await writeFile(join(workspace, 'context-kit.json'), JSON.stringify({ version: 1, addons: ['maps', 'reflect', 'review', 'specs'] }));
  await put(workspace, 'hubs/personal/room.md', '---\ntype: Repository\ntitle: room\nresource: https://github.com/me/room\n---\n\n# room\n');
  const room = join(base, 'code/room');
  await mkdir(room, { recursive: true });
  await git(room, 'init', '-q');
  await git(room, 'remote', 'add', 'origin', 'https://github.com/me/room');
  await hub('repos', 'locate', 'room', room);
  // The workspace repository's specs, a map over them and a sliced change.
  const pigeon = join(kit, 'test/e2e/fixtures/maps/pigeon');
  await cp(join(pigeon, 'openspec'), join(workspace, 'openspec'), { recursive: true });
  await cp(join(pigeon, 'maps'), join(workspace, 'maps'), { recursive: true });
  const requirement = (name, text) => `## ADDED Requirements\n### Requirement: ${name}\n${text}\n\n#### Scenario: ${name} works\n- **WHEN** it is used\n- **THEN** it works\n`;
  await put(workspace, 'openspec/config.yaml', 'schema: spec-driven\nreferences:\n  - shared\n');
  await put(workspace, 'openspec/changes/quiet/proposal.md', '# Why\n\nQuiet hours.\n');
  await put(workspace, 'openspec/changes/quiet/specs/alerts/spec.md', requirement('Quiet hours', 'The app SHALL hold alerts during quiet hours.'));
  await put(workspace, 'openspec/changes/quiet/tasks.md', '- [ ] 1.1 Build\n');
  await put(workspace, 'openspec/changes/quiet/slices.yaml', 'slices:\n  - id: hold\n    implements: [alerts / Quiet hours]\n');
  // A team hub declaring store shared, planned in its party site, whose checkout is recorded.
  await put(workspace, 'hubs/team/README.md', '---\ntype: Guide\n---\n\nTeam\n');
  await put(workspace, 'hubs/team/hub.json', JSON.stringify({ version: 1, id: 'team/shared', description: 'Team', documents: ['README.md'], skills: [], links: [], specStores: ['shared'] }));
  for (const party of ['site', 'game', 'kiosk']) await put(workspace, `hubs/team/${party}.md`, `---\ntype: Repository\ntitle: ${party}\nresource: https://github.com/example/${party}\n---\n\n# ${party}\n`);
  const store = join(base, 'store');
  await put(store, 'openspec/config.yaml', 'schema: spec-driven\n');
  await cp(join(pigeon, 'openspec/specs'), join(store, 'openspec/specs'), { recursive: true });
  await put(store, 'openspec/parties.yaml', 'parties:\n  site: https://github.com/example/site\n  game: https://github.com/example/game\n  kiosk: https://github.com/example/kiosk\n');
  await put(store, 'openspec/changes/embed/proposal.md', '# Why\n\nEmbed.\n');
  await put(store, 'openspec/changes/embed/specs/alerts/spec.md', requirement('Embed', 'The site SHALL embed alerts.'));
  await put(store, 'openspec/changes/embed/slices.yaml', 'slices:\n  - id: host\n    repo: site\n    implements: [alerts / Embed]\n' +
    '  - id: guest\n    repo: game\n    implements: [alerts / Embed]\n  - id: screen\n    repo: kiosk\n    implements: [alerts / Embed]\n');
  await put(store, 'openspec/changes/embed/tasks.md', '- [x] 1.1 Embed\n');
  await commitAll(store);
  await exec(process.execPath, [join(kit, 'node_modules/@fission-ai/openspec/bin/openspec.js'), 'store', 'register', store, '--id', 'shared', '--yes', '--json'], { env });
  const site = join(base, 'code/site');
  await mkdir(site, { recursive: true });
  await git(site, 'init', '-q', '-b', 'main');
  await git(site, 'commit', '-q', '--allow-empty', '-m', 'start');
  await git(site, 'remote', 'add', 'origin', 'https://github.com/example/site');
  await git(site, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(site, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await hub('repos', 'locate', 'site', site);
  // game: recorded, then its remote for the upstream removed; kiosk: a remote never fetched.
  for (const party of ['game', 'kiosk']) {
    const checkout = join(base, `code/${party}`);
    await mkdir(checkout, { recursive: true });
    await git(checkout, 'init', '-q', '-b', 'main');
    await git(checkout, 'remote', 'add', 'origin', `https://github.com/example/${party}`);
    await hub('repos', 'locate', party, checkout);
  }
  await git(join(base, 'code/game'), 'remote', 'remove', 'origin');
  // A hub mounted from a local git repository.
  const mounted = join(base, 'mounted');
  await put(mounted, 'hub.json', JSON.stringify({ version: 1, id: 'other/hub', description: 'Other', documents: ['README.md'], skills: [], links: [] }));
  await put(mounted, 'README.md', '---\ntype: Guide\n---\n\n# Other\n\nHerons gather here.\n');
  await commitAll(mounted);
  await hub('mounts', 'add', 'other', `file://${mounted}`);
  // A captured note (body on stdin), so inbox reads have one.
  await new Promise((done, failed) => {
    const child = execFile(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, 'capture', 'personal/main', 'A note', '--by', 'human:test'], { env }, error => error ? failed(error) : done());
    child.stdin.end('Captured before the sweep.\n');
  });
  // Agents installed for Codex, then the installed my-repos replaced by a copy of the user's.
  await hub('agents', 'install', '--agent', 'codex');
  const installed = join(env.HOME, '.agents/skills/my-repos');
  await rm(installed, { recursive: true, force: true });
  await put(installed, 'SKILL.md', '---\nname: my-repos\ndescription: Mine.\n---\n\nMine.\n');
  await commitAll(workspace);
  return { room: await realpath(room) };
}
// Valid arguments for every tool the HTTP server may list; each set is one call. A tool listed
// over HTTP that is missing here fails the sweep, so a new tool is swept as soon as it is added.
const sweepCalls = {
  help: [{}, { topic: 'remote' }], list_hubs: [{}], list_addons: [{}], list_repos: [{}], list_skills: [{}], validate_hubs: [{}], list_mounts: [{}], list_spec_stores: [{}],
  get_context: [{ id: 'personal/main', includeInbox: true }, { id: 'other' }], search_context: [{ query: 'room' }, { query: 'herons' }],
  browse_hub: [{ id: 'personal/main' }, { id: 'other' }], read_concept: [{ id: 'personal/main', concept: 'room' }, { concept: 'other:/README' }],
  read_skill: [{ id: 'personal/main', reference: 'kit:context-kit' }],
  capture_note: [{ id: 'personal/main', title: 'Swept', body: 'A note.' }], add_repo: [{ id: 'personal/main', upstream: 'https://github.com/me/garden' }],
  list_specs: [{}, { store: 'shared' }], read_spec: [{ id: 'alerts' }, { id: 'alerts', store: 'shared' }], list_parties: [{ store: 'shared' }],
  garden_specs: [{}, { store: 'shared' }], audit_specs: [{}, { store: 'shared' }], archivable_changes: [{}, { store: 'shared' }],
  change_status: [{ change: 'quiet' }, { change: 'embed', store: 'shared' }], next_slices: [{ change: 'quiet' }, { change: 'embed', store: 'shared' }],
  read_slice: [{ change: 'quiet', slice: 'hold' }, { change: 'embed', slice: 'host', store: 'shared' }],
  reconcile_change: [{ change: 'quiet' }, { change: 'embed', store: 'shared' }],
  list_behaviors: [{ source: 'openspec' }], list_maps: [{}], check_map: [{}, { map: 'alerts' }], render_map: [{ map: 'alerts' }],
};

// spec: remote-access / Remote client sees whose paths they are
test('over HTTP list_repos names the serving machine and gives servingMachinePath, never path', async t => {
  const context = await fixture(t);
  const { room } = await pathsWorkspace(context);
  const { url } = await context.serve(['--machine-name', 'studio']);
  const http = await context.remote(url);
  const tool = (await http.listTools()).tools.find(item => item.name === 'list_repos');
  assert.match(tool.description, /servingMachinePath/);
  assert.match(tool.description, /serving machine/);
  const listed = await http.callTool({ name: 'list_repos', arguments: {} });
  assert.deepEqual(parse(listed), listed.structuredContent);
  const result = listed.structuredContent;
  assert.equal(result.machine, 'studio');
  assert.equal(result.servingMachineRoot, context.workspace);
  assert.equal(result.root, undefined);
  const repository = result.repositories.find(item => item.id === 'personal/main/room');
  assert.equal(repository.servingMachinePath, room);
  assert.ok(!('path' in repository));
  assert.ok(result.repositories.every(item => !('path' in item) && 'servingMachinePath' in item));
  // --machine-name needs --http and a usable name.
  await assert.rejects(context.serve(['--machine-name', '']), /machine-name/);
  // Nor one with control, format (bidi override, zero-width) or separator characters.
  for (const name of ['stu\u0085dio', 'stu\u202edio', 'stu\u200bdio', 'stu\u2028dio', 'stu\u2029dio', 'stu\u0007dio', 'x'.repeat(101)]) {
    await assert.rejects(context.serve(['--machine-name', name]), /machine-name must be/, JSON.stringify(name));
  }
});

// spec: remote-access / Remote client sees no unlabelled paths
test('every tool listed over HTTP, called with valid arguments, returns no fixture path outside a servingMachine field', async t => {
  const context = await fixture(t);
  const raw = context.base.replace(/^\/private(?=\/)/, '');
  await pathsWorkspace(context);
  const { url } = await context.serve(['--machine-name', 'studio', '--allow-write']);
  const http = await context.remote(url);
  const listed = (await http.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(listed.filter(name => !sweepCalls[name]), [], 'every tool listed over HTTP has arguments in the sweep');
  const leaks = [];
  let labeledResults = 0;
  // Every string under the fixture's directory must sit in a servingMachine-prefixed field (or
  // below one); a result with such a field names the machine.
  const walk = (value, trail, inside, call) => {
    if (typeof value === 'string') { if (!inside && (value.includes(context.base) || value.includes(raw))) leaks.push(`${call} ${trail.join('.')}: ${value}`); return false; }
    if (!value || typeof value !== 'object') return false;
    let found = false;
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(context.base) || key.includes(raw)) leaks.push(`${call} ${trail.join('.')} key ${key}`);
      const labeledField = key.startsWith('servingMachine');
      found = walk(item, [...trail, Array.isArray(value) ? '*' : key], inside || labeledField, call) || labeledField || found;
    }
    return found;
  };
  for (const name of listed) {
    for (const args of sweepCalls[name]) {
      const call = `${name} ${JSON.stringify(args)}`;
      const result = await http.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${call}: ${result.content[0].text}`);
      // Both representations: the structured result and the text a client may read instead.
      assert.deepEqual(parse(result), result.structuredContent, call);
      if (walk(result.structuredContent, [], false, call)) {
        labeledResults++;
        assert.equal(result.structuredContent.machine, 'studio', call);
      }
    }
  }
  assert.deepEqual(leaks, []);
  assert.ok(labeledResults > listed.length / 2, `${labeledResults} labeled results`);
  // The degraded parties' remedies and the replaced skill's reason name placeholders instead.
  const status = (await http.callTool({ name: 'change_status', arguments: { change: 'embed', store: 'shared' } })).structuredContent;
  const remedies = Object.fromEntries(status.slices.map(slice => [slice.id, slice.remedies]));
  assert.deepEqual(remedies.guest, ['git -C <servingMachineCheckout> remote add <remote> https://github.com/example/game', 'git -C <servingMachineCheckout> fetch <remote>']);
  assert.deepEqual(remedies.screen, ['git -C <servingMachineCheckout> fetch origin']);
  const archivable = (await http.callTool({ name: 'archivable_changes', arguments: { store: 'shared' } })).structuredContent;
  assert.match(JSON.stringify(archivable), /git -C <servingMachineCheckout> fetch origin/);
  const added = (await http.callTool({ name: 'add_repo', arguments: { id: 'personal/main', upstream: 'https://github.com/me/orchard' } })).structuredContent;
  const replaced = added.skills.find(item => item.name === 'my-repos');
  assert.equal(replaced.code, 'SKILL_REPLACED', JSON.stringify(added.skills));
  assert.equal(replaced.servingMachinePath, join(context.env.HOME, '.agents/skills/my-repos'));
  assert.match(replaced.reason, /^<servingMachinePath> was replaced since install/);
});
