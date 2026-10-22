import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  return { base, env, workspace, cli, register, checkout };
}

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
