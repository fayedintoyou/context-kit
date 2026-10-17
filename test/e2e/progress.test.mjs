import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = fileURLToPath(new URL('../../', import.meta.url));
const openspecBin = join(kit, 'node_modules/@fission-ai/openspec/bin/openspec.js');
const requirement = (name, scenario = `Use ${name}`, text = `The service SHALL support ${name.toLowerCase()} for location callers.`) =>
  `### Requirement: ${name}\n${text}\n\n#### Scenario: ${scenario}\n- **WHEN** a caller uses ${name.toLowerCase()}\n- **THEN** it works\n`;
const spec = content => `# Locations\n\n## Purpose\nFind locations by text, radius and filters for callers of the location service.\n\n## Requirements\n\n${content}`;
const delta = `## ADDED Requirements\n${requirement('Radius')}\n${requirement('Ordering')}\n## MODIFIED Requirements\n${requirement('Search', 'Use Search', 'The service SHALL find locations by text and radius.')}`;
const plan = `slices:
  - id: storage
    implements: [locations / Radius]
    paths: ["src/search/**"]
  - id: api
    implements: [locations / Ordering, locations / Search]
    depends_on: [storage]
  - id: client
    implements: [locations / Search]
    depends_on: [api]
`;
async function put(root, path, content) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}
// PATH holds only git and, when a test asks for it, a fake gh, so a real gh never reaches GitHub.
async function fixture(t, { slices = plan, gh } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-progress-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  if (gh) {
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(gh)}'\n`);
    await chmod(join(bin, 'gh'), 0o755);
  }
  const env = { ...process.env, PATH: bin, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1', HOME: base };
  delete env.CONTEXT_KIT_ROOT;
  await put(root, 'openspec/config.yaml', 'schema: spec-driven\n');
  await put(root, 'openspec/specs/locations/spec.md', spec(requirement('Search')));
  await put(root, 'openspec/changes/deliver/proposal.md', '# Why\n\nDeliver radius search.\n');
  await put(root, 'openspec/changes/deliver/specs/locations/spec.md', delta);
  if (slices) await put(root, 'openspec/changes/deliver/slices.yaml', slices);
  const git = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env });
  await git('init', '-q', '-b', 'main');
  await git('add', '.');
  await git('commit', '-qm', 'Propose deliver');
  const cli = async (...args) => {
    try { return JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env })).stdout); }
    catch (error) { return JSON.parse(error.stderr || error.stdout); }
  };
  // A slice commit carries the trailers; the file defaults to one inside the slice's scope.
  const land = async (slice, file = `src/search/${slice}.mjs`, change = 'deliver') => {
    await put(root, file, `export const ${slice.replace(/\W/g, '_')} = true;\n`);
    await git('add', '.');
    await git('commit', '-qm', `Build ${slice}\n\n${change ? `OpenSpec-Change: ${change}\n` : ''}${slice ? `OpenSpec-Slice: ${slice}\n` : ''}`);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  return { root, base, env, cli, git, land };
}
// The workspace's hub declares store `shared`: a git repository registered in the isolated
// OpenSpec registry that plans change `embed`. Store `stray` is registered but declared by no hub.
async function storeFixture(t) {
  const context = await fixture(t);
  const { base, env, root } = context;
  await put(root, 'hubs/team/README.md', '---\ntype: Guide\n---\n\nTeam context\n');
  await put(root, 'hubs/team/hub.json', JSON.stringify({ version: 1, id: 'team/shared', description: 'Team',
    documents: ['README.md'], skills: [], links: [], specStores: ['shared'] }));
  const store = join(base, 'shared-store');
  await put(store, 'openspec/config.yaml', 'schema: spec-driven\n');
  await put(store, 'openspec/specs/locations/spec.md', spec(requirement('Search', 'Use Search', 'The store SHALL describe search for every party.')));
  await put(store, 'openspec/changes/embed/proposal.md', '# Why\n\nEmbed radius search across parties.\n');
  await put(store, 'openspec/changes/embed/specs/locations/spec.md', delta);
  await put(store, 'openspec/changes/embed/slices.yaml', plan);
  await put(store, 'openspec/changes/embed/tasks.md', '- [x] 1.1 Storage\n- [ ] 1.2 Api\n');
  const stray = join(base, 'stray-store');
  await put(stray, 'openspec/config.yaml', 'schema: spec-driven\n');
  for (const [path, id] of [[store, 'shared'], [stray, 'stray']]) {
    await exec(process.execPath, [openspecBin, 'store', 'register', path, '--id', id, '--yes', '--json'], { env });
  }
  const git = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: store, env });
  await git('init', '-q', '-b', 'main');
  await git('add', '.');
  await git('commit', '-qm', 'Plan embed');
  const client = new Client({ name: 'progress-store-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const mcp = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { ...context, store, storeGit: git, client, mcp };
}
const states = status => Object.fromEntries(status.slices.map(slice => [slice.id, slice.state]));
const requirementStates = status => Object.fromEntries(status.requirements.map(item => [item.id, item.state]));

// spec: change-progress / Valid plan
test('a valid plan lists every slice and requirement with nothing landed', async t => {
  const { cli } = await fixture(t);
  const status = await cli('specs', 'status', 'deliver');
  assert.equal(status.plan, 'present');
  assert.deepEqual(states(status), { storage: 'ready', api: 'blocked', client: 'blocked' });
  assert.deepEqual(status.slices[1].blockedBy, ['storage']);
  assert.deepEqual(requirementStates(status), { 'locations / Radius': 'unstarted', 'locations / Ordering': 'unstarted', 'locations / Search': 'unstarted' });
  assert.deepEqual(status.base, { ref: 'main', refs: ['main'], commit: status.base.commit });
  assert.deepEqual(status.totals, { slices: { landed: 0, total: 3 }, requirements: { landed: 0, total: 3 }, readyToReconcile: false });
});

// spec: change-progress / Invalid plan
test('invalid plans fail with INVALID_CONFIG naming the file and problem', async t => {
  const { root, cli } = await fixture(t);
  const cases = [
    [plan.replace('depends_on: [storage]', 'depends_on: [client]'), /dependency cycle (api -> client -> api|client -> api -> client)/],
    [plan.replace('locations / Radius', 'locations / Teleport'), /implements "locations \/ Teleport"/],
    [plan.replace('id: client', 'id: api'), /duplicate slice id api/],
    [plan.replace('depends_on: [storage]', 'depends_on: [nowhere]'), /unknown slice nowhere/],
    [plan.replace('src/search/**', '../outside/**'), /path leaves the repository/],
    ['slices: [', /slices.yaml: /],
  ];
  for (const [content, message] of cases) {
    await put(root, 'openspec/changes/deliver/slices.yaml', content);
    const result = await cli('specs', 'status', 'deliver');
    assert.equal(result.error?.code, 'INVALID_CONFIG', JSON.stringify(result));
    assert.match(result.error.message, /openspec\/changes\/deliver\/slices\.yaml: /);
    assert.match(result.error.message, message);
  }
  assert.equal((await cli('specs', 'status', 'missing')).error.code, 'NOT_FOUND');
  assert.equal((await cli('specs', 'stores', '--store', 'shared')).error.code, 'INVALID_INPUT');
});

// spec: change-progress / Partly delivered change
test('landed, in-progress and blocked slices come from trailers on base and branches', async t => {
  const { cli, git, land } = await fixture(t, { slices: plan.replace('implements: [locations / Search]\n    depends_on: [api]', 'implements: [locations / Search]\n    depends_on: [api]').replace('locations / Ordering, locations / Search', 'locations / Ordering') });
  const landed = await land('storage');
  await git('switch', '-q', '-c', 'feature/api');
  const working = await land('api');
  await git('switch', '-q', 'main');
  const status = await cli('specs', 'status', 'deliver');
  assert.deepEqual(states(status), { storage: 'landed', api: 'in_progress', client: 'blocked' });
  assert.deepEqual(status.slices[0].commits.map(c => [c.sha, c.landed]), [[landed, true]]);
  assert.deepEqual(status.slices[1].commits.map(c => [c.sha, c.landed]), [[working, false]]);
  assert.deepEqual(status.slices[1].branches, ['feature/api']);
  assert.deepEqual(status.slices[2].blockedBy, ['api']);
  assert.deepEqual(status.totals.slices, { landed: 1, total: 3 });
  assert.deepEqual(requirementStates(status), { 'locations / Radius': 'landed', 'locations / Ordering': 'in_progress', 'locations / Search': 'unstarted' });
  await git('merge', '-q', '--no-ff', '-m', 'Merge api', 'feature/api');
  assert.equal(states(await cli('specs', 'status', 'deliver')).api, 'landed');
});

// spec: change-progress / Partly delivered change
test('trailer lines count anywhere in a squash-style message', async t => {
  const { root, cli, git } = await fixture(t);
  await put(root, 'src/search/storage.mjs', 'export const storage = true;\n');
  await git('add', '.');
  await git('commit', '-qm', 'Storage (#3)\n\n* Build storage\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage\n\n* Tidy up\n\nCo-Authored-By: Someone <someone@example.com>\n');
  assert.equal(states(await cli('specs', 'status', 'deliver')).storage, 'landed');
});

// spec: change-progress / Requirement covered by two slices
test('a requirement is partial until every covering slice lands', async t => {
  const { cli, land } = await fixture(t);
  await land('storage');
  await land('api');
  const status = await cli('specs', 'status', 'deliver');
  assert.equal(requirementStates(status)['locations / Search'], 'partial');
  assert.equal(status.totals.readyToReconcile, false);
  await land('client');
  const done = await cli('specs', 'status', 'deliver');
  assert.ok(Object.values(requirementStates(done)).every(state => state === 'landed'));
  assert.deepEqual(done.totals, { slices: { landed: 3, total: 3 }, requirements: { landed: 3, total: 3 }, readyToReconcile: true });
});

// spec: change-progress / No plan
test('without a plan every requirement is unplanned and nothing is next', async t => {
  const { cli } = await fixture(t, { slices: null });
  const status = await cli('specs', 'status', 'deliver');
  assert.equal(status.plan, 'absent');
  assert.deepEqual(status.slices, []);
  assert.ok(status.requirements.every(item => item.state === 'unplanned'));
  const next = await cli('specs', 'next', 'deliver');
  assert.deepEqual([next.packets, next.reason], [[], 'no_plan']);
  assert.deepEqual((await cli('specs', 'reconcile', 'deliver')).uncovered, ['locations / Radius', 'locations / Ordering', 'locations / Search']);
});

// spec: change-progress / Open pull request
test('gh pull requests carrying trailers mark slices in progress or landed', async t => {
  const body = slice => `Builds the slice.\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: ${slice}\n`;
  const { cli } = await fixture(t, { gh: [
    { number: 7, state: 'MERGED', headRefName: 'storage', body: body('storage'), url: 'https://example.test/pr/7' },
    { number: 8, state: 'OPEN', headRefName: 'api', body: body('api'), url: 'https://example.test/pr/8' },
    { number: 9, state: 'CLOSED', headRefName: 'client', body: body('client'), url: 'https://example.test/pr/9' },
    { number: 10, state: 'OPEN', headRefName: 'other', body: 'OpenSpec-Change: elsewhere\nOpenSpec-Slice: client\n', url: 'https://example.test/pr/10' }] });
  const status = await cli('specs', 'status', 'deliver');
  assert.deepEqual(status.pullRequests, { status: 'collected' });
  assert.deepEqual(states(status), { storage: 'landed', api: 'in_progress', client: 'blocked' });
  assert.deepEqual(status.slices[1].pullRequests, [{ number: 8, state: 'OPEN', url: 'https://example.test/pr/8' }]);
  assert.deepEqual(status.slices[2].pullRequests, []);
});

// spec: change-progress / GitHub CLI missing
test('without gh, pull requests are not collected and git still decides', async t => {
  const { cli, land } = await fixture(t);
  await land('storage');
  const status = await cli('specs', 'status', 'deliver');
  assert.deepEqual(status.pullRequests, { status: 'not_collected', reason: 'gh is not installed' });
  assert.equal(states(status).storage, 'landed');
});

// spec: change-progress / Status over MCP
test('MCP returns the same status and respects addon selection', async t => {
  const { root, env, cli, land } = await fixture(t);
  await land('storage');
  const client = new Client({ name: 'progress-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['change_status', 'next_slices', 'read_slice', 'reconcile_change']) assert.ok(tools.includes(name), name);
  const result = await client.callTool({ name: 'change_status', arguments: { change: 'deliver' } });
  assert.deepEqual(JSON.parse(result.content[0].text), await cli('specs', 'status', 'deliver'));
  const disabled = join(root, 'core-only');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', disabled, '--addons', 'none'], { env });
  const core = new Client({ name: 'progress-disabled', version: '1.0' });
  await core.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', disabled], env, stderr: 'pipe' }));
  t.after(() => core.close());
  assert.ok(!(await core.listTools()).tools.some(tool => tool.name === 'change_status'));
  const refused = await core.callTool({ name: 'change_status', arguments: { change: 'deliver' } });
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'ADDON_DISABLED');
});

// spec: change-progress / Parallel ready slices
test('next returns a packet for every ready slice without writing', async t => {
  const { root, cli, git, land } = await fixture(t, { slices: plan.replace('depends_on: [api]', 'depends_on: [storage]') });
  const landed = await land('storage');
  const head = (await git('rev-parse', 'HEAD')).stdout;
  const next = await cli('specs', 'next', 'deliver');
  assert.deepEqual(next.packets.map(packet => packet.slice.id), ['api', 'client']);
  for (const packet of next.packets) {
    assert.deepEqual(packet.dependencies, [{ id: 'storage', state: 'landed', commits: [landed] }]);
    assert.equal(packet.trailers, `OpenSpec-Change: deliver\nOpenSpec-Slice: ${packet.slice.id}`);
    assert.equal(packet.base.ref, 'main');
    assert.ok(packet.requirements.length > 0);
    assert.equal(packet.review, undefined);
  }
  assert.deepEqual(next.packets[0].requirements.map(item => item.id), ['locations / Ordering', 'locations / Search']);
  assert.equal(next.packets[0].requirements[0].delta.scenarios[0].name, 'Use Ordering');
  assert.equal((await git('rev-parse', 'HEAD')).stdout, head);
  assert.equal((await git('status', '--porcelain')).stdout, '');
  assert.equal(root, next.root);
});

// spec: change-progress / Nothing ready
test('next explains when no slice is ready', async t => {
  const { cli, git, land } = await fixture(t);
  await git('switch', '-q', '-c', 'feature/storage');
  await land('storage');
  const next = await cli('specs', 'next', 'deliver');
  assert.deepEqual([next.packets, next.reason], [[], 'nothing_ready']);
  assert.deepEqual(next.waiting.map(item => [item.id, item.state]), [['storage', 'in_progress'], ['api', 'blocked'], ['client', 'blocked']]);
  await git('switch', '-q', 'main');
  await git('merge', '-q', 'feature/storage');
  await land('api');
  await land('client');
  assert.equal((await cli('specs', 'next', 'deliver')).reason, 'all_landed');
});

// spec: change-progress / Packet for a modified requirement
test('a slice packet quotes delta and canonical text and lists review inputs once started', async t => {
  const { root, cli, land } = await fixture(t);
  await put(root, 'test/e2e/search.test.mjs', "// spec: locations / Use Search\ntest('search', () => {});\n");
  await land('storage');
  const packet = await cli('specs', 'slice', 'deliver', 'api');
  const search = packet.requirements.find(item => item.id === 'locations / Search');
  assert.deepEqual(search.ops, ['MODIFIED']);
  assert.equal(search.delta.text, 'The service SHALL find locations by text and radius.');
  assert.equal(search.canonical.text, 'The service SHALL support search for location callers.');
  assert.equal(packet.requirements.find(item => item.id === 'locations / Ordering').canonical, null);
  assert.equal(packet.review, undefined);
  const commit = await land('api');
  const started = await cli('specs', 'slice', 'deliver', 'api');
  assert.equal(started.slice.state, 'landed');
  assert.deepEqual(started.review.commits.map(c => c.sha), [commit]);
  assert.deepEqual(started.review.linkedTests, [{ key: 'locations / Use Search', kind: 'e2e', file: 'test/e2e/search.test.mjs', line: 1 }]);
  assert.equal((await cli('specs', 'slice', 'deliver', 'nowhere')).error.code, 'NOT_FOUND');
});

// spec: change-progress / Out-of-scope file
test('reconcile lists files outside a slice scope and files shared by slices', async t => {
  const { root, cli, git, land } = await fixture(t);
  await put(root, 'src/search/storage.mjs', 'export const a = 1;\n');
  await put(root, 'src/ingest/retry.mjs', 'export const retry = 3;\n');
  await put(root, 'openspec/changes/deliver/tasks.md', '- [x] storage\n');
  await git('add', '.');
  await git('commit', '-qm', 'Storage\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage\n');
  await land('api', 'src/search/storage.mjs');
  const report = await cli('specs', 'reconcile', 'deliver');
  const storage = report.slices.find(slice => slice.id === 'storage');
  assert.equal(storage.scope, 'checked');
  assert.deepEqual(storage.files, ['src/ingest/retry.mjs', 'src/search/storage.mjs']);
  assert.deepEqual(storage.outOfScope, ['src/ingest/retry.mjs']);
  assert.deepEqual(report.slices.find(slice => slice.id === 'api'), { id: 'api', state: 'landed', scope: 'unchecked', files: ['src/search/storage.mjs'], outOfScope: [] });
  assert.deepEqual(report.sharedFiles, [{ file: 'src/search/storage.mjs', slices: ['storage', 'api'] }]);
  assert.deepEqual(report.uncovered, []);
  assert.deepEqual(report.status.totals.slices, { landed: 2, total: 3 });
});

// spec: change-progress / Stray trailer
test('reconcile lists trailer commits naming unknown slices', async t => {
  const { cli, land } = await fixture(t);
  const unknown = await land('caching', 'src/search/cache.mjs');
  const missing = await land('', 'src/search/misc.mjs');
  await land('storage', 'src/search/other.mjs', 'other-change');
  const report = await cli('specs', 'reconcile', 'deliver');
  assert.deepEqual(report.strayTrailers.map(item => [item.sha, item.slice]).sort(), [[missing, null], [unknown, 'caching']].sort());
  assert.equal(states(report.status).storage, 'ready');
});

// spec: change-progress / Untested change scenario
test('reconcile lists change scenarios no test links', async t => {
  const { root, cli, land } = await fixture(t);
  assert.deepEqual((await cli('specs', 'reconcile', 'deliver')).untested, { status: 'not_collected', scenarios: [] });
  await put(root, 'test/e2e/delivery.test.mjs', "// spec: locations / Use Radius\n// spec: locations / Use Search\ntest('delivered', () => {});\n");
  await land('storage');
  await land('api');
  await land('client');
  const report = await cli('specs', 'reconcile', 'deliver');
  assert.equal(report.status.totals.readyToReconcile, true);
  assert.deepEqual(report.untested, { status: 'collected', scenarios: [{ spec: 'locations', requirement: 'Ordering', scenario: 'Use Ordering' }] });
});

// spec: change-progress / Store change over CLI and MCP
test('delivery operations read a declared store change over CLI and MCP', async t => {
  const { root, store, storeGit, cli, client, mcp } = await storeFixture(t);
  const head = (await storeGit('rev-parse', 'HEAD')).stdout.trim();
  const source = { kind: 'store', storeId: 'shared' };
  const status = await cli('specs', 'status', 'embed', '--store', 'shared');
  assert.equal(status.root, store);
  assert.deepEqual(status.source, source);
  assert.equal(status.change, 'embed');
  assert.deepEqual(states(status), { storage: 'ready', api: 'blocked', client: 'blocked' });
  assert.deepEqual(status.base, { ref: 'main', refs: ['main'], commit: head });
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), status);
  for (const call of [cli('specs', 'status', 'embed', '--store', 'stray'), mcp('change_status', { change: 'embed', store: 'stray' })]) {
    assert.equal((await call).error.code, 'UNKNOWN_STORE');
  }
  // Without a store the workspace repository is read, exactly as before.
  assert.equal((await cli('specs', 'status', 'embed')).error.code, 'NOT_FOUND');
  const own = await cli('specs', 'status', 'deliver');
  assert.equal(own.root, root);
  assert.equal(own.source, undefined);

  // The other delivery operations select the store the same way and write nothing.
  const next = await cli('specs', 'next', 'embed', '--store', 'shared');
  assert.deepEqual([next.root, next.source, next.packets.map(packet => packet.slice.id)], [store, source, ['storage']]);
  assert.deepEqual(await mcp('next_slices', { change: 'embed', store: 'shared' }), next);
  const packet = await cli('specs', 'slice', 'embed', 'api', '--store', 'shared');
  assert.deepEqual([packet.root, packet.source, packet.base.commit], [store, source, head]);
  assert.equal(packet.requirements.find(item => item.id === 'locations / Search').canonical.text, 'The store SHALL describe search for every party.');
  assert.equal(packet.trailers, 'OpenSpec-Change: embed\nOpenSpec-Slice: api');
  assert.deepEqual(await mcp('read_slice', { change: 'embed', slice: 'api', store: 'shared' }), packet);
  const report = await cli('specs', 'reconcile', 'embed', '--store', 'shared');
  assert.deepEqual([report.root, report.source, report.uncovered], [store, source, []]);
  assert.deepEqual(await mcp('reconcile_change', { change: 'embed', store: 'shared' }), report);
  const archivable = await cli('specs', 'archivable', '--store', 'shared');
  assert.deepEqual([archivable.root, archivable.source], [store, source]);
  assert.deepEqual(archivable.changes.map(({ name, ready, blockers }) => [name, ready, blockers.map(blocker => blocker.code)]),
    [['embed', false, ['tasks_incomplete', 'slices_unlanded']]]);
  assert.deepEqual(await mcp('archivable_changes', { store: 'shared' }), archivable);
  for (const [name, args] of [['next_slices', { change: 'embed' }], ['read_slice', { change: 'embed', slice: 'api' }],
    ['reconcile_change', { change: 'embed' }], ['archivable_changes', {}]]) {
    assert.equal((await mcp(name, { ...args, store: 'stray' })).error.code, 'UNKNOWN_STORE', name);
  }

  // Archiving a store stays CLI-only and, with nothing ready, changes nothing.
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'archive_ready'));
  const archived = await cli('specs', 'archive', '--ready', '--store', 'shared');
  assert.deepEqual([archived.root, archived.source, archived.archived, archived.skipped.map(item => item.name)], [store, source, [], ['embed']]);
  assert.equal((await cli('specs', 'archive', '--ready', '--store', 'stray')).error.code, 'UNKNOWN_STORE');
  assert.equal((await storeGit('rev-parse', 'HEAD')).stdout.trim(), head);
  assert.equal((await storeGit('status', '--porcelain')).stdout, '');
});
