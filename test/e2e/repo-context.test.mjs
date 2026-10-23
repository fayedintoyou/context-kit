import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sha256 = text => createHash('sha256').update(text).digest('hex');
const ORCHARD = 'https://github.com/example/orchard';

// A workspace with a `team/fruit` hub on an isolated machine, helpers to register
// repositories, make committed git checkouts and record them, and CLI and stdio MCP callers.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-repo-context-')));
  t.after(async () => { await exec('chmod', ['-R', 'u+rwx', base]).catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: join(base, 'home'), XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  delete env.CONTEXT_KIT_ROOT;
  await mkdir(env.HOME);
  const workspace = join(base, 'workspace');
  const run = async (args, { cwd = base, extra = {} } = {}) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env: { ...env, ...extra }, cwd })).stdout) }; }
    catch (error) { return { code: error.code, error: JSON.parse(error.stderr).error }; }
  };
  assert.equal((await run(['init', workspace])).code, 0);
  const cli = (args, options) => run(['--root', workspace, ...args], options);
  const fruit = join(workspace, 'hubs/fruit');
  await mkdir(fruit);
  await writeFile(join(fruit, 'hub.json'), JSON.stringify({ version: 1, id: 'team/fruit', description: 'Fruit.', documents: ['README.md'], skills: [], links: [] }));
  await writeFile(join(fruit, 'README.md'), '---\ntype: Guide\n---\n\n# Fruit\n');
  const register = (name, fields, hub = fruit) => writeFile(join(hub, `${name}.md`),
    `---\ntype: Repository\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n# ${fields.title ?? name}\n`);
  // A checkout with origin `remote`, committing `files` (path: content) and leaving `untracked` uncommitted.
  const checkout = async (path, remote, files = {}, untracked = {}) => {
    await mkdir(path, { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: path, env });
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: path, env });
    for (const [file, content] of Object.entries(files)) { await mkdir(dirname(join(path, file)), { recursive: true }); await writeFile(join(path, file), content); }
    if (Object.keys(files).length) await exec('git', ['add', '--', ...Object.keys(files)], { cwd: path, env });
    await exec('git', ['commit', '-q', '--allow-empty', '-m', 'start'], { cwd: path, env: { ...env, ...gitEnv } });
    for (const [file, content] of Object.entries(untracked)) { await mkdir(dirname(join(path, file)), { recursive: true }); await writeFile(join(path, file), content); }
    return realpath(path);
  };
  const locate = async (name, path) => assert.equal((await cli(['repos', 'locate', name, path])).code, 0);
  const stdio = async (extra = {}) => {
    const client = new Client({ name: 'repo-context-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env: { ...env, ...extra }, cwd: base, stderr: 'pipe' }));
    t.after(() => client.close());
    return client;
  };
  return { base, env, workspace, fruit, cli, register, checkout, locate, stdio };
}
const tool = async (client, args) => {
  const result = await client.callTool({ name: 'open_repo', arguments: args });
  return result.isError ? { error: JSON.parse(result.content[0].text).error } : { json: result.structuredContent };
};
const compact = value => Buffer.byteLength(JSON.stringify(value));

// spec: repository-context / Open by alias
test('repos open and open_repo return the same resolution, AGENTS.md pointer, concept and tree', async t => {
  const { base, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const agents = '# Orchard\n\nRun npm test.\n';
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': agents, 'src/app.js': 'x\n' });
  await locate('orchard', path);
  const opened = await cli(['repos', 'open', 'orchard']);
  assert.equal(opened.code, 0, JSON.stringify(opened.error));
  const { json } = opened;
  assert.equal(json.status, 'located');
  assert.equal(json.resolution.path, path);
  assert.deepEqual(json.instructions, [{ path: 'AGENTS.md', size: Buffer.byteLength(agents), sha256: sha256(agents), tracked: true }]);
  assert.deepEqual(json.repository, { id: 'team/fruit/orchard', title: 'the orchard', aliases: ['orchard'], hub: 'team/fruit', concept: 'orchard' });
  assert.deepEqual(json.tree.entries, ['AGENTS.md', 'src/', 'src/app.js']);
  assert.deepEqual((await tool(await stdio(), { repository: 'orchard' })).json, json);
  assert.ok(compact(json) <= 8192);
});

// spec: repository-context / How it resolved
test('the result names the field matched, the concept, the clean upstream and the machine path', async t => {
  const { base, cli, register, checkout, locate } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'README.md': 'r\n' });
  await locate('orchard', path);
  for (const [name, matched] of [['the orchard', 'title'], ['team/fruit/orchard', 'id'], ['ORCHARD', 'alias']]) {
    const { json } = await cli(['repos', 'open', name]);
    assert.deepEqual(json.resolution, { name, matched, concept: 'team/fruit/orchard', alternateIds: [], upstream: ORCHARD, path, source: 'machine' }, name);
  }
  // A resource or checkout remote holding a token never reaches the output: only the clean upstream does.
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  await register('plum', { title: 'plum', resource: `https://user:${token}@github.com/example/plum?access_token=${token}` });
  const plum = await checkout(join(base, 'code/plum'), `https://bot:${token}@github.com/example/plum`, { 'README.md': 'p\n' });
  await locate('plum', plum);
  const { json } = await cli(['repos', 'open', 'plum']);
  assert.equal(json.status, 'located');
  assert.equal(json.resolution.upstream, 'https://github.com/example/plum');
  assert.equal(json.resolution.matched, 'title');
  assert.ok(!JSON.stringify(json).includes(token) && !JSON.stringify(json).includes('bot'));
});

// spec: repository-context / Explicit name wins over the working directory
test('repos open resolves the named repository from inside a worktree of another one', async t => {
  const { base, env, cli, register, checkout, locate } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  await register('lemon', { title: 'lemon grove', resource: 'https://github.com/example/lemon', aliases: ['lemon'] });
  const orchard = await checkout(join(base, 'code/orchard'), ORCHARD, { 'README.md': 'orchard\n' });
  const lemon = await checkout(join(base, 'code/lemon'), 'https://github.com/example/lemon', { 'LEMON.md': 'lemon\n' });
  await locate('orchard', orchard);
  await locate('lemon', lemon);
  const worktree = join(base, 'code/lemon-feature');
  await exec('git', ['worktree', 'add', '-q', '-b', 'feature', worktree], { cwd: lemon, env });
  for (const cwd of [worktree, lemon]) {
    const { json } = await cli(['repos', 'open', 'orchard'], { cwd });
    assert.deepEqual([json.repository.id, json.resolution.path, json.tree.entries], ['team/fruit/orchard', orchard, ['README.md']], cwd);
  }
  // A git hook's GIT_DIR and GIT_WORK_TREE pointing at lemon change nothing either.
  const { json } = await cli(['repos', 'open', 'orchard'], { cwd: worktree, extra: { GIT_DIR: join(lemon, '.git'), GIT_WORK_TREE: lemon } });
  assert.deepEqual([json.resolution.path, json.tree.entries], [orchard, ['README.md']]);
});

// spec: repository-context / Ambiguous or unknown name
test('a shared upstream name is ambiguous and names both ids; an unknown name is unknown', async t => {
  const { cli, register, stdio } = await fixture(t);
  await register('pear', { title: 'pear one', resource: 'https://github.com/one/pear' });
  await register('pear-two', { title: 'pear two', resource: 'https://gitlab.com/two/pear' });
  const ambiguous = await cli(['repos', 'open', 'pear']);
  assert.equal(ambiguous.error.code, 'AMBIGUOUS_REPOSITORY');
  assert.match(ambiguous.error.message, /team\/fruit\/pear or team\/fruit\/pear-two/);
  assert.deepEqual(ambiguous.error.details.candidates, ['team/fruit/pear', 'team/fruit/pear-two']);
  assert.equal((await cli(['repos', 'open', 'quince'])).error.code, 'UNKNOWN_REPOSITORY');
  const client = await stdio();
  assert.equal((await tool(client, { repository: 'pear' })).error.code, 'AMBIGUOUS_REPOSITORY');
  assert.equal((await tool(client, { repository: 'quince' })).error.code, 'UNKNOWN_REPOSITORY');
});

