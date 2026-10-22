import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm, realpath, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Evaluator, Lexer, Parser, data } from '@actions/expressions';
import { readFileSync } from 'node:fs';
import { rehearseArchive } from '../../lib/specs/archival.mjs';
import { openSpec } from '../../lib/specs/openspec.mjs';
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
// PATH holds only git, so a real gh never reaches GitHub from slice status. TMPDIR is the fixture's
// own, so a test can see that nothing is left behind in it.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-archival-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await mkdir(join(base, 'tmp'));
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  const env = { ...process.env, PATH: bin, HOME: base, TMPDIR: join(base, 'tmp'), XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
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
  return { base, root, env, git, change, commit, cli };
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
  const { root, git, change, commit, cli } = await fixture(t);
  await change('radius', '- [x] Store\n- [x] Query\n', { 'slices.yaml': 'slices:\n  - id: store\n    implements: [locations / Radius]\n  - id: query\n    implements: [locations / Radius]\n    depends_on: [store]\n' });
  await commit();
  await git('commit', '-q', '--allow-empty', '-m', 'Store\n\nOpenSpec-Change: radius\nOpenSpec-Slice: store');
  const waiting = byName((await cli('specs', 'archivable')).json.changes).radius;
  assert.deepEqual([waiting.ready, waiting.plan, waiting.blockers], [false, 'present', [{ code: 'slices_unlanded', slices: ['query'] }]]);
  await git('commit', '-q', '--allow-empty', '-m', 'Query\n\nOpenSpec-Change: radius\nOpenSpec-Slice: query');
  assert.equal(byName((await cli('specs', 'archivable')).json.changes).radius.ready, true);
  // A plan that can't be read holds the change with invalid_plan, carrying the plan's own error.
  await put(root, 'openspec/changes/radius/slices.yaml', 'slices:\n  - id: store\n    implements: [locations / Radius]\n    depends_on: [store]\n');
  const invalid = byName((await cli('specs', 'archivable')).json.changes).radius;
  assert.deepEqual([invalid.ready, invalid.plan, invalid.blockers.map(blocker => blocker.code)], [false, 'invalid', ['invalid_plan']]);
  assert.equal(invalid.blockers[0].error.code, 'INVALID_CONFIG');
  assert.match(invalid.blockers[0].error.message, /openspec\/changes\/radius\/slices\.yaml: dependency cycle store -> store/);
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

// spec: change-archival / Archive a change without spec deltas
test('archive --ready archives a change without spec deltas', async t => {
  const { root, change, commit, cli } = await fixture(t);
  await change('deploy', '- [x] Deploy it\n');
  await rm(join(root, 'openspec/changes/deploy/specs'), { recursive: true });
  await put(root, 'openspec/changes/deploy/.openspec.yaml', 'schema: spec-driven\nskip_specs: true\n');
  await commit();
  const specs = await readFile(join(root, 'openspec/specs/locations/spec.md'), 'utf8');
  const { code, json } = await cli('specs', 'archive', '--ready');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json.archived.map(item => [item.name, item.specsUpdated, item.totals]), [['deploy', false, {}]]);
  assert.equal(json.valid, true);
  assert.equal(await readFile(join(root, 'openspec/specs/locations/spec.md'), 'utf8'), specs);
  assert.ok(!(await readdir(join(root, 'openspec/changes'))).includes('deploy'));
  assert.ok((await readdir(join(root, 'openspec/changes/archive'))).includes(json.archived[0].archivedAs));
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
  // Archiving and rehearsing are different questions; one command asks one of them.
  assert.equal((await cli('specs', 'archive', '--ready', '--rehearse')).json.error.code, 'INVALID_INPUT');
  assert.equal((await cli('specs', 'archivable', '--rehearse')).json.error.code, 'INVALID_INPUT');
  assert.deepEqual(await hashes(root), before);
});

