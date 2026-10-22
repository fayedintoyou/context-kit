import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, chmod } from 'node:fs/promises';
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
// `plain` a change without a plan. PATH holds only git, so no real gh is asked about pull requests;
// with `gh`, a fake gh answers every call with the pull requests last given to `pulls`.
async function fixture(t, { unplanned = false, plain = false, gh = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-links-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  const pullsFile = join(base, 'pulls.json');
  const pulls = list => writeFile(pullsFile, JSON.stringify(list));
  if (gh) {
    await pulls([]);
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec /bin/cat '${pullsFile}'\n`);
    await chmod(join(bin, 'gh'), 0o755);
  }
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
  const gitIn = (cwd, ...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, env });
  const git = (...args) => gitIn(root, ...args);
  // A test file linking the given scenarios of `locations`, always including the canonical one.
  const link = async (...names) => put(root, 'test/e2e/locations.test.mjs',
    ['Search', ...names].map(name => `// spec: locations / Use ${name}\ntest('uses ${name}', () => {});\n`).join('\n'));
  await link();
  await git('init', '-q', '-b', 'main');
  await git('add', '.');
  await git('commit', '-qm', 'Propose deliver');
  const land = async (slice, where = root) => {
    await put(where, `src/${slice}.mjs`, `export const ${slice} = true;\n`);
    await gitIn(where, 'add', '.');
    await gitIn(where, 'commit', '-qm', `Build ${slice}\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: ${slice}\n`);
  };
  // A CI-like checkout: a clone detached at `at`, with origin's branches but no local branch and
  // no origin/HEAD, as actions/checkout leaves a pull request's merge commit.
  const detachedClone = async (at = 'origin/main') => {
    const dir = join(base, 'ci');
    await exec('git', ['clone', '-q', `file://${root}`, dir], { env });
    await gitIn(dir, 'checkout', '-q', '--detach', at);
    const branches = (await gitIn(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).stdout.split('\n').filter(Boolean);
    if (branches.length) await gitIn(dir, 'branch', '-q', '-D', ...branches);
    await gitIn(dir, 'remote', 'set-head', 'origin', '-d').catch(() => {});
    assert.equal((await gitIn(dir, 'for-each-ref', 'refs/heads', 'refs/remotes/origin/HEAD')).stdout, '');
    return dir;
  };
  const check = async (where = root) => {
    try { return { code: 0, ...await exec(process.execPath, [join(kit, 'scripts/spec-links.mjs'), where], { env }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const cli = async (...args) => {
    try { return JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env })).stdout); }
    catch (error) { return JSON.parse(error.stderr || error.stdout); }
  };
  return { base, root, env, git, gitIn, link, land, detachedClone, check, cli, pulls };
}
const missing = (stderr, name) => stderr.includes(`scenario "locations / Use ${name}" has no linked test`);
const unrecorded = 'slice storage has landed on main, but this tree has no record of that landing; if the branch is behind main, update it (rebase/merge main) and re-run; otherwise link the test';
const behind = (stderr, name) => stderr.includes(`scenario "locations / Use ${name}" has no linked test — ${unrecorded}`);
const commitAll = async (git, message) => { await git('add', '.'); await git('commit', '-qm', message); };

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
  const { git, gitIn, link, land, detachedClone, check } = await fixture(t);
  await git('checkout', '-qb', 'api-work');
  await land('api');
  await git('checkout', '-q', 'main');
  // A CI checkout with only origin/main, whose slice commit is reachable from nothing but HEAD.
  const ci = await detachedClone();
  await land('storage', ci);
  let result = await check(ci);
  assert.equal(result.code, 1, result.stdout);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);
  assert.ok(!missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stdout, /^○ locations \/ Use Ordering {2}pending: deliver slice api not started$/m);
  // A tag named main at HEAD is no base: origin/main still is.
  await gitIn(ci, 'tag', 'main');
  result = await check(ci);
  assert.equal(result.code, 1, result.stdout);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);

  await git('checkout', '-qb', 'storage-work');
  await land('storage');
  result = await check();
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
  const { git, link, land, detachedClone, check } = await fixture(t);
  await land('storage');
  let result = await check();
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);
  assert.match(result.stdout, /^○ locations \/ Use Ordering/m);
  // A checkout older than the fetched origin/main, as when main moved past a pull request's merge commit.
  result = await check(await detachedClone('origin/main~1'));
  assert.equal(result.code, 1, result.stdout);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);
  await link('Radius');
  await git('add', '.');
  await git('commit', '-qm', 'Link radius');
  result = await check();
  assert.equal(result.code, 0, result.stderr);
});

