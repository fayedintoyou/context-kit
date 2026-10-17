import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, realpath, symlink, chmod } from 'node:fs/promises';
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
// The fake gh for parties answers only for the repository it is asked about with -R, and refuses
// the default one (GH_REPO or the checkout's), logging every call.
function partyGh(repositories, log) {
  return ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, "repository=''",
    'while [ $# -gt 0 ]; do if [ "$1" = -R ]; then repository=$2; fi; shift; done', 'case "$repository" in',
    ...Object.entries(repositories).map(([name, list]) => `  '${name}') printf '%s\\n' '${JSON.stringify(list)}' ;;`),
    '  *) echo "fake gh: refusing ${repository:-the default repository $GH_REPO}" >&2; exit 1 ;;', 'esac', ''].join('\n');
}
// PATH holds only git and, when a test asks for it, a fake gh, so a real gh never reaches GitHub.
// gh is either one pull request list, whatever gh is asked, or lists by -R repository for parties.
async function fixture(t, { slices = plan, gh } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-progress-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  if (gh) {
    await writeFile(join(bin, 'gh'), Array.isArray(gh) ? `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(gh)}'\n` : partyGh(gh, join(base, 'gh.log')));
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
// A store's slices each land in a party it declares (fictional upstreams, never fetched).
const parties = 'parties:\n  site: https://github.com/example/site\n  game: https://github.com/example/game\n';
const storePlan = plan.replace('  - id: storage\n', '  - id: storage\n    repo: game\n')
  .replace('  - id: api\n', '  - id: api\n    repo: site\n').replace('  - id: client\n', '  - id: client\n    repo: site\n');
// A party checkout recorded with `repos locate`. Its remotes carry fictional upstream URLs, each
// backed by a bare repository with the given default branch. Only the fixture's own git reaches
// those, through an isolated insteadOf config; the CLI reads what the checkout already has.
async function partyCheckout({ base, env, cli }, name, remotes = { origin: [name, 'main'] }) {
  const config = join(base, 'parties.gitconfig');
  const run = (cwd, ...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, env: { ...env, GIT_CONFIG_GLOBAL: config } });
  const checkout = join(base, 'parties', name);
  await mkdir(checkout, { recursive: true });
  await run(checkout, 'init', '-q', '-b', 'main');
  await run(checkout, 'commit', '-q', '--allow-empty', '-m', `Start ${name}`);
  for (const [remote, [repository, branch]] of Object.entries(remotes)) {
    const bare = join(base, 'upstreams', `${repository}.git`);
    await mkdir(bare, { recursive: true });
    await run(bare, 'init', '-q', '--bare', '-b', branch);
    await appendFile(config, `[url "file://${bare}"]\n\tinsteadOf = https://github.com/example/${repository}\n`);
    await run(checkout, 'remote', 'add', remote, `https://github.com/example/${repository}`);
    await run(checkout, 'push', '-q', remote, `HEAD:refs/heads/${branch}`);
    await run(checkout, 'remote', 'set-head', remote, '--auto');
  }
  const located = await cli('repos', 'locate', `team/shared/${name}`, checkout);
  assert.equal(located.repository?.status, 'located', JSON.stringify(located));
  const git = (...args) => run(checkout, ...args);
  const rev = async ref => (await git('rev-parse', ref)).stdout.trim();
  // A slice commit with a qualified trailer by default, inside the slice's declared scope.
  const land = async (slice, change = 'shared:embed', file = `src/search/${slice}-${change.replace(/\W/g, '-')}.mjs`) => {
    await put(checkout, file, `export const built = ${JSON.stringify(`${change} ${slice}`)};\n`);
    await git('add', '.');
    await git('commit', '-qm', `Build ${slice}\n\nOpenSpec-Change: ${change}\n${slice ? `OpenSpec-Slice: ${slice}\n` : ''}`);
    return rev('HEAD');
  };
  return { checkout: await realpath(checkout), git, rev, land };
}
// The workspace's hub declares store `shared`: a git repository registered in the isolated
// OpenSpec registry that plans change `embed` across parties `site` and `game`. Store `stray`
// is registered but declared by no hub. The hub registers both parties' upstreams; the
// `located` ones have recorded checkouts, with `remotes` per party as partyCheckout takes them.
async function storeFixture(t, { located = ['site', 'game'], remotes = {}, gh, env: extra = {} } = {}) {
  const context = await fixture(t, { gh });
  const { base, env, root } = context;
  Object.assign(env, extra);
  await put(root, 'hubs/team/README.md', '---\ntype: Guide\n---\n\nTeam context\n');
  await put(root, 'hubs/team/hub.json', JSON.stringify({ version: 1, id: 'team/shared', description: 'Team',
    documents: ['README.md'], skills: [], links: [], specStores: ['shared'] }));
  for (const name of ['site', 'game']) {
    await put(root, `hubs/team/${name}.md`, `---\ntype: Repository\ntitle: ${name}\nresource: https://github.com/example/${name}\n---\n\n# ${name}\n`);
  }
  const store = join(base, 'shared-store');
  await put(store, 'openspec/config.yaml', 'schema: spec-driven\n');
  await put(store, 'openspec/specs/locations/spec.md', spec(requirement('Search', 'Use Search', 'The store SHALL describe search for every party.')));
  await put(store, 'openspec/changes/embed/proposal.md', '# Why\n\nEmbed radius search across parties.\n');
  await put(store, 'openspec/changes/embed/specs/locations/spec.md', delta);
  await put(store, 'openspec/parties.yaml', parties);
  await put(store, 'openspec/changes/embed/slices.yaml', storePlan);
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
  const checkouts = {};
  for (const name of located) checkouts[name] = await partyCheckout(context, name, remotes[name]);
  const client = new Client({ name: 'progress-store-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const mcp = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { ...context, store, storeGit: git, client, mcp, checkouts };
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
  const { root, store, storeGit, cli, client, mcp, checkouts: { site, game } } = await storeFixture(t);
  const head = (await storeGit('rev-parse', 'HEAD')).stdout.trim();
  const source = { kind: 'store', storeId: 'shared' };
  const status = await cli('specs', 'status', 'embed', '--store', 'shared');
  assert.equal(status.root, store);
  assert.deepEqual(status.source, source);
  assert.equal(status.change, 'embed');
  assert.deepEqual(states(status), { storage: 'ready', api: 'blocked', client: 'blocked' });
  // Evidence comes from each party's checkout, not from the store's own history.
  assert.equal(status.base, undefined);
  assert.deepEqual(status.repos.map(repo => [repo.party, repo.base.commit]), [['site', await site.rev('HEAD')], ['game', await game.rev('HEAD')]]);
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
  assert.deepEqual([packet.root, packet.source, packet.base.commit], [store, source, await site.rev('HEAD')]);
  assert.equal(packet.requirements.find(item => item.id === 'locations / Search').canonical.text, 'The store SHALL describe search for every party.');
  assert.equal(packet.trailers, 'OpenSpec-Change: shared:embed\nOpenSpec-Slice: api');
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

// spec: change-progress / Plan across party repositories
test('a store plan lists each slice with its party and upstream', async t => {
  const { cli, mcp, checkouts: { site, game } } = await storeFixture(t);
  const status = await cli('specs', 'status', 'embed', '--store', 'shared');
  assert.deepEqual(status.slices.map(slice => [slice.id, slice.repo]), [
    ['storage', { party: 'game', upstream: 'https://github.com/example/game', checkout: game.checkout }],
    ['api', { party: 'site', upstream: 'https://github.com/example/site', checkout: site.checkout }],
    ['client', { party: 'site', upstream: 'https://github.com/example/site', checkout: site.checkout }]]);
  assert.deepEqual(states(status), { storage: 'ready', api: 'blocked', client: 'blocked' });
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), status);
  // A repository's slices land in the repository itself and name no party.
  assert.ok((await cli('specs', 'status', 'deliver')).slices.every(slice => !('repo' in slice)));
});

// spec: change-progress / Unknown party
test('store slices must name a declared party and repository slices none', async t => {
  const { root, store, env, cli, mcp } = await storeFixture(t);
  const file = /openspec\/changes\/embed\/slices\.yaml: /;
  const cases = [
    [storePlan.replace('repo: site', 'repo: mobile'), /slice api names repo mobile, a party openspec\/parties\.yaml does not declare/],
    [storePlan.replace('    repo: game\n', ''), /slice storage names no repo/],
  ];
  for (const [content, message] of cases) {
    await put(store, 'openspec/changes/embed/slices.yaml', content);
    for (const call of [cli('specs', 'status', 'embed', '--store', 'shared'), mcp('change_status', { change: 'embed', store: 'shared' }),
      cli('specs', 'next', 'embed', '--store', 'shared'), mcp('read_slice', { change: 'embed', slice: 'client', store: 'shared' })]) {
      const result = await call;
      assert.equal(result.error?.code, 'INVALID_CONFIG', JSON.stringify(result));
      assert.match(result.error.message, file);
      assert.match(result.error.message, message);
    }
    const [embed] = (await cli('specs', 'archivable', '--store', 'shared')).changes;
    assert.equal(embed.plan, 'invalid');
    assert.ok(embed.blockers.some(blocker => message.test(blocker.message ?? '')), JSON.stringify(embed));
  }
  // A malformed repo names its slice.
  for (const [value, slice] of [['Mobile', 'api'], ['null', 'api'], ['""', 'api']]) {
    await put(store, 'openspec/changes/embed/slices.yaml', storePlan.replace('repo: site', `repo: ${value}`));
    for (const result of [await cli('specs', 'status', 'embed', '--store', 'shared'), await mcp('change_status', { change: 'embed', store: 'shared' })]) {
      assert.equal(result.error?.code, 'INVALID_CONFIG', JSON.stringify(result));
      assert.match(result.error.message, new RegExp(`slices\\.yaml: slice ${slice} repo: `));
    }
  }
  // A store maintained in place (--root <store>) is still a store: its identity file says so.
  await put(store, 'openspec/changes/embed/slices.yaml', storePlan);
  const inPlace = (...args) => exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', store, ...args], { env })
    .then(({ stdout }) => JSON.parse(stdout), error => JSON.parse(error.stderr || error.stdout));
  assert.deepEqual((await inPlace('specs', 'status', 'embed')).slices.map(slice => slice.repo?.party), ['game', 'site', 'site']);
  await put(store, 'openspec/changes/embed/slices.yaml', storePlan.replace('    repo: game\n', ''));
  assert.match((await inPlace('specs', 'status', 'embed')).error?.message ?? '', /slice storage names no repo/);
  // A store without a parties file declares no party for a slice to name.
  await put(store, 'openspec/changes/embed/slices.yaml', storePlan);
  await rm(join(store, 'openspec/parties.yaml'));
  const missing = await cli('specs', 'status', 'embed', '--store', 'shared');
  assert.equal(missing.error?.code, 'INVALID_CONFIG');
  assert.match(missing.error.message, file);
  assert.match(missing.error.message, /slice storage names repo game, a party openspec\/parties\.yaml does not declare/);
  // A repository plan naming any repo fails the same way, whether or not it has a parties file.
  await put(root, 'openspec/parties.yaml', parties);
  await put(root, 'openspec/changes/deliver/slices.yaml', plan.replace('  - id: client\n', '  - id: client\n    repo: site\n'));
  for (const call of [cli('specs', 'status', 'deliver'), mcp('change_status', { change: 'deliver' })]) {
    const result = await call;
    assert.equal(result.error?.code, 'INVALID_CONFIG', JSON.stringify(result));
    assert.match(result.error.message, /openspec\/changes\/deliver\/slices\.yaml: slice client names repo site/);
  }
});

const upstream = name => `https://github.com/example/${name}`;
const status = (cli, ...args) => cli('specs', 'status', 'embed', '--store', 'shared', ...args);

// spec: change-progress / Slice landed in another repository
test('a store slice lands from its qualified trailer on its party checkout default branch', async t => {
  const { cli, mcp, checkouts: { site, game } } = await storeFixture(t);
  const commit = await game.land('storage');
  // Committed but not pushed: the party's base is its remote's tip, so the slice is only in progress.
  const local = await status(cli);
  assert.deepEqual(states(local), { storage: 'in_progress', api: 'blocked', client: 'blocked' });
  assert.deepEqual(local.slices[0].branches, ['main']);
  await game.git('push', '-q', 'origin', 'main');
  const result = await status(cli);
  assert.deepEqual(states(result), { storage: 'landed', api: 'ready', client: 'blocked' });
  const [storage] = result.slices;
  assert.deepEqual(storage.repo, { party: 'game', upstream: upstream('game'), checkout: game.checkout });
  assert.deepEqual(storage.commits.map(item => [item.sha, item.landed]), [[commit, true]]);
  assert.equal(requirementStates(result)['locations / Radius'], 'landed');
  assert.deepEqual(result.repos, [
    { party: 'site', upstream: upstream('site'), checkout: site.checkout, remote: 'origin',
      base: { ref: 'main', refs: ['origin/main'], commit: await site.rev('origin/main') }, pullRequests: { status: 'not_collected', reason: 'gh is not installed' } },
    { party: 'game', upstream: upstream('game'), checkout: game.checkout, remote: 'origin',
      base: { ref: 'main', refs: ['origin/main'], commit }, pullRequests: { status: 'not_collected', reason: 'gh is not installed' } }]);
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), result);
  // The landed dependency appears in the ready slice's packet.
  const next = await cli('specs', 'next', 'embed', '--store', 'shared');
  assert.deepEqual(next.packets.map(packet => [packet.slice.id, packet.dependencies]), [['api', [{ id: 'storage', state: 'landed', commits: [commit] }]]]);
});