// spec: repository-context / Not checked out here
test('an unrecorded repository opens as missing with the exact next commands, recording nothing', async t => {
  const { base, workspace, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  await register('lemon', { title: 'lemon grove', resource: 'https://github.com/example/lemon' });
  // A checkout of orchard exists here, but only lemon is recorded: open never searches for it.
  await checkout(join(base, 'orchard'), ORCHARD, { 'AGENTS.md': 'a\n' });
  await locate('lemon', await checkout(join(base, 'code/lemon'), 'https://github.com/example/lemon'));
  const state = join(workspace, '.state/checkouts.json');
  const before = await readFile(state);
  const listing = async () => [...await readdir(base), ...await readdir(join(base, 'code'))].sort();
  const entries = await listing();
  const { json } = await cli(['repos', 'open', 'orchard'], { cwd: join(base, 'orchard') });
  assert.equal(json.status, 'missing');
  assert.deepEqual(json.repository, { id: 'team/fruit/orchard', title: 'the orchard', aliases: ['orchard'], hub: 'team/fruit', concept: 'orchard' });
  assert.deepEqual(json.next, ['repos locate team/fruit/orchard <path>', 'repos clone team/fruit/orchard [<path>]']);
  assert.deepEqual([json.instructions, json.tree, json.resolution.path], [[], null, null]);
  assert.deepEqual((await tool(await stdio(), { repository: 'orchard' })).json, json);
  assert.deepEqual(await readFile(state), before);
  assert.deepEqual(await listing(), entries, 'nothing was cloned');
});

// spec: repository-context / Stale mapping
test('a recorded checkout that was deleted opens as missing and the record is left as it was', async t => {
  const { base, workspace, cli, register, checkout, locate } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n' });
  await locate('orchard', path);
  await rm(path, { recursive: true, force: true });
  const state = join(workspace, '.state/checkouts.json');
  const before = await readFile(state);
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.equal(json.status, 'missing');
  assert.match(json.reason, /no longer exists/);
  assert.deepEqual(json.next, ['repos locate team/fruit/orchard <path>', 'repos clone team/fruit/orchard [<path>]']);
  assert.equal(json.tree, null);
  assert.deepEqual(await readFile(state), before);
  assert.ok(before.toString().includes(path));
  // A directory still there that is no longer a checkout's top is missing too.
  await mkdir(path, { recursive: true });
  const emptied = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual([emptied.json.status, emptied.json.tree], ['missing', null]);
  assert.match(emptied.json.reason, /no longer the top of a git checkout/);
});

// spec: repository-context / Nested instructions
test('instruction files point at the root AGENTS.md then a nested untracked CLAUDE.md, outermost first', async t => {
  const { base, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const root = '# Root rules\n', nested = '# Billing rules\n';
  const path = await checkout(join(base, 'code/orchard'), ORCHARD,
    { 'AGENTS.md': root, 'services/billing/invoices/run.js': 'x\n', 'services/billing/invoices/deep/y.js': 'y\n' },
    { 'services/billing/CLAUDE.md': nested, 'services/billing/invoices/agents.md': 'not exactly the name\n' });
  await locate('orchard', path);
  const { json } = await cli(['repos', 'open', 'orchard', 'services/billing/invoices']);
  assert.deepEqual(json.instructions, [
    { path: 'AGENTS.md', size: Buffer.byteLength(root), sha256: sha256(root), tracked: true },
    { path: 'services/billing/CLAUDE.md', size: Buffer.byteLength(nested), sha256: sha256(nested), tracked: false }]);
  assert.equal(json.path, 'services/billing/invoices');
  assert.deepEqual([json.tree.root, json.tree.entries, json.tree.counts], ['services/billing/invoices',
    ['services/billing/invoices/deep/', 'services/billing/invoices/deep/y.js', 'services/billing/invoices/run.js'], { 'services/billing/invoices/deep/': 1 }]);
  assert.deepEqual((await tool(await stdio(), { repository: 'orchard', path: 'services/billing/invoices' })).json, json);
  assert.deepEqual((await cli(['repos', 'open', 'orchard'])).json.instructions.map(item => item.path), ['AGENTS.md']);
});

// spec: repository-context / Instruction file symlink
test('a symlinked CLAUDE.md gets a warning and no pointer, and the file it points to is not read', async t => {
  const { base, cli, register, checkout, locate } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const outside = join(base, 'outside.md');
  await writeFile(outside, 'OUTSIDE SECRET\n');
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n' });
  await symlink(outside, join(path, 'CLAUDE.md'));
  await chmod(outside, 0o000); // Any read of it would fail, not just be hidden.
  await locate('orchard', path);
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(json.instructions.map(item => item.path), ['AGENTS.md']);
  assert.deepEqual(json.warnings, ['CLAUDE.md: a symlink, not read']);
  assert.ok(!JSON.stringify(json).includes(sha256('OUTSIDE SECRET\n')));
});

// spec: repository-context / Zero-configuration bootstrap
test('with no configuration the tree lists tracked paths to depth 2, counts deeper files and never shows ignored ones', async t => {
  const { base, env, cli, register, checkout, locate } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const files = { 'README.md': 'r\n', 'src/app.js': 'a\n', 'src/lib/deep/x.js': 'x\n' };
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, files, { 'build/out.js': 'o\n', 'notes.txt': 'untracked\n' });
  await writeFile(join(path, '.git/info/exclude'), 'build/\n');
  await locate('orchard', path);
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(json.tree, { root: '', files: 3, depth: 2, entries: ['README.md', 'src/', 'src/app.js', 'src/lib/'], counts: { 'src/': 2, 'src/lib/': 1 } });
  assert.equal(json.truncated, null);
  assert.ok(!/build|notes\.txt/.test(JSON.stringify(json.tree)));
  // The same commit checked out elsewhere gives the same tree and pointers.
  const copy = join(base, 'elsewhere/orchard');
  await exec('git', ['clone', '-q', path, copy], { env });
  await exec('git', ['remote', 'set-url', 'origin', ORCHARD], { cwd: copy, env });
  await locate('orchard', copy);
  const moved = (await cli(['repos', 'open', 'orchard'])).json;
  assert.deepEqual([moved.tree, moved.instructions], [json.tree, json.instructions]);
});

// spec: repository-context / Large tree
test('400 long root file names fit 8 KiB as a code-point-ordered prefix, with the omission reported', async t => {
  const { base, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const names = Array.from({ length: 400 }, (_, index) => `${index % 2 ? 'Z' : 'a'}-${String(index).padStart(3, '0')}-${'long-file-name-'.repeat(4)}é.txt`);
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, Object.fromEntries(names.map(name => [name, 'x\n'])));
  await locate('orchard', path);
  const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.ok(compact(json) <= 8192, `${compact(json)} bytes`);
  const shown = json.tree.entries.length;
  assert.ok(shown > 10 && shown < 150, `${shown} entries`);
  assert.deepEqual(json.tree.entries, sorted.slice(0, shown));
  assert.deepEqual(json.truncated, { tree: { omitted: 400 - shown, first: sorted[shown],
    next: [`git -C ${path} -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.quotePath=false ls-files -- .`] } });
  // The command given lists what was left out.
  const listed = (await exec('/bin/sh', ['-c', json.truncated.tree.next[0]], { cwd: base })).stdout.split('\n').filter(Boolean);
  assert.deepEqual(listed.slice(shown), sorted.slice(shown));
  assert.equal(json.tree.files, 400);
  const mcp = (await tool(await stdio(), { repository: 'orchard' })).json;
  assert.deepEqual(mcp, json);
  assert.ok(compact(mcp) <= 8192);
});

// spec: repository-context / Large tree
test('omitted directories open on their own, and an omitted path too long to show whole is withheld, not cut', async t => {
  const { base, cli, register, checkout, locate } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  // 200 directories with a file each: the tree is directory, file, directory, file, ...
  const files = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`dir ${String(index).padStart(3, '0')}-${'x'.repeat(30)}/file.md`, 'x\n']));
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, files);
  await locate('orchard', path);
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.ok(compact(json) <= 8192);
  const { tree } = json.truncated;
  assert.equal(tree.next.length, 2);
  const [listing, open] = tree.next;
  // The git command, run as written, lists every file, the omitted ones included.
  const listed = (await exec('/bin/sh', ['-c', listing], { cwd: base })).stdout.split('\n').filter(Boolean);
  assert.equal(listed.length, 200);
  const omittedFile = tree.first.endsWith('/') ? `${tree.first}file.md` : tree.first;
  assert.ok(listed.includes(omittedFile), omittedFile);
  // The directory command, run through the CLI, opens the first omitted directory.
  const directory = (tree.first.endsWith('/') ? tree.first : `${dirname(tree.first)}/`).slice(0, -1);
  assert.equal(open, `repos open team/fruit/orchard '${directory}'`);
  const opened = await cli(['repos', 'open', 'team/fruit/orchard', directory]);
  assert.deepEqual([opened.json.path, opened.json.tree.entries], [directory, [`${directory}/file.md`]]);

  // Names longer than the allowance for `first` give null and say so, never a cut path.
  const longNames = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`long/${String(index).padStart(2, '0')}${'é'.repeat(110)}.md`, 'x\n']));
  const second = await checkout(join(base, 'code/orchard-long'), ORCHARD, longNames);
  await locate('orchard', second);
  const long = (await cli(['repos', 'open', 'orchard', 'long'])).json;
  assert.ok(compact(long) <= 8192);
  assert.ok(long.truncated.tree.omitted > 0);
  assert.equal(long.truncated.tree.first, null);
  assert.ok(long.truncated.fields.includes('truncated.tree.first'));
  assert.ok(!JSON.stringify(long).includes('…'), 'nothing was cut');
  const all = (await exec('/bin/sh', ['-c', long.truncated.tree.next[0]], { cwd: base })).stdout.split('\n').filter(Boolean);
  assert.equal(all.length, 60);
});