// spec: change-progress / Branch behind a landed slice
test('a branch behind a landed slice still fails, saying the tree has no record of the landing', async t => {
  const { root, git, gitIn, link, land, detachedClone, check } = await fixture(t);
  await git('checkout', '-qb', 'work');
  await put(root, 'docs/work.md', 'Unrelated work.\n');
  await commitAll(git, 'Unrelated work');
  const before = (await git('rev-parse', 'main')).stdout.trim();
  await git('checkout', '-q', 'main');
  await land('storage');
  await git('checkout', '-q', 'work');
  let result = await check();
  assert.equal(result.code, 1, result.stdout);
  assert.ok(behind(result.stderr, 'Radius'), result.stderr);
  assert.ok(!missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stdout, /^✖ locations \/ Use Radius {2}no landing record: deliver slice storage landed on main; if the branch is behind, update it$/m);
  // A re-run of a pull request's merge ref made before storage landed.
  const ci = await detachedClone(before);
  await gitIn(ci, 'merge', '-q', '--no-ff', '-m', 'Merge work into main', 'origin/work');
  await assert.rejects(gitIn(ci, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'));
  result = await check(ci);
  assert.equal(result.code, 1, result.stdout);
  assert.ok(behind(result.stderr, 'Radius'), result.stderr);
  // Updated, the branch contains the landing: the plain failure, which a linked test fixes.
  await git('rebase', '-q', 'main');
  result = await check();
  assert.equal(result.code, 1, result.stdout);
  assert.ok(missing(result.stderr, 'Radius') && !result.stderr.includes('no record of that landing'), result.stderr);
  await git('checkout', '-q', '-b', 'fresh', 'main');
  await link('Radius');
  await commitAll(git, 'Link radius');
  result = await check();
  assert.equal(result.code, 0, result.stderr);
});

// spec: change-progress / Landing rewritten out of a branch
test('a branch that rewrites a landed slice without trailers and drops its test fails', async t => {
  const { root, git, link, land, check } = await fixture(t);
  await link('Radius');
  await land('storage');
  assert.equal((await check()).code, 0);
  await git('checkout', '-qb', 'rewrite');
  await git('reset', '-q', '--soft', 'HEAD~1');
  await link();
  await commitAll(git, 'Build storage');
  await assert.rejects(git('merge-base', '--is-ancestor', 'main', 'HEAD'));
  let result = await check();
  assert.equal(result.code, 1, result.stdout);
  // The tree has the code, so the report states only what it knows, and says to link the test.
  assert.ok(behind(result.stderr, 'Radius'), result.stderr);
  // The same with the code cherry-picked, without trailers, onto a branch from before the landing.
  await git('checkout', '-q', '-b', 'picked', 'main~1');
  await git('cherry-pick', '-n', 'main');
  await link();
  await commitAll(git, 'Storage, picked');
  result = await check();
  assert.equal(result.code, 1, result.stdout);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);
});

// spec: change-progress / Squashed landing without a merge commit
test('a squashed landing gh gives no merge commit for still fails, without the missing-record hint', async t => {
  const { root, git, check, pulls } = await fixture(t, { gh: true });
  await put(root, 'src/storage.mjs', 'export const storage = true;\n');
  await commitAll(git, 'Build storage (#7)');
  await pulls([{ number: 7, state: 'MERGED', headRefName: 'storage-work', baseRefName: 'main', url: 'https://example.test/pull/7',
    body: 'Radius search.\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage\n', mergeCommit: null }]);
  const result = await check();
  assert.equal(result.code, 1, result.stdout);
  assert.ok(missing(result.stderr, 'Radius'), result.stderr);
  assert.ok(!result.stderr.includes('no record of that landing'), result.stderr);
  assert.ok(!missing(result.stderr, 'Ordering'), result.stderr);
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
test('a shallow clone, no default branch, a base that is no branch or an invalid plan requires every scenario of the change and says why', async t => {
  const { base, root, env, git, land, detachedClone, check } = await fixture(t);
  const clone = join(base, 'shallow');
  await exec('git', ['clone', '-q', '--depth', '1', `file://${root}`, clone], { env });
  let result = await check(clone);
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius') && missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stderr, /deliver: every scenario is required, since slice progress can't be read: the clone is shallow/);

  await git('branch', '-m', 'main', 'trunk');
  result = await check();
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius') && missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stderr, /deliver: every scenario is required, .*no default branch was found .*so trunk is no base/);
  await git('branch', '-m', 'trunk', 'main');

  // A plan base that is no branch, such as HEAD, would hide a slice built on HEAD.
  const ci = await detachedClone();
  await land('storage', ci);
  await put(ci, 'openspec/changes/deliver/slices.yaml', `base: HEAD\n${plan}`);
  result = await check(ci);
  assert.equal(result.code, 1);
  assert.ok(missing(result.stderr, 'Radius') && missing(result.stderr, 'Ordering'), result.stderr);
  assert.match(result.stderr, /deliver: every scenario is required, .*Base branch not found: HEAD/);

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