// spec: change-progress / Same change name elsewhere
test('a party commit for another change of the same name never counts for the store change', async t => {
  const { cli, mcp, checkouts: { game } } = await storeFixture(t);
  await game.land('storage', 'embed');
  await game.land('storage', 'other:embed');
  const stray = await game.land('caching');
  await game.git('push', '-q', 'origin', 'main');
  const result = await status(cli);
  assert.deepEqual(states(result), { storage: 'ready', api: 'blocked', client: 'blocked' });
  assert.deepEqual([result.slices[0].commits, result.slices[0].branches], [[], []]);
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), result);
  // Only the store's own qualified trailers are reconciled: the caching commit is stray, the others are not this change's.
  const report = await cli('specs', 'reconcile', 'embed', '--store', 'shared');
  assert.deepEqual(report.strayTrailers.map(item => [item.sha, item.slice]), [[stray, 'caching']]);
  assert.deepEqual(await mcp('reconcile_change', { change: 'embed', store: 'shared' }), report);
});

// spec: change-progress / No checkout for a party
test('a party with no recorded checkout leaves its slices unknown with remedies', async t => {
  const context = await storeFixture(t, { located: ['site'] });
  const { cli, mcp, checkouts: { site } } = context;
  const result = await status(cli);
  assert.deepEqual(states(result), { storage: 'unknown', api: 'blocked', client: 'blocked' });
  const [storage, api] = result.slices;
  assert.deepEqual([storage.repo, storage.reason, storage.remedies], [{ party: 'game', upstream: upstream('game'), checkout: null }, 'checkout_missing',
    ['repos locate team/shared/game <path>', 'repos clone team/shared/game [<path>]']]);
  assert.deepEqual(api.blockedBy, ['storage']);
  assert.deepEqual(result.repos.map(({ party, checkout, reason }) => [party, checkout, reason]), [['site', site.checkout, undefined], ['game', null, 'checkout_missing']]);
  // The requirement is never landed; with nothing landed or in progress it is unstarted.
  assert.equal(requirementStates(result)['locations / Radius'], 'unstarted');
  assert.deepEqual(result.totals, { slices: { landed: 0, total: 3 }, requirements: { landed: 0, total: 3 }, readyToReconcile: false });
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), result);
  const next = await cli('specs', 'next', 'embed', '--store', 'shared');
  assert.deepEqual([next.packets, next.reason], [[], 'nothing_ready']);
  assert.deepEqual(next.waiting.map(({ id, state, reason }) => [id, state, reason]), [['storage', 'unknown', 'checkout_missing'], ['api', 'blocked', undefined], ['client', 'blocked', undefined]]);
  assert.deepEqual(await mcp('next_slices', { change: 'embed', store: 'shared' }), next);
  // Following a remedy makes the party's evidence readable.
  await partyCheckout(context, 'game');
  assert.deepEqual(states(await status(cli)), { storage: 'ready', api: 'blocked', client: 'blocked' });
});