// A checkout whose directories d, d/d, ... nest `depth` levels deep, each with a tracked
// AGENTS.md and CLAUDE.md, and `files` long-named tracked files in the innermost one.
async function deepCheckout(checkout, path, depth, files = 0) {
  const directories = Array.from({ length: depth + 1 }, (_, level) => Array(level).fill('d').join('/'));
  const content = {};
  for (const directory of directories) for (const name of ['AGENTS.md', 'CLAUDE.md']) content[directory ? `${directory}/${name}` : name] = `# rules for ${directory || 'the root'}\n`;
  for (let index = 0; index < files; index++) content[`${directories.at(-1)}/${String(index).padStart(3, '0')}-${'long-name-'.repeat(6)}.txt`] = 'x\n';
  return { path: await checkout(path, ORCHARD, content), directories, deepest: directories.at(-1) };
}
const pointersFor = directories => directories.flatMap(directory => ['AGENTS.md', 'CLAUDE.md'].map(name => directory ? `${directory}/${name}` : name));

// spec: repository-context / Deep instructions
test('opening 98 levels down keeps both root pointers and drops the innermost ones, saying where to read on', async t => {
  const { base, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const { path, directories, deepest } = await deepCheckout(checkout, join(base, 'code/orchard'), 98, 20);
  assert.equal([...deepest].length, 195);
  await locate('orchard', path);
  const { json } = await cli(['repos', 'open', 'orchard', deepest]);
  assert.ok(compact(json) <= 8192, `${compact(json)} bytes`);
  const expected = pointersFor(directories);
  const got = json.instructions.map(item => item.path);
  assert.deepEqual(got.slice(0, 2), ['AGENTS.md', 'CLAUDE.md']);
  assert.ok(got.length > 2 && got.length < expected.length, `${got.length} pointers`);
  assert.deepEqual(got, expected.slice(0, got.length), 'outermost first, a prefix');
  assert.deepEqual(json.tree.entries, [], 'the tree goes before any instruction pointer');
  assert.equal(json.truncated.tree.omitted, 22, 'twenty files and the two instruction files');
  assert.deepEqual(json.truncated.instructions, { omitted: expected.length - got.length, from: dirname(expected[got.length]),
    next: 'read AGENTS.md and CLAUDE.md in each directory from `from` down to `path`' });
  assert.deepEqual((await tool(await stdio(), { repository: 'orchard', path: deepest })).json, json);
});

// spec: repository-context / Adversarial metadata
test('every mix of long metadata, deep subpaths and big trees fits 8 KiB and keeps the resolution and root pointers', async t => {
  const { base, fruit, cli, register, checkout, locate, stdio } = await fixture(t);
  const { path, directories } = await deepCheckout(checkout, join(base, 'code/orchard'), 98, 400);
  const nested = join(fruit, ...Array(30).fill('deep'));
  await mkdir(nested, { recursive: true });
  const concept = `${Array(30).fill('deep').join('/')}/orchard`;
  const id = `team/fruit/${concept}`;
  const title = '🍎'.repeat(80);
  const many = Array.from({ length: 160 }, (_, index) => `orchard-alias-${String(index).padStart(3, '0')}-${'ü'.repeat(40)}`);
  const client = await stdio();
  let located = false;
  for (const aliases of [[], ['orchard'], ['orchard', ...many]]) {
    await register('orchard', { title, resource: ORCHARD, aliases, keywords: Array.from({ length: 50 }, (_, index) => `keyword ${index}`), description: 'd'.repeat(3000) }, nested);
    if (!located) { await locate(id, path); located = true; }
    for (const depth of [0, 1, 50, 98]) {
      const subpath = directories[depth];
      for (const name of [id, title, ...(aliases.length ? [aliases.at(-1)] : [])]) {
        const args = ['repos', 'open', name, ...(subpath ? [subpath] : [])];
        const { json, error } = await cli(args);
        const label = `${aliases.length} aliases, depth ${depth}, by ${[...name].slice(0, 20).join('')}`;
        assert.ok(json, `${label}: ${JSON.stringify(error)}`);
        assert.ok(compact(json) <= 8192, `${label}: ${compact(json)} bytes`);
        assert.deepEqual([json.status, json.resolution.concept, json.resolution.path, json.resolution.upstream], ['located', id, path, ORCHARD], label);
        const expected = pointersFor(directories.slice(0, depth + 1));
        const got = json.instructions.map(item => item.path);
        assert.deepEqual(got.slice(0, 2), ['AGENTS.md', 'CLAUDE.md'], label);
        assert.deepEqual(got, expected.slice(0, got.length), label);
        assert.equal(json.truncated?.instructions?.omitted ?? 0, expected.length - got.length, label);
        assert.equal(json.truncated?.repository?.aliases ?? 0, aliases.length - json.repository.aliases.length, label);
        assert.deepEqual(json.repository.aliases, aliases.slice(0, json.repository.aliases.length), label);
        if (json.truncated?.repository) assert.equal(json.truncated.repository.next, `read team/fruit:/${concept}`, label);
        // Every depth-2 entry is shown or counted: 400 files and two instruction files in the innermost directory, else two files and a directory twice over.
        assert.equal(json.tree.entries.length + (json.truncated?.tree?.omitted ?? 0), depth === 98 ? 402 : 6, label);
        if (depth === 98 && name === id) assert.deepEqual((await tool(client, { repository: name, path: subpath })).json, json, label);
      }
    }
  }
  // Fields past their allowance are clipped with a marker, listed, and said where to read in full.
  const long = '€'.repeat(150); // 450 bytes: over both the title's and the name's allowance
  await register('orchard', { title: long, resource: ORCHARD, aliases: ['orchard'] }, nested);
  const { json } = await cli(['repos', 'open', long]);
  assert.ok(compact(json) <= 8192);
  assert.ok(json.repository.title.endsWith('…') && json.resolution.name.endsWith('…'));
  assert.deepEqual(json.truncated.fields, ['repository.title', 'resolution.name']);
  assert.equal(json.truncated.next, `repos, read team/fruit:/${concept}`);
});

// spec: repository-context / Unicode spelling
test('an NFD spelling of a tracked NFC directory opens it in the index spelling; untracked or ambiguous ones fail', async t => {
  const { base, env, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const nfc = 'café';
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { [`${nfc}/file.md`]: 'unicode\n', [`${nfc}/AGENTS.md`]: 'rules\n' }, { 'scratch/notes.md': 'untracked\n' });
  await locate('orchard', path);
  const client = await stdio();
  const canonical = (await cli(['repos', 'open', 'orchard', nfc])).json;
  assert.deepEqual(canonical.tree.entries, [`${nfc}/AGENTS.md`, `${nfc}/file.md`]);
  for (const spelling of ['café', 'café/']) {
    assert.deepEqual((await cli(['repos', 'open', 'orchard', spelling])).json, canonical, spelling);
    assert.deepEqual((await tool(client, { repository: 'orchard', path: spelling })).json, canonical, spelling);
  }
  assert.deepEqual(canonical.instructions.map(item => item.path), [`${nfc}/AGENTS.md`]);
  const untracked = await cli(['repos', 'open', 'orchard', 'scratch']);
  assert.equal(untracked.error.code, 'UNKNOWN_PATH');
  assert.match(untracked.error.message, /holds no tracked files/);
  // Two tracked directories whose names differ only in normalization: refused, not merged.
  await writeFile(join(base, 'blob.txt'), 'x\n');
  const sha = (await exec('git', ['hash-object', '-w', join(base, 'blob.txt')], { cwd: path, env })).stdout.trim();
  await exec('git', ['-c', 'core.precomposeUnicode=false', 'update-index', '--add', '--cacheinfo', `100644,${sha},café/other.md`], { cwd: path, env });
  for (const spelling of [nfc, 'café']) {
    const ambiguous = await cli(['repos', 'open', 'orchard', spelling]);
    assert.equal(ambiguous.error?.code, 'INVALID_PATH', spelling);
    assert.match(ambiguous.error.message, /differ only in Unicode normalization/);
  }
});

// spec: repository-context / Unicode spelling
test('on a case-insensitive file system another case opens the tracked directory, and a case-only collision is refused', async t => {
  const { base, env, cli, register, checkout, locate } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'docs/a.md': 'a\n' });
  const caseless = await realpath(join(path, '.GIT')).then(() => true, () => false);
  if (!caseless) { t.skip('this file system is case-sensitive'); return; }
  await locate('orchard', path);
  const upper = await cli(['repos', 'open', 'orchard', 'DOCS']);
  assert.deepEqual([upper.json?.path, upper.json?.tree.entries], ['docs', ['docs/a.md']], JSON.stringify(upper.error));
  await writeFile(join(base, 'blob.txt'), 'b\n');
  const sha = (await exec('git', ['hash-object', '-w', join(base, 'blob.txt')], { cwd: path, env })).stdout.trim();
  await exec('git', ['-c', 'core.ignoreCase=false', 'update-index', '--add', '--cacheinfo', `100644,${sha},Docs/b.md`], { cwd: path, env });
  for (const spelling of ['docs', 'Docs', 'DOCS']) {
    const ambiguous = await cli(['repos', 'open', 'orchard', spelling]);
    assert.equal(ambiguous.error?.code, 'INVALID_PATH', spelling);
    assert.match(ambiguous.error.message, /or case; it is ambiguous/);
  }
});