// The workspace's hub declares store `shared`, registered in the isolated OpenSpec registry. Its
// change `embed` adds contract `game-embedding` between parties `site` and `game`, one slice each,
// with every task ticked. The `located` parties have checkouts recorded with `repos locate`, each
// with an `origin` whose fictional upstream URL maps to a local bare repository; only the fixture's
// own git reaches it, through an isolated insteadOf config.
async function storeFixture(t, { located = ['site', 'game'] } = {}) {
  const context = await fixture(t);
  const { base, root, env, commit, cli } = context;
  const upstream = name => `https://github.com/example/${name}`;
  await put(root, 'hubs/team/README.md', '---\ntype: Guide\n---\n\nTeam context\n');
  await put(root, 'hubs/team/hub.json', JSON.stringify({ version: 1, id: 'team/shared', description: 'Team',
    documents: ['README.md'], skills: [], links: [], specStores: ['shared'] }));
  for (const name of ['site', 'game']) {
    await put(root, `hubs/team/${name}.md`, `---\ntype: Repository\ntitle: ${name}\nresource: ${upstream(name)}\n---\n\n# ${name}\n`);
  }
  await commit('Declare the shared store');
  const store = join(base, 'shared-store');
  const contract = `# Game embedding\n\n## Purpose\nHow the site hosts the game and the game accepts its host.\n\n## ADDED Requirements\n\n${requirement('Host')}\n${requirement('Guest')}`;
  await put(store, 'openspec/config.yaml', 'schema: spec-driven\n');
  await put(store, 'openspec/specs/locations/spec.md', `# Locations\n\n## Purpose\nFind locations by text, radius and filters for every party.\n\n## Requirements\n\n${requirement('Search')}`);
  await put(store, 'openspec/parties.yaml', `parties:\n  site: ${upstream('site')}\n  game: ${upstream('game')}\ncontracts:\n  game-embedding: [site, game]\n`);
  await exec(process.execPath, [openspec, 'store', 'register', store, '--id', 'shared', '--yes', '--json'], { env });
  await exec(process.execPath, [openspec, 'new', 'change', 'embed'], { cwd: store, env });
  await put(store, 'openspec/changes/embed/proposal.md', '# Why\n\nAgree how the site embeds the game.\n\n## What Changes\n\nAdd game-embedding.\n\n## Impact\n\nShared specs.\n');
  await put(store, 'openspec/changes/embed/tasks.md', '- [x] 1.1 Host\n- [x] 1.2 Guest\n- [x] 1.3 Finish\n');
  await put(store, 'openspec/changes/embed/specs/game-embedding/spec.md', contract);
  await put(store, 'openspec/changes/embed/slices.yaml', 'slices:\n  - id: host\n    repo: site\n    implements: [game-embedding / Host]\n  - id: guest\n    repo: game\n    implements: [game-embedding / Guest]\n');
  const storeGit = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: store, env });
  await storeGit('init', '-q', '-b', 'main');
  await storeGit('add', '.');
  await storeGit('commit', '-qm', 'Plan embed');
  const config = join(base, 'parties.gitconfig');
  const checkouts = {};
  for (const name of located) {
    const checkout = join(base, 'parties', name);
    const bare = join(base, 'upstreams', `${name}.git`);
    const run = (cwd, ...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      { cwd, env: { ...env, GIT_CONFIG_GLOBAL: config } });
    await mkdir(checkout, { recursive: true });
    await mkdir(bare, { recursive: true });
    await run(bare, 'init', '-q', '--bare', '-b', 'main');
    await appendFile(config, `[url "file://${bare}"]\n\tinsteadOf = ${upstream(name)}\n`);
    await run(checkout, 'init', '-q', '-b', 'main');
    await run(checkout, 'commit', '-q', '--allow-empty', '-m', `Start ${name}`);
    await run(checkout, 'remote', 'add', 'origin', upstream(name));
    await run(checkout, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    await run(checkout, 'remote', 'set-head', 'origin', '--auto');
    assert.equal((await cli('repos', 'locate', `team/shared/${name}`, checkout)).json.repository?.status, 'located');
    // A slice lands with the store-qualified trailers, pushed so the party remote's fetched main has it.
    const land = async slice => {
      await put(checkout, `src/${slice}.mjs`, `export const ${slice} = true;\n`);
      await run(checkout, 'add', '.');
      await run(checkout, 'commit', '-qm', `Build ${slice}\n\nOpenSpec-Change: shared:embed\nOpenSpec-Slice: ${slice}\n`);
      await run(checkout, 'push', '-q', 'origin', 'main');
      return (await run(checkout, 'rev-parse', 'HEAD')).stdout.trim();
    };
    checkouts[name] = { checkout: await realpath(checkout), git: (...args) => run(checkout, ...args), land };
  }
  const client = new Client({ name: 'archival-store-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const mcp = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { ...context, store: await realpath(store), storeGit, checkouts, client, mcp };
}

// spec: change-archival / Party evidence missing
test('a store slice whose party has no recorded checkout holds the change with evidence_missing', async t => {
  const { store, cli, mcp, checkouts: { site } } = await storeFixture(t, { located: ['site'] });
  const missing = { code: 'evidence_missing', slices: [{ id: 'guest', party: 'game', reason: 'checkout_missing',
    remedies: ['repos locate team/shared/game <path>', 'repos clone team/shared/game [<path>]'] }] };
  // Each unlanded slice is named by one blocker: the unknown one by evidence_missing, the rest by slices_unlanded.
  const waiting = (await cli('specs', 'archivable', '--store', 'shared')).json;
  assert.deepEqual(waiting.changes, [{ name: 'embed', tasks: { completed: 3, total: 3 }, plan: 'present', ready: false,
    blockers: [missing, { code: 'slices_unlanded', slices: ['host'] }] }]);
  assert.deepEqual(await mcp('archivable_changes', { store: 'shared' }), waiting);
  await site.land('host');
  const result = (await cli('specs', 'archivable', '--store', 'shared')).json;
  assert.deepEqual([result.root, result.source], [store, { kind: 'store', storeId: 'shared' }]);
  assert.deepEqual(result.changes.map(({ name, ready, blockers }) => [name, ready, blockers]), [['embed', false, [missing]]]);
  assert.deepEqual(await mcp('archivable_changes', { store: 'shared' }), result);
  // Archiving skips it with the same blocker and leaves the store's tree as it was.
  const before = await hashes(store);
  const { code, json } = await cli('specs', 'archive', '--ready', '--store', 'shared');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual([json.archived, json.skipped], [[], [{ name: 'embed', blockers: [missing] }]]);
  assert.deepEqual(await hashes(store), before);
});

// spec: change-archival / Archive a finished store change
test('archive --ready --store archives a finished store change only under the store\'s openspec/', async t => {
  const { base, git, store, storeGit, cli, mcp, client, checkouts: { site, game } } = await storeFixture(t);
  await site.land('host');
  await game.land('guest');
  const readiness = (await cli('specs', 'archivable', '--store', 'shared')).json;
  assert.deepEqual(readiness.changes.map(({ name, ready, blockers }) => [name, ready, blockers]), [['embed', true, []]]);
  assert.deepEqual(await mcp('archivable_changes', { store: 'shared' }), readiness);
  // Archiving stays CLI-only.
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'archive_ready'));
  assert.equal((await mcp('archive_ready', { store: 'shared' })).error.code, 'UNKNOWN_OPERATION');
  const heads = () => Promise.all([git, storeGit, site.git, game.git].map(async run => (await run('rev-parse', 'HEAD')).stdout.trim()));
  const [before, headsBefore] = [await hashes(base), await heads()];
  const { code, json } = await cli('specs', 'archive', '--ready', '--store', 'shared');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual([json.root, json.source], [store, { kind: 'store', storeId: 'shared' }]);
  assert.deepEqual(json.archived.map(item => [item.name, item.specsUpdated, item.totals.added]), [['embed', true, 2]]);
  assert.deepEqual([json.skipped, json.valid], [[], true]);
  // The contract is canonical in the store, and the change is in the store's archive.
  const canonical = await readFile(join(store, 'openspec/specs/game-embedding/spec.md'), 'utf8');
  assert.match(canonical, /Requirement: Host/);
  assert.match(canonical, /Requirement: Guest/);
  assert.ok(!(await readdir(join(store, 'openspec/changes'))).includes('embed'));
  assert.ok((await readdir(join(store, 'openspec/changes/archive'))).includes(json.archived[0].archivedAs));
  assert.deepEqual((await cli('specs', 'parties', '--store', 'shared')).json.contracts,
    [{ spec: 'game-embedding', parties: ['site', 'game'], status: 'canonical' }]);
  // Nothing outside the store's openspec/ changed: not the workspace, the store's other files,
  // the party checkouts or the registry; and nothing was committed anywhere.
  const after = await hashes(base);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
  assert.ok(changed.length > 0);
  assert.deepEqual(changed.filter(file => !file.startsWith('shared-store/openspec/')), []);
  assert.deepEqual(await heads(), headsBefore);
});

