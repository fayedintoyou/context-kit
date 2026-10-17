import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = fileURLToPath(new URL('../../', import.meta.url));
const openspec = join(kit, 'node_modules/@fission-ai/openspec/bin/openspec.js');
const requirement = name => `### Requirement: ${name}\nThe service SHALL support ${name.toLowerCase()} for location callers.\n\n#### Scenario: Use ${name}\n- **WHEN** a caller uses ${name.toLowerCase()}\n- **THEN** it works\n`;
async function put(root, path, content) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}
async function hashes(root, path = '', result = {}) {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) await hashes(root, file, result);
    else result[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  }
  return result;
}
// PATH holds only git, so a real gh never reaches GitHub from slice status.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-archival-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  const env = { ...process.env, PATH: bin, HOME: base, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CONTEXT_KIT_ROOT;
  await put(root, 'openspec/config.yaml', 'schema: spec-driven\n');
  await put(root, 'openspec/specs/locations/spec.md', `# Locations\n\n## Purpose\nFind locations by text, radius and filters for callers of the location service.\n\n## Requirements\n\n${requirement('Search')}`);
  const git = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env });
  await git('init', '-q', '-b', 'main');
  const change = async (name, tasks, extra = {}) => {
    await exec(process.execPath, [openspec, 'new', 'change', name], { cwd: root, env });
    await put(root, `openspec/changes/${name}/proposal.md`, `# Why\n\nDeliver ${name} for location callers.\n\n## What Changes\n\nAdd ${name}.\n\n## Impact\n\nLocation specifications.\n`);
    if (tasks !== null) await put(root, `openspec/changes/${name}/tasks.md`, tasks);
    await put(root, `openspec/changes/${name}/specs/locations/spec.md`, `## ADDED Requirements\n${requirement(name[0].toUpperCase() + name.slice(1))}`);
    for (const [path, content] of Object.entries(extra)) await put(root, `openspec/changes/${name}/${path}`, content);
  };
  const commit = async (message = 'Work') => { await git('add', '.'); await git('commit', '-qm', message); };
  const cli = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, json: JSON.parse(error.stderr || error.stdout) }; }
  };
  return { root, env, git, change, commit, cli };
}
const byName = changes => Object.fromEntries(changes.map(change => [change.name, change]));

// spec: change-archival / Finished change
// spec: change-archival / Held open
test('readiness comes from ticked tasks; an unticked task or no tasks holds a change open', async t => {
  const { change, commit, cli } = await fixture(t);
  await change('radius', '- [x] Build radius\n- [x] Test radius\n');
  await change('ordering', '- [x] Build ordering\n- [ ] Test ordering\n');
  await change('filters', null);
  await commit();
  const { json } = await cli('specs', 'archivable');
  const changes = byName(json.changes);
  assert.deepEqual(changes.radius, { name: 'radius', tasks: { completed: 2, total: 2 }, plan: 'absent', ready: true, blockers: [] });
  assert.deepEqual([changes.ordering.ready, changes.ordering.blockers], [false, [{ code: 'tasks_incomplete' }]]);
  assert.deepEqual([changes.filters.ready, changes.filters.blockers], [false, [{ code: 'no_tasks' }]]);
});

// spec: change-archival / Slices not landed
test('a planned change waits for every slice to land on the base', async t => {
  const { git, change, commit, cli } = await fixture(t);
  await change('radius', '- [x] Store\n- [x] Query\n', { 'slices.yaml': 'slices:\n  - id: store\n    implements: [locations / Radius]\n  - id: query\n    implements: [locations / Radius]\n    depends_on: [store]\n' });
  await commit();
  await git('commit', '-q', '--allow-empty', '-m', 'Store\n\nOpenSpec-Change: radius\nOpenSpec-Slice: store');
  const waiting = byName((await cli('specs', 'archivable')).json.changes).radius;
  assert.deepEqual([waiting.ready, waiting.plan, waiting.blockers], [false, 'present', [{ code: 'slices_unlanded', slices: ['query'] }]]);
  await git('commit', '-q', '--allow-empty', '-m', 'Query\n\nOpenSpec-Change: radius\nOpenSpec-Slice: query');
  assert.equal(byName((await cli('specs', 'archivable')).json.changes).radius.ready, true);
});

// spec: change-archival / Readiness over MCP
test('MCP returns the same readiness, never offers archiving, and respects addons', async t => {
  const { root, env, change, commit, cli } = await fixture(t);
  await change('radius', '- [x] Build radius\n');
  await commit();
  const client = new Client({ name: 'archival-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('archivable_changes'));
  assert.ok(!tools.includes('archive_ready'));
  const result = await client.callTool({ name: 'archivable_changes', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), (await cli('specs', 'archivable')).json);
  const refused = await client.callTool({ name: 'archive_ready', arguments: {} });
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'UNKNOWN_OPERATION');
  const disabled = join(root, 'core-only');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', disabled, '--addons', 'none'], { env });
  const core = new Client({ name: 'archival-disabled', version: '1.0' });
  await core.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', disabled], env, stderr: 'pipe' }));
  t.after(() => core.close());
  assert.ok(!(await core.listTools()).tools.some(tool => tool.name === 'archivable_changes'));
});

// spec: change-archival / Archive what is finished
test('archive --ready archives only ready changes and validates the canonical specs', async t => {
  const { root, git, change, commit, cli } = await fixture(t);
  await change('radius', '- [x] Build radius\n');
  await change('ordering', '- [ ] Build ordering\n');
  await commit();
  const { code, json } = await cli('specs', 'archive', '--ready');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json.archived.map(item => [item.name, item.specsUpdated, item.totals.added]), [['radius', true, 1]]);
  assert.match(json.archived[0].archivedAs, /^\d{4}-\d{2}-\d{2}-radius$/);
  assert.deepEqual(json.skipped, [{ name: 'ordering', blockers: [{ code: 'tasks_incomplete' }] }]);
  assert.equal(json.valid, true);
  assert.match(await readFile(join(root, 'openspec/specs/locations/spec.md'), 'utf8'), /Requirement: Radius/);
  assert.ok((await readdir(join(root, 'openspec/changes'))).includes('ordering'));
  assert.ok(!(await readdir(join(root, 'openspec/changes'))).includes('radius'));
  assert.ok((await readdir(join(root, 'openspec/changes/archive'))).includes(json.archived[0].archivedAs));
  assert.notEqual((await git('status', '--porcelain')).stdout, '');
  assert.equal((await git('rev-list', '--count', 'HEAD')).stdout.trim(), '1');
});

// spec: change-archival / Nothing ready
test('with nothing ready, archive --ready changes no file', async t => {
  const { root, change, commit, cli } = await fixture(t);
  await change('ordering', '- [ ] Build ordering\n');
  await commit();
  const before = await hashes(root);
  const { code, json } = await cli('specs', 'archive', '--ready');
  assert.equal(code, 0);
  assert.deepEqual([json.archived, json.valid, json.validation], [[], true, null]);
  assert.deepEqual(await hashes(root), before);
});

// spec: change-archival / Archive refused without the flag
test('specs archive without --ready refuses and archives nothing', async t => {
  const { root, change, commit, cli } = await fixture(t);
  await change('radius', '- [x] Build radius\n');
  await commit();
  const before = await hashes(root);
  const { code, json } = await cli('specs', 'archive');
  assert.notEqual(code, 0);
  assert.equal(json.error.code, 'INVALID_INPUT');
  assert.match(json.error.message, /--ready/);
  assert.deepEqual(await hashes(root), before);
  assert.equal((await cli('specs', 'archivable', '--ready')).json.error.code, 'INVALID_INPUT');
});