// spec: change-progress / Fork checkout
// spec: change-progress / No checkout for a party
// spec: change-progress / Party remote not fetched
test('a party checkout with no remote for its upstream leaves its slices unknown', async t => {
  const { cli, mcp, checkouts: { game } } = await storeFixture(t);
  const checkout = game.checkout;
  await game.land('storage');
  assert.equal(states(await status(cli)).storage, 'in_progress');
  // Without the party remote, the unpushed commit on the local main is not taken for landed.
  await game.git('remote', 'remove', 'origin');
  const result = await status(cli);
  assert.deepEqual(states(result), { storage: 'unknown', api: 'blocked', client: 'blocked' });
  const [storage, api] = result.slices;
  assert.deepEqual([storage.repo, storage.reason, storage.remedies, storage.commits], [{ party: 'game', upstream: upstream('game'), checkout }, 'remote_missing',
    [`git -C ${checkout} remote add <remote> ${upstream('game')}`, `git -C ${checkout} fetch <remote>`], []]);
  assert.deepEqual(api.blockedBy, ['storage']);
  assert.deepEqual(result.repos.find(repo => repo.party === 'game'), { party: 'game', upstream: upstream('game'), checkout, reason: 'remote_missing' });
  assert.equal(requirementStates(result)['locations / Radius'], 'unstarted');
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), result);
  const next = await cli('specs', 'next', 'embed', '--store', 'shared');
  assert.deepEqual([next.packets, next.waiting[0].reason], [[], 'remote_missing']);
  assert.deepEqual(await mcp('next_slices', { change: 'embed', store: 'shared' }), next);
  // A remote for another repository, such as a fork, is no substitute.
  await game.git('remote', 'add', 'origin', upstream('game-fork'));
  assert.equal(states(await status(cli)).storage, 'unknown');
  // With the party remote back but not yet fetched, there is no tip to judge by: unknown, never landed.
  await game.git('remote', 'set-url', 'origin', upstream('game'));
  const unfetched = await status(cli);
  assert.deepEqual([states(unfetched).storage, states(unfetched).api], ['unknown', 'blocked']);
  const stalled = unfetched.slices.find(slice => slice.id === 'storage');
  assert.deepEqual([stalled.reason, stalled.remedies], ['remote_not_fetched', [`git -C ${checkout} fetch origin`]]);
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), unfetched);
  // Fetched, its tip is the base again, and the unpushed commit is in progress.
  await game.git('fetch', '-q', 'origin');
  assert.equal(states(await status(cli)).storage, 'in_progress');
});