// The walk-through in docs/delivery.md ("A change across repositories"), command for command.
// spec: change-archival / Archive a finished store change
// spec: change-progress / Party tests are found
test('a contract change sliced across two parties is delivered, reconciled and archived in its store', async t => {
  const { store, storeGit, cli, mcp, checkouts: { site, game } } = await storeFixture(t);
  const scenario = (name, when, then) => `#### Scenario: ${name}\n- **WHEN** ${when}\n- **THEN** ${then}\n`;
  await put(store, 'openspec/changes/embed/specs/game-embedding/spec.md', `# Game embedding\n\n## Purpose\nHow the site hosts the game and the game accepts its host.\n\n## ADDED Requirements\n\n`
    + `### Requirement: Guest handshake\nThe game SHALL accept the page that embeds it as its host.\n\n${scenario('Game accepts its host', 'the site embeds the game', 'the game accepts the site as its host')}\n`
    + `### Requirement: Host frame\nThe site SHALL open the game in a frame.\n\n${scenario('Site opens the game', 'a visitor opens the game page', 'the site opens the game in a frame')}`);
  await put(store, 'openspec/changes/embed/slices.yaml', `slices:
  - id: game-guest
    repo: game
    implements: [game-embedding / Guest handshake]
    paths: ["src/embed/**", "test/embed/**", "openspec/changes/accept-host/**"]
  - id: site-host
    repo: site
    implements: [game-embedding / Host frame]
    depends_on: [game-guest]
    paths: ["src/embed/**", "test/embed/**", "openspec/changes/embed-game/**"]
`);
  const tasks = (...ticked) => ['1.1 game-guest lands in game', '1.2 site-host lands in site', '2.1 Finish: reconcile, then archive in the store\'s repository']
    .map(task => `- [${ticked.includes(task.split(' ')[0]) ? 'x' : ' '}] ${task}\n`).join('');
  const tick = async (...ticked) => {
    await put(store, 'openspec/changes/embed/tasks.md', tasks(...ticked));
    await storeGit('add', '.');
    await storeGit('commit', '-qm', `Tick ${ticked.at(-1) ?? 'nothing'}`);
  };
  await tick();
  const status = () => cli('specs', 'status', 'embed', '--store', 'shared').then(result => result.json);
  const states = result => Object.fromEntries(result.slices.map(slice => [slice.id, slice.state]));
  // Each party proposes its own change, then one PR implements it and the slice with the qualified trailers and a contract link.
  const build = async (party, slice, own, scenarioName) => {
    await put(party.checkout, `openspec/changes/${own}/tasks.md`, '- [ ] 1.1 Build\n');
    await party.git('add', '.');
    await party.git('commit', '-qm', `Propose ${own}`);
    await party.git('push', '-q', 'origin', 'main');
    await party.git('switch', '-q', '-c', slice, 'origin/main');
    await put(party.checkout, `openspec/changes/${own}/tasks.md`, '- [x] 1.1 Build\n');
    await put(party.checkout, `src/embed/${slice}.ts`, `export const ${slice.replace('-', '_')} = true;\n`);
    await put(party.checkout, `test/embed/${slice}.test.mjs`, ['// spec: embedding / Own scenario', `// spec: shared:game-embedding / ${scenarioName}`, `test('${slice}', () => {});`, ''].join('\n'));
    await party.git('add', '.');
    await party.git('commit', '-qm', `Build ${slice}\n\nOpenSpec-Change: shared:embed\nOpenSpec-Slice: ${slice}\n`);
    return (await party.git('rev-parse', 'HEAD')).stdout.trim();
  };
  // The PR merges into the party's main, and the checkout is fetched.
  const merge = async (party, slice) => {
    await party.git('push', '-q', 'origin', `${slice}:main`);
    await party.git('fetch', '-q', 'origin');
  };

  assert.deepEqual(states(await status()), { 'game-guest': 'ready', 'site-host': 'blocked' });
  const [guestPacket] = (await cli('specs', 'next', 'embed', '--store', 'shared')).json.packets;
  assert.deepEqual([guestPacket.slice.id, guestPacket.store, guestPacket.repo.party, guestPacket.repo.remote, guestPacket.trailers],
    ['game-guest', 'shared', 'game', 'origin', 'OpenSpec-Change: shared:embed\nOpenSpec-Slice: game-guest']);
  const guest = await build(game, 'game-guest', 'accept-host', 'Game accepts its host');
  const guestLink = { key: 'game-embedding / Game accepts its host', repo: 'game', file: 'test/embed/game-guest.test.mjs', line: 2, commit: guest };
  const review = (await cli('specs', 'slice', 'embed', 'game-guest', '--store', 'shared')).json;
  assert.equal(review.slice.state, 'in_progress');
  assert.deepEqual(review.review.linkedTests, { repo: 'game', status: 'collected', commit: guest, links: [guestLink] });
  await merge(game, 'game-guest');
  await tick('1.1');
  assert.deepEqual(states(await status()), { 'game-guest': 'landed', 'site-host': 'ready' });
  const [hostPacket] = (await cli('specs', 'next', 'embed', '--store', 'shared')).json.packets;
  assert.deepEqual([hostPacket.slice.id, hostPacket.repo.party, hostPacket.dependencies],
    ['site-host', 'site', [{ id: 'game-guest', repo: 'game', state: 'landed', commits: [guest] }]]);
  const host = await build(site, 'site-host', 'embed-game', 'Site opens the game');
  await merge(site, 'site-host');
  await tick('1.1', '1.2');

  // Finish: fetch, reconcile, tick the final task, check readiness, archive, and commit in the store's repository.
  for (const party of [game, site]) await party.git('fetch', '-q');
  const report = (await cli('specs', 'reconcile', 'embed', '--store', 'shared')).json;
  assert.equal(report.status.totals.readyToReconcile, true);
  assert.deepEqual(report.slices.map(({ id, repo, state, outOfScope }) => [id, repo, state, outOfScope]),
    [['game-guest', 'game', 'landed', []], ['site-host', 'site', 'landed', []]]);
  assert.deepEqual([report.sharedFiles, report.strayTrailers, report.uncovered], [[], [], []]);
  assert.deepEqual([report.untested.status, report.untested.scenarios], ['collected', []]);
  assert.deepEqual(report.untested.links, [
    { key: 'game-embedding / Site opens the game', repo: 'site', file: 'test/embed/site-host.test.mjs', line: 2, commit: host }, guestLink]);
  assert.deepEqual(await mcp('reconcile_change', { change: 'embed', store: 'shared' }), report);
  const held = (await cli('specs', 'archivable', '--store', 'shared')).json;
  assert.deepEqual(held.changes.map(({ name, ready, blockers }) => [name, ready, blockers]), [['embed', false, [{ code: 'tasks_incomplete' }]]]);
  await put(store, 'openspec/changes/embed/tasks.md', tasks('1.1', '1.2', '2.1'));
  const ready = (await cli('specs', 'archivable', '--store', 'shared')).json;
  assert.deepEqual(ready.changes.map(({ name, ready, blockers }) => [name, ready, blockers]), [['embed', true, []]]);
  const { code, json } = await cli('specs', 'archive', '--ready', '--store', 'shared');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual([json.archived.map(item => item.name), json.valid], [['embed'], true]);
  const canonical = await readFile(join(store, 'openspec/specs/game-embedding/spec.md'), 'utf8');
  assert.match(canonical, /Requirement: Guest handshake[\s\S]*Scenario: Game accepts its host/);
  assert.match(canonical, /Requirement: Host frame[\s\S]*Scenario: Site opens the game/);
  await storeGit('add', '.');
  await storeGit('commit', '-qm', 'Archive embed');
  assert.equal((await storeGit('status', '--porcelain')).stdout, '');
  assert.deepEqual((await cli('specs', 'archivable', '--store', 'shared')).json.changes, []);
  assert.deepEqual((await cli('specs', 'parties', '--store', 'shared')).json.contracts,
    [{ spec: 'game-embedding', parties: ['site', 'game'], status: 'canonical' }]);
});