// spec: repository-context / Escaping or missing subpath
test('subpaths leaving the checkout are invalid and ones that do not exist are unknown', async t => {
  const { base, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'docs/a.md': 'a\n', 'file.txt': 'f\n' });
  await mkdir(join(base, 'code/outside'));
  await locate('orchard', path);
  const client = await stdio();
  for (const [subpath, code] of [['../outside', 'INVALID_PATH'], ['/etc', 'INVALID_PATH'], ['docs/none', 'UNKNOWN_PATH'],
    ['docs/../..', 'INVALID_PATH'], ['docs\\a', 'INVALID_PATH'], ['.git', 'INVALID_PATH'], ['docs//a', 'INVALID_PATH'], ['file.txt', 'UNKNOWN_PATH']]) {
    assert.equal((await cli(['repos', 'open', 'orchard', subpath])).error?.code, code, subpath);
    assert.equal((await tool(client, { repository: 'orchard', path: subpath })).error?.code, code, subpath);
  }
  assert.equal((await cli(['repos', 'open', 'orchard', 'docs/'])).json.path, 'docs');
});

// spec: repository-context / Symlinked parent
test('a tracked directory replaced by a symlink to outside fails to open with PATH_ESCAPE and nothing outside is read', async t => {
  const { base, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n', 'notes/x.md': 'x\n', 'notes/sub/y.md': 'y\n' });
  const outside = join(base, 'outside');
  await mkdir(join(outside, 'sub'), { recursive: true });
  await writeFile(join(outside, 'AGENTS.md'), 'OUTSIDE\n');
  await writeFile(join(outside, 'x.md'), 'OUTSIDE\n');
  await chmod(join(outside, 'AGENTS.md'), 0o000);
  await rm(join(path, 'notes'), { recursive: true });
  await symlink(outside, join(path, 'notes'));
  await locate('orchard', path);
  const client = await stdio();
  for (const subpath of ['notes', 'notes/sub']) {
    const opened = await cli(['repos', 'open', 'orchard', subpath]);
    assert.equal(opened.error?.code, 'PATH_ESCAPE', subpath);
    assert.equal((await tool(client, { repository: 'orchard', path: subpath })).error?.code, 'PATH_ESCAPE', subpath);
  }
  // At the root the tree is the index's, and no pointer comes from outside.
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(json.instructions.map(item => item.path), ['AGENTS.md']);
  assert.ok(!JSON.stringify(json).includes(sha256('OUTSIDE\n')));
});

// spec: repository-context / Hostile checkout configuration
test('fsmonitor, clean and process filters, hooks and injected git settings never run when opening', async t => {
  const { base, env, cli, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const markers = join(base, 'markers');
  await mkdir(markers);
  // Each writes its marker; filters pass content through, the rest exit at once.
  const script = async (name, filter = false) => {
    const file = join(base, 'bin', name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `#!/bin/sh\ntouch '${join(markers, name)}'\n${filter ? 'cat\n' : ''}`);
    await chmod(file, 0o755);
    return file;
  };
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n', 'docs/a.md': 'a\n', '.gitattributes': '*.md filter=evil\n' });
  // Configuration added after the commit, and the files touched, so a status or add would run it all.
  await writeFile(join(path, '.git/config'), `${await readFile(join(path, '.git/config'), 'utf8')}[core]\n\tfsmonitor = ${await script('fsmonitor')}\n\thooksPath = ${join(base, 'hooks')}\n` +
    `[filter "evil"]\n\tclean = ${await script('clean', true)}\n\tsmudge = ${await script('smudge', true)}\n\tprocess = ${await script('process')}\n\trequired = true\n`);
  for (const directory of [join(path, '.git/hooks'), join(base, 'hooks')]) {
    await mkdir(directory, { recursive: true });
    for (const hook of ['post-index-change', 'reference-transaction', 'post-checkout', 'pre-commit']) {
      await writeFile(join(directory, hook), `#!/bin/sh\ntouch '${join(markers, `hook-${hook}`)}'\n`);
      await chmod(join(directory, hook), 0o755);
    }
  }
  await writeFile(join(path, 'AGENTS.md'), 'changed\n');
  await writeFile(join(path, 'docs/a.md'), 'changed too\n');
  await locate('orchard', path);
  const elsewhere = await checkout(join(base, 'code/other'), 'https://github.com/example/other', { 'OTHER.md': 'o\n' });
  // Global config and injected settings that would run a marker too.
  await writeFile(join(env.HOME, '.gitconfig'), `[core]\n\tfsmonitor = ${await script('global')}\n`);
  const hostile = { GIT_DIR: join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere, GIT_INDEX_FILE: join(elsewhere, '.git/index'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: await script('injected'),
    GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${await script('parameters')}'` };
  const opened = await cli(['repos', 'open', 'orchard', 'docs'], { extra: hostile });
  assert.equal(opened.code, 0, JSON.stringify(opened.error));
  assert.deepEqual([opened.json.resolution.path, opened.json.tree.entries], [path, ['docs/a.md']]);
  assert.deepEqual(opened.json.instructions, [{ path: 'AGENTS.md', size: 8, sha256: sha256('changed\n'), tracked: true }]);
  assert.equal((await tool(await stdio(hostile), { repository: 'orchard' })).json.status, 'located');
  assert.deepEqual(await readdir(markers), []);
  // The fixture is live: plain git in that checkout runs it.
  await exec('git', ['add', '-A'], { cwd: path, env }).catch(() => {});
  assert.ok((await readdir(markers)).length > 0, 'the hostile configuration runs under plain git');
});

// spec: repository-context / Not offered over HTTP
test('open_repo is listed over stdio, not over HTTP, where a call to it is unknown', async t => {
  const { base, env, workspace, register, checkout, locate, stdio } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  await locate('orchard', await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n' }));
  const token = 'repo-context-test-token-0123456789abcdef0123';
  const child = spawn(process.execPath, [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--http', '0'],
    { env: { ...env, CONTEXT_KIT_MCP_TOKEN: token }, cwd: base, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = '';
  const { url } = JSON.parse(await new Promise((resolve, reject) => {
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('\n')) resolve(stderr.split('\n')[0]); });
    child.once('exit', () => reject(new Error(`server exited: ${stderr}`)));
  }));
  const http = new Client({ name: 'repo-context-test', version: '0.0.0' });
  await http.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => http.close());
  const remote = (await http.listTools()).tools.map(item => item.name);
  assert.ok(remote.includes('list_repos') && !remote.includes('open_repo') && !remote.includes('context_pack'));
  const called = await http.callTool({ name: 'open_repo', arguments: { repository: 'orchard' } });
  assert.equal(called.isError, true);
  assert.equal(JSON.parse(called.content[0].text).error.code, 'UNKNOWN_OPERATION');
  const local = await stdio();
  const listed = (await local.listTools()).tools.find(item => item.name === 'open_repo');
  assert.equal(listed.annotations.readOnlyHint, true);
  assert.equal((await tool(local, { repository: 'orchard' })).json.status, 'located');
});

// spec: repository-context / One call to start
test('the routing body names open_repo and repos open as the way to resolve, and context leaves the frontmatter alone', async t => {
  const { workspace, fruit, cli, register } = await fixture(t);
  const skill = () => readFile(join(workspace, '.state/generated/my-repos/SKILL.md'), 'utf8');
  const front = text => text.slice(0, text.indexOf('\n---\n') + 5);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'] });
  const withContext = `---\ntype: Repository\ntitle: lemon grove\nresource: https://github.com/example/lemon\ncontext:\n  verify: ["npm test"]\n---\n\n# lemon\n`;
  await writeFile(join(fruit, 'lemon.md'), withContext);
  assert.equal((await cli(['repos', 'sync'])).code, 0);
  const text = await skill();
  const body = text.slice(front(text).length);
  assert.match(body, /call the\n`open_repo` tool of the `[^`]+` MCP server, or run\n`[^`]+ repos open <repo>`/);
  assert.doesNotMatch(body, /list_repos/);
  await writeFile(join(fruit, 'lemon.md'), withContext.replace('context:\n  verify: ["npm test"]\n', ''));
  assert.equal((await cli(['repos', 'sync'])).code, 0);
  assert.equal(front(await skill()), front(text));
});

// ---- The `context` field (slice `fields`) ----------------------------------------------------

// A concept file in a hub directory, its frontmatter given as JSON values.
const writeConcept = async (hub, id, fields, body = `# ${fields.title ?? id}\n`) => {
  await mkdir(dirname(join(hub, `${id}.md`)), { recursive: true });
  await writeFile(join(hub, `${id}.md`), `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}`);
};
const guide = (hub, id, extra = {}) => writeConcept(hub, id, { type: 'Guide', title: `Guide ${id}`, description: `About ${id}.`, ...extra });
// Rewrites a hub's manifest fields in place.
const manifest = async (hub, fields) => {
  const file = join(hub, 'hub.json');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...fields }));
};
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return result.isError ? { error: JSON.parse(result.content[0].text).error } : { json: result.structuredContent };
};

