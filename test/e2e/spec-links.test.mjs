import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const kit = fileURLToPath(new URL('../../', import.meta.url));
const requirement = name => `### Requirement: ${name}\nThe service SHALL support ${name.toLowerCase()} for location callers.\n\n#### Scenario: Use ${name}\n- **WHEN** a caller uses ${name.toLowerCase()}\n- **THEN** it works\n`;
const plan = `slices:
  - id: storage
    implements: [locations / Radius]
  - id: api
    implements: [locations / Ordering]
    depends_on: [storage]
`;
async function put(root, path, content) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}
// A repository whose canonical `Use Search` is linked, with change `deliver` planned in slices
// `storage` (Radius) and `api` (Ordering); `unplanned` adds a requirement no slice names and
// `plain` a change without a plan. PATH holds only git, so no real gh is asked about pull requests.
async function fixture(t, { unplanned = false, plain = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-links-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  const env = { ...process.env, PATH: bin, HOME: base, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CONTEXT_KIT_ROOT;
  await put(root, 'openspec/config.yaml', 'schema: spec-driven\n');
  await put(root, 'openspec/specs/locations/spec.md', `# Locations\n\n## Purpose\nFind locations by text and radius for callers of the location service.\n\n## Requirements\n\n${requirement('Search')}`);
  await put(root, 'openspec/changes/deliver/proposal.md', '# Why\n\nDeliver radius search.\n');
  await put(root, 'openspec/changes/deliver/specs/locations/spec.md',
    `## ADDED Requirements\n${requirement('Radius')}\n${requirement('Ordering')}\n${unplanned ? requirement('Paging') : ''}`);
  await put(root, 'openspec/changes/deliver/slices.yaml', plan);
  if (plain) {
    await put(root, 'openspec/changes/plain/proposal.md', '# Why\n\nAdd filters.\n');
    await put(root, 'openspec/changes/plain/specs/locations/spec.md', `## ADDED Requirements\n${requirement('Filters')}`);
  }
  const git = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env });
  // A test file linking the given scenarios of `locations`, always including the canonical one.
  const link = async (...names) => put(root, 'test/e2e/locations.test.mjs',
    ['Search', ...names].map(name => `// spec: locations / Use ${name}\ntest('uses ${name}', () => {});\n`).join('\n'));
  await link();
  await git('init', '-q', '-b', 'main');
  await git('add', '.');
  await git('commit', '-qm', 'Propose deliver');
  const land = async slice => {
    await put(root, `src/${slice}.mjs`, `export const ${slice} = true;\n`);
    await git('add', '.');
    await git('commit', '-qm', `Build ${slice}\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: ${slice}\n`);
  };
  const check = async (where = root) => {
    try { return { code: 0, ...await exec(process.execPath, [join(kit, 'scripts/spec-links.mjs'), where], { env }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const cli = async (...args) => {
    try { return JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env })).stdout); }
    catch (error) { return JSON.parse(error.stderr || error.stdout); }
  };
  return { base, root, env, git, link, land, check, cli };
}
const missing = (stderr, name) => stderr.includes(`scenario "locations / Use ${name}" has no linked test`);

// spec: change-progress / Unstarted slices are pending
test('scenarios of unstarted slices are pending and do not fail the link check', async t => {
  const { check } = await fixture(t);
  const { code, stdout, stderr } = await check();
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^○ locations \/ Use Radius {2}pending: deliver slice storage not started$/m);
  assert.match(stdout, /^○ locations \/ Use Ordering {2}pending: deliver slice api not started$/m);
  assert.match(stdout, /^✔ locations \/ Use Search {2}\[e2e\] test\/e2e\/locations\.test\.mjs:1$/m);
});

// spec: change-progress / Slice on the current branch
test('a slice with a trailer commit on HEAD must link its scenarios, while other branches do not count', async t => {
  const { git, link, land, check } = await fixture(t);
  await git('checkout', '-qb', 'api-work');
  await land('api');
  await git('checkout', '-q', 'main');
  await git('checkout', '-qb', 'storage-work');
  await land('storage');
  let result = await check();
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);
  assert.ok(!missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stdout, /^○ locations \/ Use Ordering {2}pending: deliver slice api not started$/m);
  // A detached HEAD, as in a pull request's merge checkout, counts the same.
  await git('checkout', '-q', '--detach');
  assert.ok(missing((await check()).stderr, 'Radius'));
  await link('Radius');
  result = await check();
  assert.equal(result.code, 0, result.stderr);
});

// spec: change-progress / Landed slice
test('a landed slice must link its scenarios', async t => {
  const { git, link, land, check } = await fixture(t);
  await land('storage');
  let result = await check();
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);
  assert.match(result.stdout, /^○ locations \/ Use Ordering/m);
  await link('Radius');
  await git('add', '.');
  await git('commit', '-qm', 'Link radius');
  result = await check();
  assert.equal(result.code, 0, result.stderr);
});

// spec: change-progress / Requirement no slice implements
test('requirements no slice implements and changes without a plan stay required', async t => {
  const { check } = await fixture(t, { unplanned: true, plain: true });
  const { code, stdout, stderr } = await check();
  assert.equal(code, 1);
  assert.ok(missing(stderr, 'Paging'), stderr);
  assert.ok(missing(stderr, 'Filters'), stderr);
  assert.ok(!missing(stderr, 'Radius') && !missing(stderr, 'Ordering'), stderr);
  assert.match(stdout, /^✖ locations \/ Use Paging/m);
});

// spec: change-progress / Shallow clone
test('a shallow clone or an invalid plan requires every scenario of the change and says why', async t => {
  const { base, root, env, check } = await fixture(t);
  const clone = join(base, 'shallow');
  await exec('git', ['clone', '-q', '--depth', '1', `file://${root}`, clone], { env });
  let result = await check(clone);
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius') && missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stderr, /deliver: every scenario is required, since slice progress can't be read: the clone is shallow/);

  await put(root, 'openspec/changes/deliver/slices.yaml', plan.replace('depends_on: [storage]', 'depends_on: [client]'));
  result = await check();
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius') && missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stderr, /deliver: every scenario is required, .*slices\.yaml: slice api depends on unknown slice client/);
});

// spec: change-progress / Archive needs every link
test('pending scenarios are untested in reconcile, block archive, and are required once every slice lands', async t => {
  const { land, check, cli } = await fixture(t);
  assert.equal((await check()).code, 0);
  const report = await cli('specs', 'reconcile', 'deliver');
  assert.deepEqual(report.untested.scenarios.map(item => item.scenario).sort(), ['Use Ordering', 'Use Radius']);
  const readiness = (await cli('specs', 'archivable')).changes.find(change => change.name === 'deliver');
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers.find(blocker => blocker.code === 'slices_unlanded').slices, ['storage', 'api']);
  await land('storage');
  await land('api');
  const { code, stderr } = await check();
  assert.equal(code, 1);
  assert.ok(missing(stderr, 'Radius') && missing(stderr, 'Ordering'), stderr);
});