// A requirement past OpenSpec's length limit: valid in the change's delta, flagged once canonical.
const longRequirement = name => `### Requirement: ${name}\n${'The service SHALL support radius for location callers. '.repeat(12)}\n\n#### Scenario: Use ${name}\n- **WHEN** a caller uses ${name.toLowerCase()}\n- **THEN** it works\n`;
const issueOf = (issues, ...fields) => issues.map(issue => fields.map(field => issue[field]));

// spec: change-archival / A change that would not archive cleanly
test('rehearse names the change, spec and requirement that would not validate, whatever the readiness, and changes nothing', async t => {
  const { base, root, change, commit, cli } = await fixture(t);
  await change('alpha', '- [x] Build alpha\n');
  await change('radius', '- [ ] Build radius\n- [ ] Test radius\n', { 'specs/locations/spec.md': `## ADDED Requirements\n${longRequirement('Radius')}` });
  await change('zeta', '- [x] Build zeta\n');
  await commit();
  const before = await hashes(root);
  const { code, json } = await cli('specs', 'archive', '--rehearse');
  assert.notEqual(code, 0);
  assert.deepEqual([json.valid, json.baseline], [false, []]);
  // Archive order; only radius introduced an issue, though its tasks are unticked and alpha and zeta come either side.
  assert.deepEqual(json.changes.map(item => item.name), ['alpha', 'radius', 'zeta']);
  assert.deepEqual(json.changes.map(item => item.issues.length), [0, 1, 0]);
  const [issue] = json.changes[1].issues;
  assert.deepEqual([issue.spec, issue.requirement, issue.path, issue.level], ['locations', 'Radius', 'requirements[2]', 'WARNING']);
  assert.match(issue.message, /500 characters/);
  assert.deepEqual(await hashes(root), before);
  assert.deepEqual(await readdir(join(base, 'tmp')), []);
});