// spec: repository-context / Declared context validates
test('a Repository declaring every context key, each well formed and resolvable, validates', async t => {
  const { workspace, fruit, cli, register } = await fixture(t);
  const notes = join(workspace, 'hubs/notes');
  await mkdir(notes);
  await writeFile(join(notes, 'hub.json'), JSON.stringify({ version: 1, id: 'personal/notes', description: 'Notes.', documents: ['README.md'], skills: [], links: [] }));
  await guide(notes, 'README');
  await guide(notes, 'orchard/ideas');
  for (const id of ['guides/harvest', 'guides/billing-ledger', 'guides/release-builder', 'guides/review-checklist', 'guides/release-checklist']) await guide(fruit, id);
  await manifest(fruit, { skills: ['kit:independent-review'] });
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'], context: {
    verify: ['npm test', 'npm run lint'],
    concepts: ['/guides/harvest', 'personal/notes:/orchard/ideas'],
    skills: ['kit:independent-review'],
    mcp: ['orchard-tracker'],
    areas: [{ path: 'services/billing', concepts: ['/guides/billing-ledger'], skills: [], mcp: ['ledger-db'] }],
    roles: { reviewer: { exclude: ['notes/builder/**'], omit: ['/guides/release-builder'], concepts: ['/guides/review-checklist'], skills: [], mcp: [] } },
    packs: { release: { description: 'Cut a release of the orchard.', files: ['CHANGELOG.md', 'docs/release/**', 'notes/**'], exclude: ['**/*.tmp'],
      concepts: ['/guides/release-builder', '/guides/release-checklist'], skills: ['kit:independent-review'], mcp: ['orchard-tracker'], limits: { files: 60, bytes: 262144 } } },
  } });
  const validated = await cli(['validate']);
  assert.equal(validated.code, 0, JSON.stringify(validated.error));
  assert.equal(validated.json.valid, true);
});

