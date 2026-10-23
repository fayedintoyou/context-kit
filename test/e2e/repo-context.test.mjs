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
  assert.deepEqual(json.truncated, { tree: { omitted: 400 - shown, first: sorted[shown], next: 'repos open team/fruit/orchard <directory>' } });
  assert.equal(json.tree.files, 400);
  const mcp = (await tool(await stdio(), { repository: 'orchard' })).json;
  assert.deepEqual(mcp, json);
  assert.ok(compact(mcp) <= 8192);
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