// spec: change-archival / A change that would not archive cleanly
test('rehearse reports a change that cannot be applied as its issue and still rehearses the rest', async t => {
  const { root, change, commit, cli } = await fixture(t);
  await change('alpha', '- [x] Build alpha\n', { 'specs/locations/spec.md': `## MODIFIED Requirements\n${requirement('Missing')}` });
  await change('beta', '- [ ] Build beta\n', { 'specs/locations/spec.md': `## ADDED Requirements\n${longRequirement('Radius')}` });
  await commit();
  const before = await hashes(root);
  const { code, json } = await cli('specs', 'archive', '--rehearse');
  assert.notEqual(code, 0);
  assert.deepEqual(json.changes.map(item => [item.name, item.issues.length]), [['alpha', 1], ['beta', 1]]);
  assert.match(json.changes[0].issues[0].message, /MODIFIED failed for header "### Requirement: Missing" - not found/);
  assert.deepEqual(issueOf(json.changes[1].issues, 'spec', 'requirement', 'path'), [['locations', 'Radius', 'requirements[1]']]);
  assert.equal(json.valid, false);
  assert.deepEqual(await hashes(root), before);
});

// spec: change-archival / A clean rehearsal
test('rehearse of changes that archive cleanly lists each without issues, exits zero and changes no file', async t => {
  const { base, root, change, commit, cli } = await fixture(t);
  await change('ordering', '- [ ] Build ordering\n');
  await change('radius', '- [x] Build radius\n');
  await change('filters', null);
  await commit();
  const before = await hashes(root);
  const { code, json } = await cli('specs', 'archive', '--rehearse');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json, { root, changes: ['filters', 'ordering', 'radius'].map(name => ({ name, issues: [] })), baseline: [], valid: true });
  assert.deepEqual(await hashes(root), before);
  assert.deepEqual(await readdir(join(base, 'tmp')), []);
  // With nothing active there is nothing to rehearse.
  await rm(join(root, 'openspec/changes'), { recursive: true });
  assert.deepEqual((await cli('specs', 'archive', '--rehearse')).json.changes, []);
});

// spec: change-archival / Issues already in the canonical specs
test('rehearse reports an issue the canonical specs already have as baseline and blames no change', async t => {
  const { root, change, commit, cli } = await fixture(t);
  const spec = 'openspec/specs/locations/spec.md';
  await put(root, spec, (await readFile(join(root, spec), 'utf8')).replace(requirement('Search'), longRequirement('Search')));
  await change('radius', '- [ ] Build radius\n');
  await commit();
  const before = await hashes(root);
  const { code, json } = await cli('specs', 'archive', '--rehearse');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(issueOf(json.baseline, 'spec', 'requirement', 'path', 'level'), [['locations', 'Search', 'requirements[0]', 'WARNING']]);
  assert.deepEqual([json.changes, json.valid], [[{ name: 'radius', issues: [] }], true]);
  // A change that adds its own issue is blamed for that one only.
  await change('widest', '- [ ] Build widest\n', { 'specs/locations/spec.md': `## ADDED Requirements\n${longRequirement('Widest')}` });
  await commit();
  const unchanged = await hashes(root);
  const again = await cli('specs', 'archive', '--rehearse');
  assert.notEqual(again.code, 0);
  assert.deepEqual(again.json.baseline, json.baseline);
  assert.deepEqual(again.json.changes.map(item => [item.name, issueOf(item.issues, 'requirement')]), [['radius', []], ['widest', [['Widest']]]]);
  assert.deepEqual(await hashes(root), unchanged);
});