// spec: repository-context / Unknown keys at any level
test('validate names every unknown context key by concept and full key path, and ignores other types', async t => {
  const { fruit, cli, register } = await fixture(t);
  await register('apple', { title: 'apple', resource: 'https://github.com/example/apple', context: { commands: ['make'] } });
  await register('banana', { title: 'banana', resource: 'https://github.com/example/banana', context: { packs: { release: { description: 'r', files: ['*.md'], include: ['x'] } } } });
  await register('cherry', { title: 'cherry', resource: 'https://github.com/example/cherry', context: { roles: { reviewer: { files: ['x'] } } } });
  await writeConcept(fruit, 'guides/notes', { type: 'Guide', title: 'notes', context: 'hello' });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  assert.match(error.message, /team\/fruit\/apple: context\.commands: unknown key/);
  assert.match(error.message, /team\/fruit\/banana: context\.packs\.release\.include: unknown key/);
  assert.match(error.message, /team\/fruit\/cherry: context\.roles\.reviewer\.files: unknown key/);
  assert.doesNotMatch(error.message, /guides\/notes|hello/);
  assert.equal(error.message.split('; ').length, 3);
});

// spec: repository-context / Over the bounds
test('validate names each field over its bound with the bound', async t => {
  const { fruit, cli, register } = await fixture(t);
  await guide(fruit, 'guides/harvest');
  await register('orchard', { title: 'the orchard', resource: ORCHARD, context: {
    concepts: Array(51).fill('/guides/harvest'),
    roles: { Reviewer: {} },
    packs: { release: { description: 'd'.repeat(301), files: ['g'.repeat(201)], limits: { files: 501 } } },
  } });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  for (const expected of ['context.concepts: 51 entries; at most 50', 'context.packs.release.description: 301 characters; at most 300',
    'context.packs.release.files[0]: 201 characters; at most 200', 'context.packs.release.limits.files: 501; must be an integer from 1 to 500',
    'context.roles.Reviewer: role names are lowercase letters, digits and single hyphens, at most 40 characters']) {
    assert.ok(error.message.includes(`team/fruit/orchard: ${expected}`), expected);
  }
});

// spec: repository-context / Declared checks are returned, not run
test('declared verify commands are returned in order over CLI and MCP and never run', async t => {
  const { base, cli, register, checkout, locate, stdio } = await fixture(t);
  const marker = join(base, 'marker');
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'], context: { verify: ['npm test', 'node bin/check.mjs'] } });
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n', 'bin/check.mjs': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
    'package.json': JSON.stringify({ scripts: { test: `touch ${marker}` } }) });
  await locate('orchard', path);
  assert.equal((await cli(['validate'])).code, 0);
  const opened = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(opened.json.verify, ['npm test', 'node bin/check.mjs']);
  assert.deepEqual((await tool(await stdio(), { repository: 'orchard' })).json, opened.json);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

// spec: repository-context / Invalid verification commands
test('validate refuses verify as a bare string or with a multi-line command', async t => {
  const { cli, register } = await fixture(t);
  await register('apple', { title: 'apple', resource: 'https://github.com/example/apple', context: { verify: 'npm test' } });
  await register('banana', { title: 'banana', resource: 'https://github.com/example/banana', context: { verify: ['npm test\nrm -rf /'] } });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  assert.match(error.message, /team\/fruit\/apple: context\.verify: must be a list/);
  assert.match(error.message, /team\/fruit\/banana: context\.verify\[0\]: must be a single line/);
});

// spec: repository-context / References across hubs
test('references to the own hub and another workspace hub validate and open with their hubs', async t => {
  const { base, workspace, fruit, cli, register, checkout, locate } = await fixture(t);
  const notes = join(workspace, 'hubs/notes');
  await mkdir(notes);
  await writeFile(join(notes, 'hub.json'), JSON.stringify({ version: 1, id: 'personal/notes', description: 'Notes.', documents: ['README.md'], skills: [], links: [] }));
  await guide(notes, 'README');
  await guide(notes, 'orchard/ideas');
  await guide(fruit, 'guides/harvest');
  // Unqualified references stay in the declaring hub: personal/notes has no guides/harvest, fruit no orchard/ideas.
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'], context: { concepts: ['/guides/harvest', 'personal/notes:/orchard/ideas'] } });
  await locate('orchard', await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n' }));
  assert.equal((await cli(['validate'])).code, 0);
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(json.pointers.concepts.map(item => [item.hub, item.concept]), [['team/fruit', 'guides/harvest'], ['personal/notes', 'orchard/ideas']]);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'], context: { concepts: ['/orchard/ideas'] } });
  assert.match((await cli(['validate'])).error.message, /context\.concepts\[0\]: "\/orchard\/ideas" does not resolve: no such concept/);
});

// spec: repository-context / Unresolvable references
test('validate names each unresolvable reference and why', async t => {
  const { fruit, cli, register } = await fixture(t);
  await guide(fruit, 'guides/harvest');
  const note = '1700000000000-00000000-0000-4000-8000-000000000000';
  await mkdir(join(fruit, 'inbox'));
  await writeConcept(fruit, `inbox/${note}`, { type: 'Note', title: 'n', status: 'draft' });
  await register('orchard', { title: 'the orchard', resource: ORCHARD, context: { concepts: ['/guides/missing', 'nowhere:/guides/harvest', 'guides/harvest', `/inbox/${note}`] } });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  for (const [index, ref, why] of [[0, '/guides/missing', 'does not resolve: no such concept'], [1, 'nowhere:/guides/harvest', 'does not resolve: unknown hub'],
    [2, 'guides/harvest', 'is malformed'], [3, `/inbox/${note}`, 'does not resolve: inbox note']]) {
    assert.ok(error.message.includes(`team/fruit/orchard: context.concepts[${index}]: "${ref}" ${why}`), `${ref}: ${error.message}`);
  }
});

// spec: repository-context / Every emitted skill pointer reads
test('every skill pointer open emits reads with read-skill and read_skill', async t => {
  const { base, workspace, fruit, cli, register, checkout, locate, stdio } = await fixture(t);
  await mkdir(join(workspace, 'skills/orchard-ops'), { recursive: true });
  await writeFile(join(workspace, 'skills/orchard-ops/SKILL.md'), '---\nname: orchard-ops\ndescription: Operate the orchard.\n---\n\n# Orchard ops\n');
  await manifest(fruit, { skills: ['kit:independent-review'] });
  const personal = join(workspace, 'hubs/personal');
  await manifest(personal, { skills: [...JSON.parse(await readFile(join(personal, 'hub.json'), 'utf8')).skills, 'skills/orchard-ops/SKILL.md'] });
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'], context: { skills: ['kit:independent-review', 'skills/orchard-ops/SKILL.md'] } });
  await locate('orchard', await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n' }));
  assert.equal((await cli(['validate'])).code, 0);
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(json.pointers.skills.map(item => [item.reference, item.name]), [['kit:independent-review', 'independent-review'], ['skills/orchard-ops/SKILL.md', 'orchard-ops']]);
  assert.equal(json.pointers.skills[1].description, 'Operate the orchard.');
  assert.equal(json.pointers.skills[1].hub, 'personal/main');
  const client = await stdio();
  for (const { hub, reference } of json.pointers.skills) {
    const read = await cli(['read-skill', hub, reference]);
    assert.equal(read.code, 0, `${hub} ${reference}: ${JSON.stringify(read.error)}`);
    assert.match(read.json.content, /^---\nname: /);
    const viaMcp = await call(client, 'read_skill', { id: hub, reference });
    assert.equal(viaMcp.json?.content, read.json.content, reference);
  }
});

// spec: repository-context / Unreadable skill references
test('validate refuses a workspace skill no hub declares and a kit skill of a disabled addon', async t => {
  const { workspace, fruit, cli, register } = await fixture(t);
  await mkdir(join(workspace, 'skills/orphan'), { recursive: true });
  await writeFile(join(workspace, 'skills/orphan/SKILL.md'), '---\nname: orphan\ndescription: Nobody declares me.\n---\n');
  // The maps addon is opt-in, so disabled here, though a hub may still list its skill.
  await manifest(fruit, { skills: ['kit:behavior-map'] });
  await register('orchard', { title: 'the orchard', resource: ORCHARD, context: { skills: ['skills/orphan/SKILL.md', 'kit:behavior-map'] } });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  assert.ok(error.message.includes('team/fruit/orchard: context.skills[0]: "skills/orphan/SKILL.md" is not readable: no hub declares it'), error.message);
  assert.ok(error.message.includes('team/fruit/orchard: context.skills[1]: "kit:behavior-map" is not readable: its addon is not enabled'), error.message);
});

// spec: repository-context / Names, not configuration
test('MCP entries are server names only; URLs, command lines and mappings are refused', async t => {
  const { cli, register } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, context: { mcp: ['orchard-tracker', 'https://mcp.example.com', 'npx orchard-mcp --token x', { command: 'orchard-mcp' }] } });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  assert.doesNotMatch(error.message, /mcp\[0\]/);
  for (const [index, value] of [[1, '"https://mcp.example.com"'], [2, '"npx orchard-mcp --token x"'], [3, '{"command":"orchard-mcp"}']]) {
    assert.ok(error.message.includes(`team/fruit/orchard: context.mcp[${index}]: ${value} is not an MCP server name`), value);
  }
});