// spec: change-progress / Fork checkout
test('a fork checkout is judged against the party remote and asks gh about the party', async t => {
  const body = slice => `OpenSpec-Change: shared:embed\nOpenSpec-Slice: ${slice}\n`;
  const { base, cli, mcp, checkouts: { game } } = await storeFixture(t, {
    remotes: { game: { origin: ['game-fork', 'dev'], upstream: ['game', 'main'] } },
    env: { GH_REPO: 'example/game-fork' },
    gh: { 'example/site': [], 'example/game': [],
      'example/game-fork': [{ number: 1, state: 'MERGED', headRefName: 'storage', baseRefName: 'dev', body: body('storage'), url: 'https://example.test/fork/pr/1' }] } });
  await game.git('switch', '-q', '-c', 'dev', 'origin/dev');
  const commit = await game.land('storage');
  await game.git('push', '-q', 'origin', 'dev');
  const result = await status(cli);
  const [storage] = result.slices;
  assert.equal(storage.state, 'in_progress');
  assert.deepEqual([storage.commits.map(item => [item.sha, item.landed]), storage.branches, storage.pullRequests], [[[commit, false]], ['dev', 'origin/dev'], []]);
  const party = result.repos.find(repo => repo.party === 'game');
  assert.deepEqual([party.remote, party.base, party.pullRequests], ['upstream',
    { ref: 'main', refs: ['upstream/main'], commit: await game.rev('upstream/main') }, { status: 'collected' }]);
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), result);
  // gh is always named the party upstream, never left to its default (the fork).
  const calls = (await readFile(join(base, 'gh.log'), 'utf8')).trim().split('\n');
  assert.ok(calls.length >= 4 && calls.every(call => / -R example\/(site|game) /.test(call)), calls.join('\n'));
  // Once the commit reaches the party's main, it lands.
  await game.git('push', '-q', 'upstream', 'dev:main');
  await game.git('fetch', '-q', 'upstream');
  assert.equal(states(await status(cli)).storage, 'landed');
});

