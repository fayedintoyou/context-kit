import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

// A workspace on an isolated machine, with helpers to register repositories and make
// git checkouts whose remotes point wherever a test needs. No network.
async function fixture(t, ...initArgs) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-repos-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, ...gitEnv, HOME: join(base, 'home'), XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  delete env.CONTEXT_KIT_ROOT;
  await mkdir(env.HOME);
  const workspace = join(base, 'workspace');
  const run = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, error: JSON.parse(error.stderr).error }; }
  };
  assert.equal((await run('init', workspace, ...initArgs)).code, 0);
  const cli = (...args) => run('--root', workspace, ...args);
  const register = (hub, name, fields) => writeFile(join(workspace, 'hubs', hub, `${name}.md`),
    `---\ntype: Repository\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n# ${fields.title ?? name}\n`);
  const checkout = async (path, remotes = {}) => {
    await mkdir(path, { recursive: true });
    await exec('git', ['init', '-q'], { cwd: path });
    for (const [name, url] of Object.entries(remotes)) await exec('git', ['remote', 'add', name, url], { cwd: path });
    return realpath(path);
  };
  // The CLI with stdin piped from input (never a terminal), for setup's prompts.
  const cliInput = (input, ...args) => new Promise((done, failed) => {
    const child = spawn(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', failed);
    child.on('close', code => done(code === 0 ? { code, json: JSON.parse(stdout), stderr } : { code, error: JSON.parse(stderr.trim().split('\n').pop()).error, stderr }));
    child.stdin.end(input);
  });
  // A bare upstream with one commit, to clone from without a network.
  const upstream = async name => {
    const source = join(base, 'sources', name);
    await mkdir(source, { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: source });
    await writeFile(join(source, 'README.md'), `${name}\n`);
    await exec('git', ['add', '.'], { cwd: source });
    await exec('git', ['commit', '-qm', 'start'], { cwd: source, env });
    const bare = join(base, 'upstreams', `${name}.git`);
    await exec('git', ['clone', '-q', '--bare', source, bare]);
    return `file://${bare}`;
  };
  const commit = path => exec('git', ['commit', '-q', '--allow-empty', '-m', 'start'], { cwd: path, env });
  return { base, env, workspace, cli, cliInput, register, checkout, upstream, commit };
}
const exists = path => stat(path).then(() => true, () => false);