// spec: repository-context / Bad area paths
test('validate refuses escaping, glob and duplicate area paths and accepts the first', async t => {
  const { cli, register } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, context: { areas: [{ path: 'services/billing' }, { path: '../shared' }, { path: 'src/**' }, { path: 'services/billing' }] } });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  assert.doesNotMatch(error.message, /areas\[0\]\.path/);
  assert.match(error.message, /context\.areas\[1\]\.path: "\.\.\/shared" must be a directory/);
  assert.match(error.message, /context\.areas\[2\]\.path: "src\/\*\*" must be a directory/);
  assert.match(error.message, /context\.areas\[3\]\.path: "services\/billing" repeats context\.areas\[0\]/);
});

// spec: repository-context / Invalid packs
test('validate names each invalid pack and field: no description, bad globs, the reserved default', async t => {
  const { cli, register } = await fixture(t);
  await register('orchard', { title: 'the orchard', resource: ORCHARD, context: { packs: {
    undescribed: { files: ['*.md'] }, absolute: { description: 'a', files: ['/etc/**'] }, parent: { description: 'p', files: ['../x/**'] },
    backslash: { description: 'b', files: ['docs\\*.md'] }, braces: { description: 'c', files: ['ok/*.md'], exclude: ['{a,b}.md'] }, default: { description: 'd', files: ['*'] },
  } } });
  const { error } = await cli(['validate']);
  assert.equal(error.code, 'INVALID_CONTEXT');
  for (const expected of ['context.packs.undescribed.description: required', 'context.packs.absolute.files[0]: "/etc/**": it is absolute',
    'context.packs.parent.files[0]: "../x/**": it has an empty, . or .. segment', 'context.packs.backslash.files[0]: "docs\\\\*.md": it holds a backslash',
    'context.packs.braces.exclude[0]: "{a,b}.md": only *, ** and ? are wildcards', 'context.packs.default: default is reserved']) {
    assert.ok(error.message.includes(`team/fruit/orchard: ${expected}`), `${expected}: ${error.message}`);
  }
  assert.doesNotMatch(error.message, /braces\.files/);
});

// The fixture for opening with declared context: concepts with bodies, a skill, MCP names.
async function declared(t, context) {
  const env = await fixture(t);
  const { base, fruit, register, checkout, locate } = env;
  for (const id of ['guides/harvest', 'guides/pruning', 'guides/billing', 'guides/invoices', 'guides/shared', 'guides/docs'])
    await writeConcept(fruit, id, { type: 'Guide', title: `Guide ${id}`, description: `Summary of ${id}.`, verified: { by: 'human:me', at: '2026-01-01T00:00:00Z' } }, `# ${id}\n\nBODY-TEXT-${id}\n`);
  await manifest(fruit, { skills: ['kit:independent-review'] });
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'], context });
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n', 'docs/guide.md': 'g\n', 'services/billing/invoices/x.js': 'x\n', 'services/api.js': 'a\n' });
  await locate('orchard', path);
  return { ...env, path };
}

// spec: repository-context / Pointers without bodies
test('open lists the repository concept, then declared concepts with summaries and no body, the skill and the MCP name', async t => {
  const { cli, stdio } = await declared(t, { concepts: ['/guides/harvest', '/guides/pruning'], skills: ['kit:independent-review'], mcp: ['orchard-tracker'] });
  assert.equal((await cli(['validate'])).code, 0);
  const { json } = await cli(['repos', 'open', 'orchard']);
  const keys = Object.keys(json);
  assert.ok(keys.indexOf('repository') < keys.indexOf('pointers'));
  assert.deepEqual(json.pointers.concepts, ['harvest', 'pruning'].map(name => ({ hub: 'team/fruit', concept: `guides/${name}`, type: 'Guide', title: `Guide guides/${name}`,
    description: `Summary of guides/${name}.`, trust: 'human-reviewed', freshness: 'read' })));
  assert.deepEqual(json.pointers.skills.map(({ hub, reference, name }) => ({ hub, reference, name })), [{ hub: 'personal/main', reference: 'kit:independent-review', name: 'independent-review' }]);
  assert.ok(json.pointers.skills[0].description.length > 0);
  assert.deepEqual(json.pointers.mcp, ['orchard-tracker']);
  assert.doesNotMatch(JSON.stringify(json), /BODY-TEXT/);
  assert.deepEqual((await tool(await stdio(), { repository: 'orchard' })).json, json);
});

// spec: repository-context / Summarized declarations
test('without a subpath areas appear as counts, roles by name and packs with descriptions, unexpanded', async t => {
  const { cli } = await declared(t, {
    concepts: ['/guides/harvest'],
    areas: [{ path: 'services', concepts: ['/guides/shared', '/guides/billing'], mcp: ['ledger-db'] }, { path: 'services/billing', skills: ['kit:independent-review'] }],
    roles: { reviewer: { omit: ['/guides/harvest'], concepts: ['/guides/pruning'] } },
    packs: { release: { description: 'Cut a release of the orchard.', files: ['docs/**'], concepts: ['/guides/docs'] } },
  });
  assert.equal((await cli(['validate'])).code, 0);
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(json.areas, [{ path: 'services', concepts: 2, skills: 0, mcp: 1 }, { path: 'services/billing', concepts: 0, skills: 1, mcp: 0 }]);
  assert.deepEqual(json.roles, ['reviewer']);
  assert.deepEqual(json.packs, [{ name: 'release', description: 'Cut a release of the orchard.' }]);
  assert.deepEqual(json.pointers, { concepts: [json.pointers.concepts[0]], skills: [], mcp: [] });
  assert.equal(json.pointers.concepts[0].concept, 'guides/harvest');
  assert.ok(!('matchedAreas' in json));
  assert.doesNotMatch(JSON.stringify(json), /guides\/(shared|billing|pruning|docs)|ledger-db/);
});