// spec: change-progress / Local base behind its remote
test('a party base is its remote tip even when the local branch is older', async t => {
  const { cli, mcp, checkouts: { game } } = await storeFixture(t);
  await put(game.checkout, 'test/embed.test.mjs', "// spec: shared:locations / Use Radius\ntest('radius', () => {});\n");
  const commit = await game.land('storage');
  await game.git('push', '-q', 'origin', 'main');
  await game.git('reset', '-q', '--hard', 'HEAD~1');
  const result = await status(cli);
  assert.equal(states(result).storage, 'landed');
  const packet = await cli('specs', 'slice', 'embed', 'storage', '--store', 'shared');
  assert.deepEqual(packet.base, { ref: 'main', refs: ['origin/main'], commit });
  assert.deepEqual(packet.review.commits.map(item => item.sha), [commit]);
  assert.deepEqual(await mcp('read_slice', { change: 'embed', slice: 'storage', store: 'shared' }), packet);
  // Reconcile reads the landed commit in the party checkout, though the local main lacks it.
  // Reading the party's linked tests at that base arrives with the party-reconcile slice.
  const report = await cli('specs', 'reconcile', 'embed', '--store', 'shared');
  assert.deepEqual(report.slices.find(slice => slice.id === 'storage').files, ['src/search/storage-shared-embed.mjs', 'test/embed.test.mjs']);
});