// spec: change-archival / A clean rehearsal
test('rehearse --store reads and rehearses a store\'s changes, in the store and nowhere else, and is not offered over MCP', async t => {
  const { base, store, cli, mcp, client } = await storeFixture(t);
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'archive_rehearse'));
  assert.equal((await mcp('archive_rehearse', { store: 'shared' })).error.code, 'UNKNOWN_OPERATION');
  const before = await hashes(base);
  const { code, json } = await cli('specs', 'archive', '--rehearse', '--store', 'shared');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual([json.root, json.source, json.changes, json.baseline, json.valid],
    [store, { kind: 'store', storeId: 'shared' }, [{ name: 'embed', issues: [] }], [], true]);
  assert.deepEqual(await hashes(base), before);
  assert.deepEqual(await readdir(join(base, 'tmp')), []);
});

// What a job's `runs-on` asks for, given the caller's `runs-on` input, worked out by GitHub's own
// expression evaluator (@actions/expressions): a list of labels, or one label.
const runnerFor = (expression, input) => {
  const code = expression.match(/^\$\{\{(.*)\}\}$/s)[1];
  const parser = new Parser(new Lexer(code).lex().tokens, ['inputs'], []);
  const inputs = new data.Dictionary(), context = new data.Dictionary();
  inputs.add('runs-on', new data.StringData(input));
  context.add('inputs', inputs);
  const result = new Evaluator(parser.parse(), context).evaluate();
  return result instanceof data.Array ? result.values().map(value => value.coerceString()) : result.coerceString();
};

// spec: change-archival / A caller's own runner
test('every job of the openspec workflow runs on the runner its caller names, and on ubuntu-latest otherwise', () => {
  const workflow = parse(readFileSync(join(kit, '.github/workflows/openspec.yml'), 'utf8'));
  const input = workflow.on.workflow_call.inputs['runs-on'];
  assert.ok(input, 'the workflow takes a runs-on input');
  assert.equal(input.type, 'string');
  assert.equal(input.default, 'ubuntu-latest');
  const jobs = Object.entries(workflow.jobs);
  assert.deepEqual(jobs.map(([name]) => name).sort(), ['archive', 'archive-rehearsal', 'canonical-guard']);
  for (const [name, job] of jobs) {
    assert.deepEqual(runnerFor(job['runs-on'], '["self-hosted", "my-mac"]'), ['self-hosted', 'my-mac'], name);
    // A list with space or a line break around it, as YAML can leave one, is still a list.
    assert.deepEqual(runnerFor(job['runs-on'], ' ["self-hosted", "my-mac"]'), ['self-hosted', 'my-mac'], name);
    assert.deepEqual(runnerFor(job['runs-on'], '\n["self-hosted", "my-mac"]\n'), ['self-hosted', 'my-mac'], name);
    assert.equal(runnerFor(job['runs-on'], 'my-runner'), 'my-runner', name);
    assert.equal(runnerFor(job['runs-on'], input.default), 'ubuntu-latest', name);
  }
});