// spec: repository-context / Nested areas
test('opening inside nested areas merges the repository, outer and inner pointers in order, each once', async t => {
  const { cli, stdio } = await declared(t, {
    concepts: ['/guides/harvest', '/guides/shared'], mcp: ['orchard-tracker'],
    areas: [{ path: 'services/billing', concepts: ['/guides/invoices', '/guides/shared'], mcp: ['ledger-db', 'orchard-tracker'] },
      { path: 'services', concepts: ['/guides/billing', '/guides/harvest'], skills: ['kit:independent-review'] }, { path: 'docs', concepts: ['/guides/docs'] }],
  });
  const { json } = await cli(['repos', 'open', 'orchard', 'services/billing/invoices']);
  assert.equal(json.tree.root, 'services/billing/invoices');
  assert.deepEqual(json.matchedAreas, ['services', 'services/billing']);
  assert.deepEqual(json.pointers.concepts.map(item => item.concept), ['guides/harvest', 'guides/shared', 'guides/billing', 'guides/invoices']);
  assert.deepEqual(json.pointers.skills.map(item => item.reference), ['kit:independent-review']);
  assert.deepEqual(json.pointers.mcp, ['orchard-tracker', 'ledger-db']);
  assert.ok(!('areas' in json));
  assert.deepEqual((await tool(await stdio(), { repository: 'orchard', path: 'services/billing/invoices' })).json, json);
  // An area matches by whole segments only.
  assert.deepEqual((await cli(['repos', 'open', 'orchard', 'services'])).json.matchedAreas, ['services']);
});

// spec: repository-context / Subpath outside every area
test('a subpath no area contains roots the tree there with only the repository pointers', async t => {
  const { cli } = await declared(t, { concepts: ['/guides/harvest'], areas: [{ path: 'services', concepts: ['/guides/billing'] }, { path: 'docs/guide', concepts: ['/guides/docs'] }] });
  const { json } = await cli(['repos', 'open', 'orchard', 'docs']);
  assert.equal(json.tree.root, 'docs');
  assert.deepEqual(json.tree.entries, ['docs/guide.md']);
  assert.deepEqual(json.matchedAreas, []);
  assert.deepEqual(json.pointers.concepts.map(item => item.concept), ['guides/harvest']);
});

// spec: repository-context / Deleted concept after validation
test('a deleted reference opens as a missing pointer with a warning, a non-mapping context fails, and repos lists both', async t => {
  const { fruit, cli, register, stdio } = await declared(t, { concepts: ['/guides/harvest', '/guides/pruning'] });
  assert.equal((await cli(['validate'])).code, 0);
  await rm(join(fruit, 'guides/harvest.md'));
  await register('lemon', { title: 'lemon grove', resource: 'https://github.com/example/lemon', aliases: ['lemon'], context: ['verify', 'npm test'] });
  const { json } = await cli(['repos', 'open', 'orchard']);
  assert.deepEqual(json.pointers.concepts[0], { hub: 'team/fruit', concept: 'guides/harvest', missing: true });
  assert.equal(json.pointers.concepts[1].concept, 'guides/pruning');
  assert.deepEqual(json.warnings, ['/guides/harvest no longer resolves (no such concept); run validate']);
  const lemon = await cli(['repos', 'open', 'lemon']);
  assert.equal(lemon.error.code, 'INVALID_CONTEXT');
  assert.match(lemon.error.message, /team\/fruit\/lemon: context: must be a mapping/);
  const client = await stdio();
  assert.equal((await tool(client, { repository: 'lemon' })).error.code, 'INVALID_CONTEXT');
  const listed = await cli(['repos']);
  assert.deepEqual(listed.json.repositories.map(item => item.id), ['team/fruit/lemon', 'team/fruit/orchard']);
  assert.deepEqual((await call(client, 'list_repos', {})).json.repositories.map(item => item.id), ['team/fruit/lemon', 'team/fruit/orchard']);
  assert.equal((await cli(['repos', 'sync'])).code, 0);
  assert.equal((await cli(['validate'])).error.code, 'INVALID_CONTEXT');
});

// spec: repository-context / Adversarial metadata
test('declared items at every bound still fit 8 KiB, trimmed after the tree and before root instructions, with where to read them', async t => {
  const { base, fruit, cli, register, checkout, locate } = await fixture(t);
  const wide = '𝔸'.repeat(299);
  for (let index = 0; index < 50; index++) await writeConcept(fruit, `guides/g${index}`, { type: 'Guide', title: `${wide}`.slice(0, 160), description: wide });
  const context = {
    verify: Array.from({ length: 10 }, (_, index) => `${'𝔹'.repeat(190)} ${index}`),
    concepts: Array.from({ length: 50 }, (_, index) => `/guides/g${index}`), mcp: Array.from({ length: 50 }, (_, index) => `m${'x'.repeat(60)}${index}`),
    areas: Array.from({ length: 50 }, (_, index) => ({ path: `area-${index}/${'p'.repeat(180)}`, concepts: ['/guides/g0'] })),
    roles: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`role-${index}-${'r'.repeat(30)}`, {}])),
    packs: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`pack-${index}`, { description: wide, files: ['**'] }])),
  };
  await register('orchard', { title: 'the orchard', resource: ORCHARD, aliases: ['orchard'], context });
  assert.equal((await cli(['validate'])).code, 0, 'the fixture is valid');
  // Missing on this machine: the declared items alone are trimmed to fit.
  const missing = (await cli(['repos', 'open', 'orchard'])).json;
  assert.equal(missing.status, 'missing');
  assert.ok(compact(missing) <= 8192);
  assert.equal(missing.truncated.declared.next, 'read team/fruit:/orchard --frontmatter');
  const files = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`file-${String(index).padStart(3, '0')}-${'n'.repeat(40)}.md`, 'x\n']));
  const path = await checkout(join(base, 'code/orchard'), ORCHARD, { 'AGENTS.md': 'a\n', 'CLAUDE.md': 'c\n', ...files, [`area-0/${'p'.repeat(180)}/deep/AGENTS.md`]: 'd\n' });
  await locate('orchard', path);
  for (const subpath of [undefined, `area-0/${'p'.repeat(180)}/deep`]) {
    const { json } = await cli(['repos', 'open', 'orchard', ...(subpath ? [subpath] : [])]);
    assert.ok(compact(json) <= 8192, `${subpath}: ${compact(json)}`);
    assert.deepEqual(json.instructions.slice(0, 2).map(item => item.path), ['AGENTS.md', 'CLAUDE.md']);
    assert.equal(json.resolution.path, path);
    // The tree went first, then declared items from the end; verify commands come first.
    assert.deepEqual(json.tree.entries, []);
    assert.ok(json.truncated.tree.omitted > 0);
    const { omitted, first, next } = json.truncated.declared;
    assert.ok(omitted > 0 && typeof first === 'string');
    assert.equal(next, 'read team/fruit:/orchard --frontmatter');
    // Ten commands of 200 four-byte characters cannot all fit: a prefix is kept, in order.
    assert.ok(json.verify.length > 0 && json.verify.length < 10 && json.verify.every((command, index) => command === context.verify[index]), 'verify is a prefix');
    assert.equal(first, 'verify');
    // Everything after the kept commands: matched area or area summaries, 50 concepts, 50 MCP names, 8 roles, 20 packs.
    assert.equal(omitted, 10 - json.verify.length + (subpath ? 1 : 50) + 50 + 50 + 8 + 20);
  }
});