// spec: change-progress / Same change name elsewhere
// spec: change-progress / Fork checkout
test('a party pull request counts only by its own trailers, never by a shared branch name', async t => {
  const pr = (number, body) => ({ number, state: 'MERGED', headRefName: 'dev', baseRefName: 'main', body, url: `https://example.test/pr/${number}` });
  const { cli, mcp, checkouts: { game } } = await storeFixture(t, {
    remotes: { game: { origin: ['game-fork', 'dev'], upstream: ['game', 'main'] } },
    gh: { 'example/site': [], 'example/game': [pr(42, 'OpenSpec-Change: other:embed\nOpenSpec-Slice: storage\n'),
      pr(43, 'OpenSpec-Change: shared:embed\n'), pr(44, 'Unrelated work.\n')] } });
  // The slice's only commit is on the fork's dev, the head branch name of unrelated party pull requests.
  await game.git('switch', '-q', '-c', 'dev', 'origin/dev');
  const commit = await game.land('storage');
  await game.git('push', '-q', 'origin', 'dev');
  const result = await status(cli);
  assert.deepEqual(states(result), { storage: 'in_progress', api: 'blocked', client: 'blocked' });
  const [storage] = result.slices;
  assert.deepEqual([storage.commits.map(item => [item.sha, item.landed]), storage.branches, storage.pullRequests], [[[commit, false]], ['dev', 'origin/dev'], []]);
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), result);
});

// spec: change-progress / Party pull request merged elsewhere
test('a party pull request lands a slice only when merged into the party base', async t => {
  const pr = (number, change, slice, baseRefName) => ({ number, state: 'MERGED', headRefName: slice, baseRefName,
    body: `OpenSpec-Change: ${change}\nOpenSpec-Slice: ${slice}\n`, url: `https://example.test/pr/${number}` });
  const { cli, mcp } = await storeFixture(t, { gh: {
    'example/game': [pr(3, 'shared:embed', 'storage', 'release')],
    'example/site': [pr(4, 'shared:embed', 'api', 'main'), pr(5, 'embed', 'client', 'main')] } });
  const result = await status(cli);
  assert.deepEqual(states(result), { storage: 'in_progress', api: 'landed', client: 'ready' });
  assert.deepEqual(result.slices.map(slice => slice.pullRequests), [
    [{ number: 3, state: 'MERGED', url: 'https://example.test/pr/3', baseRefName: 'release', landed: false }],
    [{ number: 4, state: 'MERGED', url: 'https://example.test/pr/4', baseRefName: 'main', landed: true }],
    []]);
  assert.deepEqual(result.repos.map(repo => repo.pullRequests), [{ status: 'collected' }, { status: 'collected' }]);
  assert.deepEqual(await mcp('change_status', { change: 'embed', store: 'shared' }), result);
});
