import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-mcp-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  delete env.CONTEXT_KIT_ROOT;
  const workspace = join(base, 'workspace');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', workspace], { env });
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, ...args], { env })).stdout);
  const open = info => async (...flags) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, ...flags],
      env, cwd: base, stderr: 'pipe' });
    const client = new Client(info);
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  };
  const connect = Object.assign(open({ name: 'context-kit-test', version: '0.0.0' }), { as: open });
  return { base, workspace, cli, connect, hub: join(workspace, 'hubs/personal') };
}
const parse = result => JSON.parse(result.content[0].text);
const frontmatter = text => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n\n/);
  assert.ok(match, 'note starts with OKF frontmatter');
  return { data: parseYaml(match[1]), body: text.slice(match[0].length) };
};

// spec: agent-interface / Read-only server
test('default server is read-only and no tool accepts a root', async t => {
  const { connect, hub } = await fixture(t);
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('get_context') && names.includes('list_hubs'));
  assert.ok(!names.includes('capture_note'));
  for (const tool of tools) {
    assert.ok(!Object.keys(tool.inputSchema.properties ?? {}).some(key => /root/i.test(key)), tool.name);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  }
  const call = await client.callTool({ name: 'capture_note', arguments: { id: 'personal/main', title: 'x', body: 'y' } });
  assert.equal(call.isError, true);
  assert.equal(parse(call).error.code, 'WRITE_DISABLED');
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
  const rooted = await client.callTool({ name: 'list_hubs', arguments: { root: '/' } });
  assert.equal(rooted.isError, true);
  assert.equal(parse(rooted).error.code, 'INVALID_INPUT');
  assert.equal(parse(await client.callTool({ name: 'nope', arguments: {} })).error.code, 'UNKNOWN_OPERATION');
});

// spec: behavior-maps / No write tools over MCP
test('map tools over MCP are read-only, even with writes allowed', async t => {
  const { connect, workspace } = await fixture(t);
  await writeFile(join(workspace, 'context-kit.json'), JSON.stringify({ version: 1, addons: ['maps', 'reflect', 'review', 'specs'] }));
  const client = await connect('--allow-write');
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('capture_note'));
  for (const name of ['list_behaviors', 'list_maps', 'check_map', 'render_map']) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.annotations.readOnlyHint, true, name);
  }
  assert.ok(!names.some(name => /map/.test(name) && !['list_maps', 'check_map', 'render_map'].includes(name)), names.join(', '));
  const write = await client.callTool({ name: 'write_map_diagram', arguments: { map: 'alerts' } });
  assert.equal(parse(write).error.code, 'UNKNOWN_OPERATION');
});

// spec: context-workspaces / Captured note records its author
test('--allow-write exposes capture_note and captures are found via search', async t => {
  const { connect, workspace } = await fixture(t);
  const client = await connect('--allow-write');
  const { tools } = await client.listTools();
  const capture = tools.find(tool => tool.name === 'capture_note');
  assert.ok(capture);
  assert.equal(capture.annotations.readOnlyHint, false);
  assert.ok(!Object.keys(capture.inputSchema.properties).some(key => /root/i.test(key)));
  const result = await client.callTool({ name: 'capture_note', arguments: { id: 'personal/main', title: 'Agent finding', body: 'Quokka habitats.' } });
  assert.ok(!result.isError, result.content[0].text);
  assert.equal(result.structuredContent.status, 'unreviewed');
  const note = frontmatter(await readFile(join(workspace, result.structuredContent.path), 'utf8'));
  assert.equal(note.data.type, 'Note');
  assert.equal(note.data.status, 'draft');
  assert.equal(note.data.generated.by, 'context-kit-test/0.0.0');
  assert.equal(note.data.verified, undefined);
  assert.match(note.body, /^# Agent finding\n\nQuokka habitats\.\n$/);
  const found = await client.callTool({ name: 'search_context', arguments: { query: 'quokka', includeInbox: true } });
  assert.equal(found.structuredContent.results.length, 1);
  assert.equal((await client.callTool({ name: 'search_context', arguments: { query: 'quokka' } })).structuredContent.results.length, 0);
});

// spec: agent-interface / Equivalent context
test('CLI and MCP return equivalent context for the same workspace', async t => {
  const { connect, cli } = await fixture(t);
  const client = await connect();
  for (const includeInbox of [false, true]) {
    const mcp = await client.callTool({ name: 'get_context', arguments: { id: 'personal/main', includeInbox } });
    assert.ok(!mcp.isError);
    const expected = await cli('context', 'personal/main', ...(includeInbox ? ['--inbox'] : []));
    assert.deepEqual(mcp.structuredContent, expected);
    assert.deepEqual(parse(mcp), expected);
  }
  assert.deepEqual((await client.callTool({ name: 'list_hubs', arguments: {} })).structuredContent, await cli('list'));
  assert.deepEqual((await client.callTool({ name: 'read_skill', arguments: { id: 'personal/main', reference: 'kit:independent-review' } })).structuredContent,
    await cli('read-skill', 'personal/main', 'kit:independent-review'));
});

test('tool errors return coded isError payloads and keep the session usable', async t => {
  const { base, connect, hub } = await fixture(t);
  const client = await connect('--allow-write');
  const cases = [
    [{ name: 'get_context', arguments: { id: 'missing/hub' } }, 'UNKNOWN_HUB'],
    [{ name: 'search_context', arguments: { query: '' } }, 'INVALID_INPUT'],
    [{ name: 'read_skill', arguments: { id: 'personal/main', reference: '../../etc/SKILL.md' } }, 'UNKNOWN_SKILL'],
    [{ name: 'capture_note', arguments: { id: 'personal/main', title: 'two\nlines', body: 'x' } }, 'INVALID_INPUT'],
  ];
  for (const [call, code] of cases) {
    const result = await client.callTool(call);
    assert.equal(result.isError, true, call.name);
    assert.equal(parse(result).error.code, code, call.name);
  }
  const outside = join(base, 'outside');
  await mkdir(outside);
  await symlink(outside, join(hub, 'inbox'));
  const escaped = await client.callTool({ name: 'capture_note', arguments: { id: 'personal/main', title: 'Escape', body: 'secret' } });
  assert.equal(parse(escaped).error.code, 'PATH_ESCAPE');
  assert.deepEqual(await readdir(outside), []);
  assert.equal((await client.callTool({ name: 'list_hubs', arguments: {} })).structuredContent.hubs[0].id, 'personal/main');
});

test('server rejects unexpected startup arguments with a coded stderr error', async t => {
  const { workspace } = await fixture(t);
  const error = await exec(process.execPath, [join(kit, 'bin/mcp.mjs'), '--root', workspace, 'extra']).catch(error => error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, '');
  assert.equal(JSON.parse(error.stderr).error.code, 'INVALID_INPUT');
});

// spec: context-workspaces / Actor cannot be forged
test('an MCP client cannot claim a human or process actor', async t => {
  const { connect, workspace } = await fixture(t);
  const client = await connect.as({ name: 'human:alice', version: '1.0' })('--allow-write');
  const result = await client.callTool({ name: 'capture_note', arguments: { id: 'personal/main', title: 'Claim', body: 'Body.' } });
  assert.ok(!result.isError, result.content[0].text);
  const by = frontmatter(await readFile(join(workspace, result.structuredContent.path), 'utf8')).data.generated.by;
  assert.doesNotMatch(by, /^(?:human|process|team):/);
  assert.equal(by, 'human-alice/1.0');
});