const STANDARD_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const points = text => [...text].length;
// A rendered skill checked against the Agent Skills frontmatter rules: standard keys only,
// a lowercase hyphenated name of at most 64 characters equal to its directory's, a
// description of 1 to 1,024 code points and string-to-string metadata.
async function agentSkill(directory) {
  const text = await readFile(join(directory, 'SKILL.md'), 'utf8');
  const front = parseYaml(text.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  assert.deepEqual(Object.keys(front).filter(key => !STANDARD_KEYS.includes(key)), [], 'standard keys only');
  assert.equal(front.name, basename(directory));
  assert.match(front.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(front.name.length <= 64);
  assert.equal(typeof front.description, 'string');
  assert.ok(points(front.description) >= 1 && points(front.description) <= 1024, `description is ${points(front.description)} code points`);
  if ('metadata' in front) {
    assert.ok(front.metadata && typeof front.metadata === 'object' && !Array.isArray(front.metadata));
    for (const [key, value] of Object.entries(front.metadata)) assert.equal(typeof value, 'string', `metadata ${key}`);
  }
  return { text, front, body: text.slice(text.indexOf('\n---\n') + 5) };
}

// spec: repository-registry / List registered repositories
test('repos lists every Repository concept once, across hubs', async t => {
  const { workspace, cli, register } = await fixture(t);
  await mkdir(join(workspace, 'hubs/work'));
  await writeFile(join(workspace, 'hubs/work/hub.json'), JSON.stringify({ version: 1, id: 'team/work', description: 'Work.', documents: ['README.md'], skills: [], links: [] }));
  await writeFile(join(workspace, 'hubs/work/README.md'), '---\ntype: Guide\n---\n\n# Work\n');
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/fayedintoyou/room', aliases: ['room', 'fayelore.com'] });
  await register('work', 'billing', { title: 'billing service', resource: 'git@github.com:acme/billing.git' });
  const { json } = await cli('repos');
  assert.deepEqual(json.repositories, [
    { id: 'personal/main/room', title: 'the room', upstream: 'https://github.com/fayedintoyou/room', aliases: ['room', 'fayelore.com'], path: null, status: 'missing' },
    { id: 'team/work/billing', title: 'billing service', upstream: 'git@github.com:acme/billing.git', aliases: [], path: null, status: 'missing' }]);
  assert.equal((await cli('validate')).code, 0);
});

// spec: repository-registry / Invalid repository fields
test('validate names a Repository with no upstream or bad aliases', async t => {
  const { cli, register } = await fixture(t);
  await register('personal', 'nowhere', { title: 'nowhere' });
  let result = await cli('validate');
  assert.equal(result.error.code, 'INVALID_REPOSITORY');
  assert.match(result.error.message, /personal\/main\/nowhere: resource/);
  await register('personal', 'nowhere', { title: 'nowhere', resource: 'https://github.com/me/nowhere', aliases: 'nope' });
  result = await cli('validate');
  assert.match(result.error.message, /personal\/main\/nowhere: aliases/);
});

// spec: repository-registry / Alias claimed twice
test('validate rejects an alias used by two repositories', async t => {
  const { cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['site'] });
  await register('personal', 'blog', { title: 'blog', resource: 'https://github.com/me/blog', aliases: ['Site'] });
  const result = await cli('validate');
  assert.equal(result.error.code, 'INVALID_REPOSITORY');
  assert.match(result.error.message, /"site" is claimed by personal\/main\/blog and personal\/main\/room/);
});

// spec: repository-registry / A fresh machine has no checkouts
test('a copy of the workspace on another machine starts with every repository missing', async t => {
  const { base, workspace, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await cli('repos', 'locate', 'room', await checkout(join(base, 'room'), { origin: 'https://github.com/me/room.git' }));
  assert.equal((await cli('repos')).json.repositories[0].status, 'located');
  // What another machine gets from git: everything but the untracked state.
  const elsewhere = join(base, 'elsewhere');
  await cp(workspace, elsewhere, { recursive: true, filter: source => !source.includes('/.state') });
  const fresh = JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', elsewhere, 'repos'])).stdout);
  assert.deepEqual(fresh.repositories.map(item => [item.id, item.path, item.status]), [['personal/main/room', null, 'missing']]);
  assert.ok(!(await readFile(join(workspace, 'hubs/personal/room.md'), 'utf8')).includes(base), 'no local path in the hub');
});

// spec: repository-registry / Locate by alias
test('locate records a checkout by alias when a remote is the upstream over SSH', async t => {
  const { base, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/fayedintoyou/room', aliases: ['fayelore.com'] });
  const path = await checkout(join(base, 'code/room'), { origin: 'git@github.com:FayedIntoYou/Room.git' });
  const located = await cli('repos', 'locate', 'fayelore.com', path);
  assert.equal(located.code, 0, JSON.stringify(located.error));
  assert.equal(located.json.repository.path, path);
  assert.equal((await cli('repos')).json.repositories[0].path, path);
});

// spec: repository-registry / Wrong checkout
test('locate refuses a directory that is not a checkout of the upstream', async t => {
  const { base, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await mkdir(join(base, 'plain'));
  assert.equal((await cli('repos', 'locate', 'room', join(base, 'plain'))).error.code, 'NOT_A_CHECKOUT');
  const other = await checkout(join(base, 'other'), { origin: 'https://github.com/me/other' });
  const mismatch = await cli('repos', 'locate', 'room', other);
  assert.equal(mismatch.error.code, 'REMOTE_MISMATCH');
  assert.match(mismatch.error.message, /github.com\/me\/other/);
  assert.equal((await cli('repos')).json.repositories[0].status, 'missing');
});

// spec: repository-registry / Clone and record
test('clone makes a checkout of the upstream and records it, refusing an existing path', async t => {
  const { base, env, cli, register } = await fixture(t);
  const source = join(base, 'source');
  await mkdir(source);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: source });
  await writeFile(join(source, 'README.md'), 'hello\n');
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['commit', '-qm', 'start'], { cwd: source, env });
  const upstream = join(base, 'garden.git');
  await exec('git', ['clone', '-q', '--bare', source, upstream]);
  await register('personal', 'garden', { title: 'garden', resource: `file://${upstream}` });
  const cloned = await cli('repos', 'clone', 'garden');
  assert.equal(cloned.code, 0, JSON.stringify(cloned.error));
  assert.equal(cloned.json.repository.path, await realpath(join(env.HOME, 'garden')));
  assert.equal(await readFile(join(env.HOME, 'garden/README.md'), 'utf8'), 'hello\n');
  assert.equal((await cli('repos')).json.repositories[0].status, 'located');
  assert.equal((await cli('repos', 'clone', 'garden', join(env.HOME, 'garden'))).error.code, 'DESTINATION_EXISTS');
});

// spec: repository-registry / Scan finds checkouts
test('scan records matching checkouts one level down only', async t => {
  const { base, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await register('personal', 'deep', { title: 'deep', resource: 'https://github.com/me/deep' });
  const room = await checkout(join(base, 'code/room'), { upstream: 'git@github.com:me/room.git' });
  await checkout(join(base, 'code/unrelated'), { origin: 'https://github.com/someone/else' });
  await checkout(join(base, 'code/a/b/deep'), { origin: 'https://github.com/me/deep' });
  const scanned = await cli('repos', 'scan', join(base, 'code'));
  assert.equal(scanned.code, 0, JSON.stringify(scanned.error));
  assert.deepEqual(scanned.json.recorded, [{ id: 'personal/main/room', path: room }]);
  assert.deepEqual(scanned.json.missing, ['personal/main/deep']);
});

// spec: repository-registry / Deeper scan
test('scan --depth reaches deeper checkouts but never nested or hidden ones', async t => {
  const { base, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await register('personal', 'deep', { title: 'deep', resource: 'https://github.com/me/deep' });
  await register('personal', 'studio', { title: 'studio', resource: 'https://github.com/me/studio' });
  const room = await checkout(join(base, 'code/room'), { upstream: 'git@github.com:me/room.git' });
  await checkout(join(base, 'code/unrelated'), { origin: 'https://github.com/someone/else' });
  const deep = await checkout(join(base, 'code/a/b/deep'), { origin: 'https://github.com/me/deep' });
  await checkout(join(base, 'code/room/vendor/studio'), { origin: 'https://github.com/me/studio' });
  await checkout(join(base, 'code/.cache/studio'), { origin: 'https://github.com/me/studio' });
  const tooDeep = await cli('repos', 'scan', join(base, 'code'), '--depth', '7');
  assert.equal(tooDeep.error.code, 'INVALID_INPUT');
  assert.deepEqual((await cli('repos')).json.repositories.map(item => item.status), ['missing', 'missing', 'missing']);
  const scanned = await cli('repos', 'scan', join(base, 'code'), '--depth', '3');
  assert.equal(scanned.code, 0, JSON.stringify(scanned.error));
  assert.equal(scanned.json.depth, 3);
  assert.deepEqual(scanned.json.recorded, [{ id: 'personal/main/room', path: room }, { id: 'personal/main/deep', path: deep }]);
  assert.deepEqual(scanned.json.missing, ['personal/main/studio']);
});

// spec: repository-registry / Scan finds a worktree
test('scan records a linked worktree\'s main checkout, not the worktree', async t => {
  const { base, cli, register, checkout, commit } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const main = await checkout(join(base, 'elsewhere/room'), { origin: 'https://github.com/me/room' });
  await commit(main);
  await exec('git', ['worktree', 'add', '-q', join(base, 'code/room-fix')], { cwd: main });
  const scanned = await cli('repos', 'scan', join(base, 'code'));
  assert.equal(scanned.code, 0, JSON.stringify(scanned.error));
  assert.deepEqual(scanned.json.recorded, [{ id: 'personal/main/room', path: main, worktree: await realpath(join(base, 'code/room-fix')) }]);
  assert.equal((await cli('repos')).json.repositories[0].path, main);
});

// spec: repository-registry / Worktree of a bare or missing main
test('scan records nothing for a worktree of a bare repository or of a deleted main checkout, and says why', async t => {
  const { base, cli, register, checkout, commit, upstream } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await register('personal', 'studio', { title: 'studio', resource: 'https://github.com/me/studio' });
  await register('personal', 'garden', { title: 'garden', resource: 'https://github.com/me/garden' });
  // A worktree of a bare repository.
  const bare = (await upstream('room')).slice('file://'.length);
  await exec('git', ['remote', 'set-url', 'origin', 'https://github.com/me/room'], { cwd: bare });
  await exec('git', ['worktree', 'add', '-q', join(base, 'code/room-wt')], { cwd: bare });
  // A worktree whose main checkout, and with it the git directory, was deleted.
  const studio = await checkout(join(base, 'elsewhere/studio'), { origin: 'https://github.com/me/studio' });
  await commit(studio);
  await exec('git', ['worktree', 'add', '-q', join(base, 'code/studio-wt')], { cwd: studio });
  await rm(studio, { recursive: true, force: true });
  // A --separate-git-dir checkout, whose git directory git reports as the main worktree.
  await mkdir(join(base, 'gitdirs'));
  await exec('git', ['init', '-q', '--separate-git-dir', join(base, 'gitdirs/garden.git'), join(base, 'elsewhere/garden')]);
  const garden = await realpath(join(base, 'elsewhere/garden'));
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/me/garden'], { cwd: garden });
  await commit(garden);
  await exec('git', ['worktree', 'add', '-q', join(base, 'code/garden-wt')], { cwd: garden });
  const scanned = await cli('repos', 'scan', join(base, 'code'));
  assert.equal(scanned.code, 0, JSON.stringify(scanned.error));
  assert.deepEqual(scanned.json.recorded, []);
  const code = await realpath(join(base, 'code'));
  const skipped = Object.fromEntries(scanned.json.skipped.map(item => [item.path, item]));
  assert.deepEqual(Object.keys(skipped).sort(), [join(code, 'garden-wt'), join(code, 'room-wt'), join(code, 'studio-wt')]);
  assert.equal(skipped[join(code, 'room-wt')].id, 'personal/main/room');
  assert.match(skipped[join(code, 'room-wt')].reason, /bare repository/);
  assert.match(skipped[join(code, 'studio-wt')].reason, /no longer exists/);
  assert.match(skipped[join(code, 'garden-wt')].reason, /not a checkout/);
  assert.deepEqual(scanned.json.missing, ['personal/main/garden', 'personal/main/room', 'personal/main/studio']);
  assert.ok((await cli('repos')).json.repositories.every(item => item.status === 'missing'));
});

// spec: repository-registry / Scan finds a worktree
test('a main checkout whose path holds a newline is recorded through its worktree, by scan and at a setup prompt', async t => {
  const { base, cli, cliInput, register, checkout, commit } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await register('personal', 'studio', { title: 'studio', resource: 'https://github.com/me/studio' });
  const room = await checkout(join(base, 'elsewhere/ro\nom'), { origin: 'https://github.com/me/room' });
  await commit(room);
  await exec('git', ['worktree', 'add', '-q', join(base, 'code/room-wt')], { cwd: room });
  const studio = await checkout(join(base, 'elsewhere/stu\ndio '), { origin: 'https://github.com/me/studio' });
  await commit(studio);
  await exec('git', ['worktree', 'add', '-q', join(base, 'other/studio-wt')], { cwd: studio });
  const scanned = await cli('repos', 'scan', join(base, 'code'));
  assert.equal(scanned.code, 0, JSON.stringify(scanned.error));
  assert.deepEqual(scanned.json.recorded.map(item => [item.id, item.path]), [['personal/main/room', room]]);
  assert.deepEqual(scanned.json.skipped, []);
  const setup = await cliInput(`${join(base, 'other/studio-wt')}\n`, 'repos', 'setup', '--ask', '--scan', join(base, 'code'));
  assert.equal(setup.code, 0, JSON.stringify(setup.error));
  assert.deepEqual(setup.json.located, [{ id: 'personal/main/studio', path: studio }]);
  assert.deepEqual((await cli('repos')).json.repositories.map(item => item.path), [room, studio]);
});

test('setup never reports the credentials in a wrong checkout\'s remote, on stderr or in its result', async t => {
  const { base, cliInput, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const wrong = await checkout(join(base, 'wrong'), { origin: `https://faye:${token}@github.com/me/other.git`, mirror: `https://github.com/me/other?access_token=${token}` });
  const setup = await cliInput(`${wrong}\n\n`, 'repos', 'setup', '--ask');
  assert.equal(setup.code, 0, JSON.stringify(setup.error));
  assert.equal(setup.json.failed[0].code, 'REMOTE_MISMATCH');
  assert.equal(setup.json.failed[0].message, `${wrong} has remotes github.com/me/other, not github.com/me/room`);
  assert.match(setup.stderr, /REMOTE_MISMATCH/);
  for (const text of [setup.stderr, JSON.stringify(setup.json)]) {
    assert.ok(!text.includes(token) && !text.includes('faye:'), text);
  }
});

test('setup shows remotes only by their normalized identity, whatever credentials their URLs hold', async t => {
  const { base, cli, cliInput, register, checkout } = await fixture(t);
  const secrets = ['SECRET-ACCESS', 'SECRET-ENCODED', 'SECRET-OAUTH', 'p@ss-SECRET', 'SECRET-CLONE', 'SECRET-SLASH', 'SECRET-FILE', 'SECRET-SCP', 'SECRET-VAULT', 'SECRET-QUERY', 'SECRET-SPLIT'];
  const lower = secrets.map(secret => secret.toLowerCase());
  // A derived title, from an upstream carrying a token.
  await register('personal', 'room', { resource: 'https://github.com/me/room?access_token=SECRET-ACCESS' });
  // A clone that fails, from an upstream with a password holding an unescaped @.
  await register('personal', 'garden', { title: 'garden', resource: 'https://faye:p@ss-SECRET@127.0.0.1:1/me/garden.git?oauth_token=SECRET-CLONE' });
  const wrong = await checkout(join(base, 'wrong'), {
    origin: 'https://github.com/me/other?%74oken=SECRET-ENCODED',
    mirror: 'https://gitlab.com/me/other?oauth_token=SECRET-OAUTH',
    backup: 'https://faye:p@ss-SECRET@github.com/me/other.git',
    slash: 'https://faye:pa/SECRET-SLASH@github.com/me/room',
    local: 'file://u:SECRET-FILE@host/srv/room',
    scp: 'git@github.com:me/garden?token=SECRET-SCP',
    // A password whose start reads as a port, holding # or ? before its @.
    vault: 'https://faye:2024/vault/SECRET-VAULT#1@github.com/me/room',
    query: 'https://faye:2024/vault/SECRET-QUERY?x@github.com/me/other',
    split: 'https://fa/ye:x/SECRET-SPLIT#@github.com/me/room' });
  // A password holding an unescaped / leaves no valid upstream: it isn't registered at all.
  await register('personal', 'studio', { title: 'studio', resource: 'https://faye:pa/SECRET-SLASH@github.com/me/studio' });
  // Prompts in id order: garden (clone fails, then skip), then the room (a wrong checkout, then skip).
  const setup = await cliInput(`clone\n\n${wrong}\n\n`, 'repos', 'setup', '--ask', '--scan', join(base, 'wrong'), '--depth', '0');
  assert.equal(setup.code, 0, JSON.stringify(setup.error));
  assert.match(setup.stderr, /^room \(personal\/main\/room, github\.com\/me\/room\) is missing/m);
  const failed = Object.fromEntries(setup.json.failed.map(item => [item.id, item]));
  assert.equal(failed['personal/main/garden'].code, 'CLONE_FAILED');
  assert.equal(failed['personal/main/garden'].message, 'Could not clone 127.0.0.1/me/garden: network error');
  assert.equal(failed['personal/main/room'].message, `${wrong} has remotes file:host/srv/room, github.com/me/garden, github.com/me/other, gitlab.com/me/other and 4 unrecognized, not github.com/me/room`);
  assert.deepEqual(setup.json.missing.map(item => item.upstream), ['127.0.0.1/me/garden', 'github.com/me/room']);
  const locate = await cli('repos', 'locate', 'room', wrong);
  assert.equal(locate.error.code, 'REMOTE_MISMATCH');
  const clone = await cli('repos', 'clone', 'garden');
  assert.deepEqual(clone.error.details, { reason: 'network error', upstream: '127.0.0.1/me/garden' });
  const validate = await cli('validate');
  assert.match(validate.error.message, /personal\/main\/studio: resource must be/);
  for (const text of [setup.stderr, JSON.stringify(setup.json), JSON.stringify(locate.error), JSON.stringify(clone.error), JSON.stringify(validate.error)]) {
    for (const secret of [...secrets, ...lower]) assert.ok(!text.includes(secret), `${secret} in ${text}`);
    assert.ok(!text.includes('faye'), text);
  }
});

test('no secret placed anywhere in a remote URL reaches setup, locate or validate output', async t => {
  const { base, cli, cliInput, register, checkout } = await fixture(t);
  const secrets = ['S3CR3T-ALPHA', 'tok_SECRETbeta', 'Zq9SECRETgamma'];
  const separators = ['/', '?', '#', ':', '@', '%2F'];
  const placements = [(s, x) => `${x}${s}`, (s, x) => `${s}${x}`, (s, x) => `pre${x}${s}${x}post`, (s, x) => `${x}${x}${s}`, (s, x) => `2024${x}${s}`];
  // The host part stays intact in each; well-formed userinfo has no raw / ? or #, and a query
  // or fragment holding an @ makes the URL ambiguous. Either way, never shown.
  const families = [
    [pw => `https://user:${pw}@github.com/o/r`, pw => /[/?#]/.test(pw)],
    [pw => `ssh://git:${pw}@github.com/o/r.git`, pw => /[/?#]/.test(pw)],
    [pw => `https://github.com/o/r?${pw}`, pw => pw.includes('@')],
    [pw => `git@github.com:o/r#${pw}`, pw => pw.includes('@')]];
  const cases = [];
  for (const secret of secrets) for (const separator of separators) for (const place of placements) for (const [build, ambiguous] of families) {
    const pw = place(secret, separator);
    cases.push({ id: `personal/main/c${cases.length}`, url: build(pw), expected: ambiguous(pw) ? null : 'github.com/o/r' });
  }
  for (const [i, item] of cases.entries()) await register('personal', `c${i}`, { title: `c${i}`, resource: item.url });
  await register('personal', 'target', { title: 'target', resource: 'https://github.com/x/target' });
  // One checkout with every URL as a remote; quoted, so git reads # and ; literally.
  const wrong = await checkout(join(base, 'wrong'));
  const urls = [...new Set(cases.map(item => item.url))];
  await appendFile(join(wrong, '.git/config'), urls.map((url, i) => `[remote "r${i}"]\n\turl = "${url}"\n`).join(''));
  await mkdir(join(base, 'empty'));
  const setup = await cliInput('', 'repos', 'setup', '--ask', '--scan', join(base, 'empty'));
  assert.equal(setup.code, 0, JSON.stringify(setup.error));
  assert.equal(setup.json.missing.length, cases.filter(item => item.expected).length + 1);
  const shown = new Map(setup.json.missing.map(item => [item.id, item.upstream]));
  for (const item of cases) assert.equal(shown.get(item.id) ?? null, item.expected, item.url);
  const locate = await cli('repos', 'locate', 'target', wrong);
  assert.equal(locate.error.code, 'REMOTE_MISMATCH');
  const unrecognized = urls.filter(url => cases.find(item => item.url === url).expected === null).length;
  assert.equal(locate.error.message, `${wrong} has remotes github.com/o/r and ${unrecognized} unrecognized, not github.com/x/target`);
  const validate = await cli('validate');
  assert.equal(validate.error.code, 'INVALID_REPOSITORY');
  // The routing skill and repos listing show a hub concept's resource as written; that is
  // their own requirement's output, not this one's.
  for (const text of [setup.stderr, JSON.stringify(setup.json), JSON.stringify(locate.error), JSON.stringify(validate.error)].map(text => text.toLowerCase())) {
    for (const secret of secrets) assert.ok(!text.includes(secret.toLowerCase()), `${secret} shown in ${text.slice(Math.max(0, text.indexOf(secret.toLowerCase()) - 200), text.indexOf(secret.toLowerCase()) + 50)}`);
  }
});

test('a scan survives a directory with tens of thousands of subdirectories', async t => {
  const { base, env, workspace, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const wide = join(base, 'wide');
  await mkdir(wide);
  // A small stack makes 20,000 entries overflow a spread the way ~130,000 do by default.
  for (let i = 0; i < 20000; i += 500) await Promise.all(Array.from({ length: 500 }, (_, j) => mkdir(join(wide, `d${i + j}`))));
  const room = await checkout(join(wide, 'room'), { origin: 'https://github.com/me/room' });
  const { stdout } = await exec(process.execPath, ['--stack-size=100', join(kit, 'bin/hub.mjs'), '--root', workspace, 'repos', 'scan', wide], { env, maxBuffer: 16 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout).recorded, [{ id: 'personal/main/room', path: room }]);
});

// spec: repository-registry / Fresh machine without prompts
test('repos setup records what it finds under home, reports the rest with remedies and clones nothing', async t => {
  const { env, cliInput, register, checkout, upstream } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await register('personal', 'studio', { title: 'studio', resource: await upstream('studio') });
  await register('personal', 'garden', { title: 'garden', resource: await upstream('garden') });
  const room = await checkout(join(env.HOME, 'code/room'), { origin: 'https://github.com/me/room' });
  const setup = await cliInput('clone\nclone\n', 'repos', 'setup');
  assert.equal(setup.code, 0, JSON.stringify(setup.error));
  assert.equal(setup.stderr, '', 'no prompts without a terminal or --ask');
  assert.deepEqual(setup.json.scanned, [await realpath(env.HOME)]);
  assert.equal(setup.json.depth, 2);
  assert.deepEqual(setup.json.recorded, [{ id: 'personal/main/room', path: room }]);
  assert.deepEqual(setup.json.cloned, []);
  assert.deepEqual(setup.json.missing.map(item => [item.id, item.remedies]), [
    ['personal/main/garden', ['repos locate personal/main/garden <path>', 'repos clone personal/main/garden [<path>]']],
    ['personal/main/studio', ['repos locate personal/main/studio <path>', 'repos clone personal/main/studio [<path>]']]]);
  assert.ok(!await exists(join(env.HOME, 'garden')) && !await exists(join(env.HOME, 'studio')), 'nothing cloned');
});

// spec: repository-registry / Approved at a prompt
test('repos setup --ask locates and clones what the answers say, then refreshes the installed routing skill', async t => {
  const { base, env, workspace, cli, cliInput, register, checkout, upstream } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await register('personal', 'garden', { title: 'garden', resource: await upstream('garden') });
  const room = await checkout(join(base, 'elsewhere/deeper/still/room'), { origin: 'https://github.com/me/room' });
  const claude = join(base, 'claude');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, 'agents', 'install', '--agent', 'claude'],
    { env: { HOME: env.HOME, CLAUDE_CONFIG_DIR: claude, PATH: `${bin}:/usr/bin:/bin` } });
  // Prompts come in id order: garden, then the room.
  const setup = await cliInput(`clone\n${room}\n`, 'repos', 'setup', '--ask');
  assert.equal(setup.code, 0, JSON.stringify(setup.error));
  assert.match(setup.stderr, /garden \(personal\/main\/garden, file:\/.*\/garden\) is missing/);
  assert.match(setup.stderr, /the room \(personal\/main\/room, github\.com\/me\/room\) is missing/);
  const garden = await realpath(join(env.HOME, 'garden'));
  assert.deepEqual(setup.json.cloned, [{ id: 'personal/main/garden', path: garden }]);
  assert.deepEqual(setup.json.located, [{ id: 'personal/main/room', path: room }]);
  assert.deepEqual(setup.json.missing, []);
  assert.deepEqual((await cli('repos')).json.repositories.map(item => [item.id, item.path]), [['personal/main/garden', garden], ['personal/main/room', room]]);
  const installed = await readFile(join(claude, 'skills/my-repos/SKILL.md'), 'utf8');
  assert.ok(installed.includes(garden) && installed.includes(room), 'the installed skill gives both paths');
});

// spec: repository-registry / Named clone
test('repos setup --clone clones only the named repository', async t => {
  const { env, cliInput, register, upstream } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: await upstream('room'), aliases: ['room'] });
  await register('personal', 'studio', { title: 'studio', resource: await upstream('studio') });
  const setup = await cliInput('', 'repos', 'setup', '--clone', 'room');
  assert.equal(setup.code, 0, JSON.stringify(setup.error));
  const room = await realpath(join(env.HOME, 'room'));
  assert.deepEqual(setup.json.cloned, [{ id: 'personal/main/room', path: room }]);
  assert.equal(await readFile(join(room, 'README.md'), 'utf8'), 'room\n');
  assert.deepEqual(setup.json.missing.map(item => item.id), ['personal/main/studio']);
  assert.ok(!await exists(join(env.HOME, 'studio')), 'studio is not cloned');
});

// spec: repository-registry / Skill names every repository
test('the routing skill names every repository and alias and carries upstreams and paths', async t => {
  const { base, workspace, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room', 'fayelore.com'] });
  const path = await checkout(join(base, 'room'), { origin: 'https://github.com/me/room' });
  await cli('repos', 'locate', 'room', path);
  await cli('agents', 'status');
  const directory = join(workspace, '.state/generated/my-repos');
  const { text, front } = await agentSkill(directory);
  assert.deepEqual(Object.keys(front), ['name', 'description', 'metadata']);
  for (const name of ['the room', 'room', 'fayelore.com']) assert.ok(front.description.includes(name), name);
  // Agent Skills metadata is a string-to-string map.
  assert.deepEqual(front.metadata, { 'personal/main/room': `https://github.com/me/room at ${path}; aliases: room, fayelore.com` });
  assert.match(text, /Do not search the filesystem/);
});

// spec: repository-registry / Missing checkout guidance
test('the routing skill gives the exact commands for a missing checkout', async t => {
  const { workspace, cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await cli('agents', 'status');
  const text = await readFile(join(workspace, '.state/generated/my-repos/SKILL.md'), 'utf8');
  assert.match(text, /## Missing on this machine/);
  assert.ok(text.includes('repos clone personal/main/room'));
  assert.ok(text.includes('repos locate personal/main/room <path>'));
});

// spec: repository-registry / Workflow guidance before changes
test('the routing skill tells agents to read each repository\'s instructions before changing it', async t => {
  const { workspace, cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await register('personal', 'kit', { title: 'the kit', resource: 'https://github.com/me/kit' });
  await cli('agents', 'status');
  const text = await readFile(join(workspace, '.state/generated/my-repos/SKILL.md'), 'utf8');
  const section = text.slice(text.indexOf('## Before changing a repository'));
  assert.ok(section.length < text.length, 'has a before-changing section');
  assert.match(section, /`AGENTS\.md` \(or `CLAUDE\.md`\)/);
  const read = `cd ${JSON.stringify(workspace)} && npm run -s hub -- read personal/main`;
  assert.ok(section.includes(`${read} room\``));
  assert.ok(section.includes(`${read} kit\``));
});

// spec: repository-registry / No repositories
test('a workspace without repositories generates no routing skill', async t => {
  const { workspace, cli } = await fixture(t);
  await cli('agents', 'status');
  await assert.rejects(readFile(join(workspace, '.state/generated/my-repos/SKILL.md')), { code: 'ENOENT' });
  assert.deepEqual((await cli('repos')).json.repositories, []);
});

// A name made unique by its parts and padded with "x" to an exact length in code points.
const named = (prefix, length) => prefix + 'x'.repeat(length - points(prefix));
const description = async workspace => (await agentSkill(join(workspace, '.state/generated/my-repos'))).front.description;

// spec: repository-registry / Standard keys only
test('generated routing skills use only standard Agent Skills frontmatter', async t => {
  const { base, workspace, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room'], keywords: ['personal site'] });
  await register('personal', 'garden', { title: 'the garden', resource: 'https://github.com/me/garden' });
  await cli('repos', 'locate', 'room', await checkout(join(base, 'room'), { origin: 'https://github.com/me/room' }));
  const synced = await cli('repos', 'sync');
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  const { front } = await agentSkill(join(workspace, '.state/generated/my-repos'));
  assert.deepEqual(Object.keys(front.metadata), ['personal/main/garden', 'personal/main/room']);
  assert.match(front.metadata['personal/main/garden'], /\(missing on this machine\)/);
  assert.match(front.metadata['personal/main/room'], / at \/.*keywords: personal site/);
});

// spec: repository-registry / Keywords reach the description
test('keywords reach the installed description on install and after sync', async t => {
  const { base, env, workspace, cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room'], keywords: ['personal site', 'portfolio'] });
  const installEnv = { HOME: env.HOME, CLAUDE_CONFIG_DIR: join(base, 'claude'), PATH: '/usr/bin:/bin' };
  const installed = JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, 'agents', 'install', '--agent', 'claude'], { env: installEnv })).stdout);
  assert.deepEqual(installed.skipped, {});
  const installedSkill = join(base, 'claude/skills/my-repos');
  let { front } = await agentSkill(installedSkill);
  for (const keyword of ['personal site', 'portfolio']) assert.ok(front.description.includes(keyword), keyword);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room'], keywords: ['personal site', 'portfolio', 'fayelore'] });
  const synced = await cli('repos', 'sync');
  assert.deepEqual(synced.json.skipped, {});
  ({ front } = await agentSkill(installedSkill));
  assert.ok(front.description.includes('fayelore'));
  assert.equal((await cli('validate')).code, 0);
});

// spec: repository-registry / Invalid keywords and long names
test('validate names keywords that are not a list, long titles and keywords naming another repository', async t => {
  const { cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', keywords: 'portfolio' });
  await register('personal', 'studio', { title: 'the studio', resource: 'https://github.com/me/studio', keywords: null });
  await register('personal', 'garden', { title: named('the garden ', 81), resource: 'https://github.com/me/garden' });
  await register('personal', 'kit', { title: 'the kit', resource: 'https://github.com/me/kit', aliases: ['hubs'] });
  await register('personal', 'blog', { title: 'the blog', resource: 'https://github.com/me/blog', keywords: ['hubs'] });
  const result = await cli('validate');
  assert.equal(result.error.code, 'INVALID_REPOSITORY');
  assert.match(result.error.message, /personal\/main\/room: keywords must be a list of strings/);
  assert.match(result.error.message, /personal\/main\/studio: keywords must be a list of strings/);
  assert.match(result.error.message, /personal\/main\/garden: title is over 80 characters/);
  assert.match(result.error.message, /personal\/main\/blog: keyword "hubs" names personal\/main\/kit/);
  // Exactly at the bounds is fine.
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', keywords: [named('k', 60)] });
  await register('personal', 'garden', { title: named('the garden ', 80), resource: 'https://github.com/me/garden', aliases: [named('a', 60)] });
  await register('personal', 'blog', { title: 'the blog', resource: 'https://github.com/me/blog', keywords: ['writing'] });
  await register('personal', 'studio', { title: 'the studio', resource: 'https://github.com/me/studio' });
  assert.equal((await cli('validate')).code, 0);
});

// spec: repository-registry / All names are effective by default
test('the description draws on every title, alias and keyword within the bounds', async t => {
  const { workspace, cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room', 'fayelore.com'], keywords: ['personal site'] });
  await register('personal', 'garden', { title: 'the garden', resource: 'https://github.com/me/garden', aliases: ['garden'], keywords: ['notes', 'digital garden'] });
  await cli('repos', 'sync');
  assert.equal(await description(workspace), 'Use when the user mentions one of their own repositories: ' +
    'the garden (garden, notes, digital garden); the room (room, fayelore.com, personal site)' +
    '. Gives its local checkout and upstream so you work there instead of searching the filesystem.');
});

// spec: repository-registry / Title not usable
test('a repository whose title is too long is named by its first alias, or else its id', async t => {
  const { workspace, cli, register } = await fixture(t);
  const long = named('a very long title ', 81);
  await register('personal', 'room', { title: long + ' one', resource: 'https://github.com/me/room', aliases: ['room', 'fayelore.com'] });
  await register('personal', 'garden', { title: long + ' two', resource: 'https://github.com/me/garden' });
  await cli('repos', 'sync');
  const text = await description(workspace);
  assert.ok(text.includes('personal/main/garden; room (fayelore.com)'), text);
  assert.ok(!text.includes(long), 'no long title');
});

// spec: repository-registry / Blank title
test('a repository with a blank title is named by its first alias, or else its id', async t => {
  const { workspace, cli, register } = await fixture(t);
  await register('personal', 'room', { title: ' ', resource: 'https://github.com/me/room', aliases: ['room', 'fayelore.com'] });
  await register('personal', 'garden', { title: ' ', resource: 'https://github.com/me/garden' });
  const synced = await cli('repos', 'sync');
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  assert.ok((await description(workspace)).includes(': personal/main/garden; room (fayelore.com).'), await description(workspace));
  assert.equal((await cli('validate')).code, 0);
});

// spec: repository-registry / Id too long to name
test('a repository named only by an id over 80 characters fails validate and sync, asking for a title or alias', async t => {
  const { workspace, cli, register } = await fixture(t);
  const concept = named('a-repository-concept-with-a-very-long-path-', 70);
  await register('personal', concept, { title: named('a long title ', 81), resource: 'https://github.com/me/long' });
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  for (const result of [await cli('validate'), await cli('repos', 'sync')]) {
    assert.equal(result.error.code, 'INVALID_REPOSITORY');
    assert.ok(result.error.message.includes(`personal/main/${concept}: has no title`), result.error.message);
    assert.match(result.error.message, /give it a shorter title or an alias/);
  }
  await assert.rejects(readFile(join(workspace, '.state/generated/my-repos/SKILL.md')), { code: 'ENOENT' });
  await register('personal', concept, { title: named('a long title ', 81), resource: 'https://github.com/me/long', aliases: ['long'] });
  assert.equal((await cli('repos', 'sync')).code, 0);
});

// spec: repository-registry / Add refuses long names
test('repos add refuses a title, default title or alias over its bound and writes nothing', async t => {
  const { env, workspace, cli } = await fixture(t);
  const refused = [
    await cli('repos', 'add', 'personal/main', 'https://github.com/me/room', '--title', named('the room ', 81)),
    await cli('repos', 'add', 'personal/main', 'https://github.com/me/room', '--alias', named('room ', 61)),
    await cli('repos', 'add', 'personal/main', `https://github.com/me/${named('r', 81)}`, '--concept', 'long'),
  ];
  for (const result of refused) assert.equal(result.error?.code, 'INVALID_INPUT', JSON.stringify(result));
  assert.match(refused[2].error.message, /defaults to the upstream's name.*--title/);
  for (const file of ['room.md', 'long.md']) await assert.rejects(readFile(join(workspace, 'hubs/personal', file)), { code: 'ENOENT' });
  const client = new Client({ name: 'bounds', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--allow-write'], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const tool = await client.callTool({ name: 'add_repo', arguments: { id: 'personal/main', upstream: 'https://github.com/me/room', aliases: ['🌊'.repeat(61)] } });
  assert.equal(tool.isError, true);
  await assert.rejects(readFile(join(workspace, 'hubs/personal/room.md')), { code: 'ENOENT' });
  const fits = await client.callTool({ name: 'add_repo', arguments: { id: 'personal/main', upstream: 'https://github.com/me/room', title: '🌊'.repeat(80), aliases: ['é'.repeat(60)] } });
  assert.equal(fits.isError, undefined, JSON.stringify(fits.content));
  assert.equal((await cli('validate')).code, 0);
});

// spec: repository-registry / Invalid keyword never rendered
test('a keyword over its bound or naming another repository is never rendered or reported skipped', async t => {
  const { workspace, cli, register } = await fixture(t);
  const long = named('long keyword ', 61);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', keywords: [long, 'garden', 'portfolio'] });
  await register('personal', 'garden', { title: 'the garden', resource: 'https://github.com/me/garden', aliases: ['garden'] });
  const synced = await cli('repos', 'sync');
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  assert.deepEqual(synced.json.skipped, {});
  const validated = await cli('validate');
  assert.match(validated.error.message, /personal\/main\/room: keyword "long keyword x+" is over 60 characters/);
  assert.match(validated.error.message, /personal\/main\/room: keyword "garden" names personal\/main\/garden/);
  const text = await description(workspace);
  assert.ok(text.includes('the room (portfolio)'), text);
  assert.ok(!text.includes(long) && !text.includes('room (garden') && !text.includes('garden, portfolio'), text);
});

// spec: repository-registry / Aliases beyond the budget
test('names past the budget are skipped in rounds, reported by repository, and kept in the body', async t => {
  const { workspace, cli, register } = await fixture(t);
  const repositories = Array.from({ length: 12 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return { id: `personal/main/r${n}`, title: `repo ${n}`, aliases: Array.from({ length: 6 }, (_, k) => named(`r${n}-alias-${k + 1}-`, 40)),
      keywords: [named(`r${n}-keyword-1-`, 30), named(`r${n}-keyword-2-`, 30)] };
  });
  for (const { id, title, aliases, keywords } of repositories) {
    await register('personal', id.split('/').pop(), { title, resource: `https://github.com/me/${title.replace(' ', '-')}`, aliases, keywords });
  }
  const synced = await cli('repos', 'sync');
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  assert.equal(synced.json.skills.length, 1);
  const { front, body } = await agentSkill(join(workspace, '.state/generated/my-repos'));
  for (const { id, title, aliases, keywords } of repositories) {
    assert.ok(front.description.includes(`${title} (${aliases[0]}`), `${id} and its first alias`);
    for (const name of [...aliases.slice(1), ...keywords]) {
      assert.notEqual(front.description.includes(name), (synced.json.skipped[id] ?? []).includes(name), `${name} is either named or skipped`);
    }
    for (const alias of aliases) assert.ok(body.includes(alias), `body lists ${alias}`);
  }
  // Rounds go in id order: the second alias round reaches the first repositories only.
  assert.ok(front.description.includes(repositories[0].aliases[1]));
  assert.equal(synced.json.skipped[repositories[11].id][0], repositories[11].aliases[1]);
  assert.ok(Object.values(synced.json.skipped).flat().some(name => name.includes('keyword')), 'keywords are skipped too');
});

// Two repositories with names at their bounds and one keyword of `length` code points;
// `letter` pads the names, so they can take more bytes than code points.
async function boundary(register, cli, workspace, { letter = 'x', length }) {
  const pad = (prefix, size) => prefix + letter.repeat(size - points(prefix));
  await register('personal', 'garden', { title: pad('the garden ', 80), resource: 'https://github.com/me/garden',
    aliases: [pad('garden-1 ', 60), pad('garden-2 ', 60), pad('garden-3 ', 60), pad('garden-4 ', 60), pad('garden-5 ', 60), pad('garden-6 ', 60)] });
  await register('personal', 'room', { title: pad('the room ', 80), resource: 'https://github.com/me/room',
    aliases: [pad('room-1 ', 60), pad('room-2 ', 60), pad('room-3 ', 60), pad('room-4 ', 60), pad('room-5 ', 60)], keywords: [pad('kw ', length)] });
  const synced = await cli('repos', 'sync');
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  return { skipped: synced.json.skipped, description: await description(workspace) };
}

// spec: repository-registry / Exact boundary
test('a description of exactly 1,024 characters keeps every name; one more skips exactly that keyword', async t => {
  const { workspace, cli, register } = await fixture(t);
  // Everything but the keyword is fixed; the keyword then fills the description exactly.
  const fixed = points((await boundary(register, cli, workspace, { length: 4 })).description) - 4;
  const length = 1024 - fixed;
  assert.ok(length > 3 && length <= 60, `the keyword can reach the boundary (${length})`);
  let render = await boundary(register, cli, workspace, { length });
  assert.equal(points(render.description), 1024);
  assert.deepEqual(render.skipped, {});
  render = await boundary(register, cli, workspace, { length: length + 1 });
  assert.deepEqual(render.skipped, { 'personal/main/room': [named('kw ', length + 1)] });
  assert.equal(points(render.description), 1024 - length - 2, 'the keyword and its separator are left out');
});

// spec: repository-registry / Characters, not bytes
test('the budget counts code points, not bytes or UTF-16 units', async t => {
  const { workspace, cli, register } = await fixture(t);
  const fixed = points((await boundary(register, cli, workspace, { length: 4 })).description) - 4;
  for (const letter of ['é', '🌊']) {
    const render = await boundary(register, cli, workspace, { letter, length: 1024 - fixed });
    assert.deepEqual(render.skipped, {}, letter);
    assert.equal(points(render.description), 1024, letter);
    assert.ok(Buffer.byteLength(render.description) > 1024 && render.description.length >= 1024, letter);
  }
});

// spec: repository-registry / Everything fits
test('two repositories with short aliases are named in full with nothing skipped', async t => {
  const { workspace, cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room', 'fayelore.com'] });
  await register('personal', 'garden', { title: 'the garden', resource: 'https://github.com/me/garden', aliases: ['garden'] });
  const synced = await cli('repos', 'sync');
  assert.deepEqual(synced.json.skipped, {});
  const text = await description(workspace);
  for (const name of ['the room', 'room', 'fayelore.com', 'the garden', 'garden']) assert.ok(text.includes(name), name);
});

// spec: repository-registry / List over MCP
test('MCP lists repositories read-only and offers no locate or clone tool', async t => {
  const { base, env, workspace, cli, register, checkout } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const path = await checkout(join(base, 'room'), { origin: 'https://github.com/me/room' });
  await cli('repos', 'locate', 'room', path);
  const client = new Client({ name: 'repos-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--allow-write'], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'list_repos').annotations.readOnlyHint, true);
  assert.ok(!tools.some(tool => /locate|clone|scan/.test(tool.name)));
  const listed = await client.callTool({ name: 'list_repos', arguments: {} });
  assert.deepEqual(listed.structuredContent.repositories.map(item => [item.id, item.path]), [['personal/main/room', path]]);
  const refused = await client.callTool({ name: 'locate_repo', arguments: { repository: 'room', path } });
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'UNKNOWN_OPERATION');
});

// spec: repository-registry / Core-only workspace routes repositories
test('repositories work in a core-only workspace', async t => {
  const { base, env, workspace, cli, register } = await fixture(t, '--addons', 'none');
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  assert.equal((await cli('repos')).json.repositories.length, 1);
  const client = new Client({ name: 'repos-core', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env, stderr: 'pipe' }));
  t.after(() => client.close());
  assert.equal((await client.callTool({ name: 'list_repos', arguments: {} })).structuredContent.repositories.length, 1);
  const bin = join(base, 'bin');
  await mkdir(bin);
  const installed = JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, 'agents', 'install', '--agent', 'claude'],
    { env: { HOME: env.HOME, CLAUDE_CONFIG_DIR: join(base, 'claude'), PATH: `${bin}:/usr/bin:/bin` } })).stdout);
  assert.deepEqual(installed.results.filter(item => item.kind === 'skill').map(item => item.name), ['context-kit', 'my-repos']);
});

// spec: repository-registry / Add by upstream
test('repos add writes a draft Repository concept and lists it in the hub index', async t => {
  const { workspace, cli } = await fixture(t);
  const added = await cli('repos', 'add', 'personal/main', 'https://github.com/me/room', '--title', 'the room', '--alias', 'room,fayelore.com', '--by', 'human:faye');
  assert.equal(added.code, 0, JSON.stringify(added.error));
  assert.equal(added.json.concept, 'hubs/personal/room.md');
  const text = await readFile(join(workspace, 'hubs/personal/room.md'), 'utf8');
  const front = parseYaml(text.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  assert.equal(front.type, 'Repository');
  assert.equal(front.resource, 'https://github.com/me/room');
  assert.deepEqual(front.aliases, ['room', 'fayelore.com']);
  assert.equal(front.status, 'draft');
  assert.equal(front.generated.by, 'human:faye');
  assert.ok(Math.abs(Date.parse(front.generated.at) - Date.now()) < 60000, 'real time');
  assert.match(await readFile(join(workspace, 'hubs/personal/index.md'), 'utf8'), /^\* \[the room\]\(room\.md\) - /m);
  assert.equal((await cli('validate')).code, 0);
  assert.deepEqual((await cli('repos')).json.repositories.map(item => [item.id, item.status]), [['personal/main/room', 'missing']]);
});

// spec: repository-registry / Add from a checkout
test('repos add --path registers a team hub repository from its checkout', async t => {
  const { base, workspace, cli, checkout } = await fixture(t);
  await mkdir(join(workspace, 'hubs/team'));
  await writeFile(join(workspace, 'hubs/team/hub.json'), JSON.stringify({ version: 1, id: 'team/platform', description: 'Our platform.', documents: ['README.md'], skills: [], links: [] }));
  await writeFile(join(workspace, 'hubs/team/README.md'), '---\ntype: Guide\n---\n\n# Platform\n');
  const path = await checkout(join(base, 'code/billing'), { origin: 'git@github.com:acme/billing.git' });
  await cli('agents', 'status');
  const added = await cli('repos', 'add', 'team/platform', '--path', path, '--alias', 'billing');
  assert.equal(added.code, 0, JSON.stringify(added.error));
  assert.deepEqual(added.json.repository, { id: 'team/platform/billing', title: 'billing', upstream: 'git@github.com:acme/billing.git', aliases: ['billing'], path, status: 'located' });
  const concept = await readFile(join(workspace, 'hubs/team/billing.md'), 'utf8');
  assert.match(concept, /^resource: git@github.com:acme\/billing.git$/m);
  assert.ok(!concept.includes(path), 'the path stays out of the hub');
  assert.ok((await readFile(join(workspace, '.state/generated/my-repos/SKILL.md'), 'utf8')).includes(`git@github.com:acme/billing.git at ${path}`));
});

// spec: repository-registry / Already registered
test('repos add refuses an upstream or alias that is already registered', async t => {
  const { workspace, cli, register } = await fixture(t);
  await register('personal', 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['site'] });
  const again = await cli('repos', 'add', 'personal/main', 'git@github.com:Me/Room.git', '--concept', 'room-again');
  assert.equal(again.error.code, 'REPOSITORY_EXISTS');
  assert.match(again.error.message, /personal\/main\/room/);
  const alias = await cli('repos', 'add', 'personal/main', 'https://github.com/me/blog', '--alias', 'site');
  assert.equal(alias.error.code, 'REPOSITORY_EXISTS');
  assert.match(alias.error.message, /"site" already names personal\/main\/room/);
  await assert.rejects(readFile(join(workspace, 'hubs/personal/room-again.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(workspace, 'hubs/personal/blog.md')), { code: 'ENOENT' });
});

// spec: repository-registry / Agent registers a repository
test('an agent registers a repository over MCP only when writes are allowed', async t => {
  const { env, workspace } = await fixture(t);
  const connect = async (...flags) => {
    const client = new Client({ name: 'repo-agent', version: '2.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, ...flags], env, stderr: 'pipe' }));
    t.after(() => client.close());
    return client;
  };
  const readOnly = await connect();
  assert.ok(!(await readOnly.listTools()).tools.some(tool => tool.name === 'add_repo'));
  const writer = await connect('--allow-write');
  const tool = (await writer.listTools()).tools.find(item => item.name === 'add_repo');
  assert.ok(tool && !('path' in tool.inputSchema.properties));
  const added = await writer.callTool({ name: 'add_repo', arguments: { id: 'personal/main', upstream: 'https://github.com/me/garden', aliases: ['garden'] } });
  assert.equal(added.isError, undefined, JSON.stringify(added.content));
  assert.match(await readFile(join(workspace, 'hubs/personal/garden.md'), 'utf8'), /by: repo-agent\/2\.0\.0/);
});