// spec: change-archival / Archived on merge
test('the openspec archive job reads merged pull requests with the workflow token, so a squashed slice still archives, and pull request jobs are read-only', async t => {
  const workflow = parse(readFileSync(join(kit, '.github/workflows/openspec.yml'), 'utf8'));
  const job = workflow.jobs.archive;
  assert.deepEqual(job.permissions, { contents: 'write', 'pull-requests': 'read' });
  // This repository's caller grants what the job asks for; a reusable workflow gets no more.
  const caller = parse(readFileSync(join(kit, '.github/workflows/archive.yml'), 'utf8'));
  assert.deepEqual(caller.permissions, { contents: 'write', 'pull-requests': 'read' });
  const step = job.steps.find(item => item.run?.includes('specs archive --ready'));
  assert.equal(step.env?.GH_TOKEN, '${{ github.token }}');
  // The pull request jobs, one of which runs the pull request's own code, are read-only whatever the
  // caller grants, and leave no credentials in the checkout.
  for (const name of ['canonical-guard', 'archive-rehearsal']) {
    const pullRequestJob = workflow.jobs[name];
    assert.deepEqual(pullRequestJob.permissions, { contents: 'read' }, name);
    const checkouts = pullRequestJob.steps.filter(item => item.uses?.startsWith('actions/checkout@'));
    assert.ok(checkouts.length, name);
    for (const checkout of checkouts) assert.equal(checkout.with?.['persist-credentials'], false, name);
  }
  // The slice landed by a squash whose message lost its trailers; only the pull request description
  // carries them. The fake gh, like gh in a workflow, answers only with a token.
  const { base, root, env, git, change, commit } = await fixture(t);
  await change('radius', '- [x] Store\n', { 'slices.yaml': 'slices:\n  - id: store\n    implements: [locations / Radius]\n' });
  await commit('Store radius (#7)');
  const merged = (await git('rev-parse', 'HEAD')).stdout.trim();
  const prs = [{ number: 7, state: 'MERGED', headRefName: 'store', baseRefName: 'main', url: 'https://example.test/pr/7',
    body: 'Stores radius.\n\nOpenSpec-Change: radius\nOpenSpec-Slice: store\n', mergeCommit: { oid: merged } }];
  await writeFile(join(base, 'bin/gh'), `#!/bin/sh\n[ -n "$GH_TOKEN" ] || { echo 'gh: set the GH_TOKEN environment variable' >&2; exit 4; }\nprintf '%s\\n' '${JSON.stringify(prs)}'\n`);
  await chmod(join(base, 'bin/gh'), 0o755);
  const script = step.run.replace('${{ inputs.kit }}', `node ${join(kit, 'bin/hub.mjs')}`);
  const run = async stepEnv => {
    const output = join(base, 'output');
    await writeFile(output, '');
    const runEnv = { ...env, ...stepEnv, PATH: `${env.PATH}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: base, GITHUB_OUTPUT: output };
    if (!stepEnv.GH_TOKEN) { delete runEnv.GH_TOKEN; delete runEnv.GITHUB_TOKEN; }
    await exec('bash', ['-c', script], { cwd: root, env: runEnv });
    return readFile(output, 'utf8');
  };
  // Without the token, as the job ran before, the slice counts as unlanded and nothing archives.
  assert.equal(await run({}), 'names=\n');
  assert.equal(await run({ GH_TOKEN: step.env.GH_TOKEN.replace('${{ github.token }}', 'workflow-token') }), 'names=radius\n');
  assert.deepEqual(await readdir(join(root, 'openspec/changes')).then(names => names.filter(name => name !== 'archive')), []);
});

// The job's own script, run as the workflow runs it: the caller's `kit` input stands in for this checkout's CLI.
function rehearsalJob({ base, root }) {
  const job = parse(readFileSync(join(kit, '.github/workflows/openspec.yml'), 'utf8')).jobs['archive-rehearsal'];
  const script = job.steps.find(step => step.run?.includes('specs archive --rehearse')).run;
  const run = () => exec('bash', ['-c', script.replace('${{ inputs.kit }}', `node ${join(kit, 'bin/hub.mjs')}`)],
    { cwd: root, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: base, TMPDIR: join(base, 'tmp') } })
    .then(({ stdout }) => ({ code: 0, stdout }), error => ({ code: error.code, stdout: error.stdout }));
  return { job, script, run };
}

// spec: change-archival / Rehearsal in a pull request
test('the openspec workflow rehearses on pull requests and fails naming the change, spec and requirement', async t => {
  const { change, commit, root, base } = await fixture(t);
  const { job, script, run } = rehearsalJob({ base, root });
  assert.equal(job.if, "github.event_name == 'pull_request'");
  assert.deepEqual(job.steps.filter(step => step.uses).map(step => step.uses), ['actions/checkout@v4', 'actions/setup-node@v4']);
  assert.equal(job.steps.find(step => step.uses === 'actions/setup-node@v4').with['node-version'], '${{ inputs.node-version }}');
  assert.ok(!/inputs\.(test|setup)/.test(JSON.stringify(job)), 'a rehearsal needs no tests, setup or browsers');
  assert.ok(script.includes('specs archive --rehearse'));
  await change('radius', '- [ ] Build radius\n', { 'specs/locations/spec.md': `## ADDED Requirements\n${longRequirement('Radius')}` });
  await commit();
  const failing = await run();
  assert.notEqual(failing.code, 0);
  assert.match(failing.stdout, /^::error::Change radius would not archive cleanly: locations, requirement Radius, requirements\[1\]: .*500 characters/m);
  await rm(join(root, 'openspec/changes/radius'), { recursive: true });
  await change('ordering', '- [ ] Build ordering\n');
  await commit();
  const passing = await run();
  assert.equal(passing.code, 0, passing.stdout);
  assert.doesNotMatch(passing.stdout, /::error::/);
});

// A capability directory is user data. Named with a newline and a workflow command, it reaches an OpenSpec
// refusal message, and an annotation that printed it raw would end its line and start another command.
// spec: change-archival / Rehearsal in a pull request
test('the openspec workflow escapes what it prints, so a hostile capability name injects no workflow command', async t => {
  const { change, commit, root, base } = await fixture(t);
  const { run } = rehearsalJob({ base, root });
  await change('bad', '- [ ] Build bad\n');
  await rm(join(root, 'openspec/changes/bad/specs'), { recursive: true });
  await put(root, 'openspec/changes/bad/specs/locations\n::warning::Injected annotation\n/spec.md', `## MODIFIED Requirements\n${requirement('Search')}`);
  await commit();
  const { code, stdout } = await run();
  assert.notEqual(code, 0);
  const lines = stdout.split('\n');
  assert.ok(!lines.some(line => /^::warning/.test(line)), stdout);
  // Every line that starts a command: the fence around the raw dump, and the one escaped annotation.
  const commands = lines.filter(line => line.startsWith('::'));
  assert.equal(commands.length, 3, stdout);
  const token = commands[0].match(/^::stop-commands::(\S+)$/)?.[1];
  assert.ok(token, 'the dump is fenced with stop-commands');
  assert.equal(commands[1], `::${token}::`);
  assert.match(commands[2], /^::error::Change bad would not archive cleanly: OpenSpec archive failed: locations%0A::warning::Injected annotation%0A: target spec does not exist/);
  assert.ok(lines.indexOf(commands[0]) < lines.findIndex(line => line.startsWith('{')) && lines.findIndex(line => line.startsWith('{')) < lines.indexOf(commands[1]));
});

// spec: change-archival / A change that would not archive cleanly
test('a change whose archive dies midway leaves nothing behind for the changes after it', async t => {
  const { root, change, commit } = await fixture(t);
  await change('alpha', '- [ ] Build alpha\n');
  await change('beta', '- [ ] Build beta\n');
  await commit();
  // OpenSpec killed mid-archive (its call timing out, say): a canonical file written, the archive claim still held.
  const open = scratch => Object.assign(Object.create(openSpec(scratch)), {
    async archive(name) {
      if (name !== 'alpha') return Object.getPrototypeOf(this).archive(name);
      await put(scratch, 'openspec/specs/locations/spec.md', 'half written');
      await put(scratch, 'openspec/changes/archive/.openspec-archive.lock', '{}');
      throw new Error('OpenSpec archive failed: timed out');
    },
  });
  const before = await hashes(root);
  const result = await rehearseArchive(root, openSpec(root), root, open);
  assert.deepEqual(result.changes.map(item => [item.name, item.issues.length]), [['alpha', 1], ['beta', 0]]);
  assert.match(result.changes[0].issues[0].message, /timed out/);
  assert.deepEqual([result.baseline, result.valid], [[], false]);
  assert.deepEqual(await hashes(root), before);
});

// spec: change-archival / A clean rehearsal
test('rehearse of a pure rename reports an issue the requirement already had as baseline, not as the rename\'s', async t => {
  const { root, change, commit, cli } = await fixture(t);
  const spec = 'openspec/specs/locations/spec.md';
  await put(root, spec, (await readFile(join(root, spec), 'utf8')).replace(requirement('Search'), longRequirement('Search')));
  await change('rename', '- [ ] Build rename\n', { 'specs/locations/spec.md': '## RENAMED Requirements\n- FROM: `### Requirement: Search`\n- TO: `### Requirement: Lookup`\n' });
  await commit();
  const { code, json } = await cli('specs', 'archive', '--rehearse');
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(issueOf(json.baseline, 'spec', 'requirement'), [['locations', 'Search']]);
  assert.deepEqual([json.changes, json.valid], [[{ name: 'rename', issues: [] }], true]);
  // Only the rename's own carry-over is forgiven: a later change adding an issue is still blamed for it.
  await change('widen', '- [ ] Build widen\n', { 'specs/locations/spec.md': `## ADDED Requirements\n${longRequirement('Widest')}` });
  await commit();
  const again = await cli('specs', 'archive', '--rehearse');
  assert.deepEqual(again.json.changes.map(item => [item.name, issueOf(item.issues, 'requirement')]), [['rename', []], ['widen', [['Widest']]]]);
});

// Holds each OpenSpec archive for a while, so a signal can be sent while a rehearsal is under way.
const slowArchive = `
if (/openspec\\.js$/.test(process.argv[1] ?? '') && process.argv.includes('archive')) {
  require('node:fs').writeFileSync(process.env.ARCHIVE_PIDFILE, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (condition, what) => {
  for (let waited = 0; waited < 20000; waited += 20) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(`timed out waiting for ${what}`);
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  // spec: change-archival / A clean rehearsal
  test(`${signal} during a rehearsal removes the scratch copy, stops OpenSpec and ends the process by that signal`, async t => {
    const { base, root, env, change, commit } = await fixture(t);
    await change('alpha', '- [ ] Build alpha\n');
    await commit();
    await put(base, 'slow.cjs', slowArchive);
    const pidfile = join(base, 'archive.pid');
    const child = spawn(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, 'specs', 'archive', '--rehearse'],
      { env: { ...env, NODE_OPTIONS: `--require ${join(base, 'slow.cjs')}`, ARCHIVE_PIDFILE: pidfile }, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', (code, name) => resolve({ code, name })));
    let pid;
    t.after(() => { child.kill('SIGKILL'); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); });
    await until(() => readFile(pidfile, 'utf8').then(text => { pid = Number(text); return pid; }, () => false), 'OpenSpec to start archiving');
    assert.equal((await readdir(join(base, 'tmp'))).length, 1, 'the scratch copy exists while the rehearsal runs');
    child.kill(signal);
    assert.equal((await exited).name, signal);
    assert.deepEqual(await readdir(join(base, 'tmp')), []);
    await until(() => !alive(pid), 'OpenSpec to be stopped');
  });
}
