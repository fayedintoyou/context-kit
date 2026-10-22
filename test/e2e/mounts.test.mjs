import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// A workspace on an isolated machine (no system or global git config, so no credential
// helpers), plus local git repositories holding hubs, reached over file://. No network.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-mounts-')));
  t.after(async () => { await exec('chmod', ['-R', 'u+w', base]).catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: join(base, 'home'), XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const name of ['CONTEXT_KIT_ROOT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_COUNT']) delete env[name];
  await mkdir(env.HOME);
  const run = async (args, extraEnv = {}) => {
    const started = Date.now();
    try {
      const { stdout, stderr } = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env: { ...env, ...extraEnv } });
      return { code: 0, json: JSON.parse(stdout), output: stdout + stderr, ms: Date.now() - started };
    } catch (error) {
      return { code: error.code, json: error.stdout ? JSON.parse(error.stdout) : undefined, error: error.stderr ? JSON.parse(error.stderr).error : undefined,
        output: `${error.stdout}${error.stderr}`, ms: Date.now() - started };
    }
  };
  const workspace = join(base, 'workspace');
  assert.equal((await run(['init', workspace])).code, 0);
  const cli = (...args) => run(['--root', workspace, ...args]);
  const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim();
  // A repository with the given files committed on main; returns { path, url, commit(files) }.
  const repository = async (name, files) => {
    const path = join(base, name);
    await mkdir(path, { recursive: true });
    await git(path, 'init', '-q', '-b', 'main');
    const commit = async (changes, message = 'change') => {
      for (const [file, content] of Object.entries(changes)) {
        await mkdir(join(path, file, '..'), { recursive: true });
        if (content === null) await rm(join(path, file), { force: true });
        else if (typeof content === 'object') await symlink(content.symlink, join(path, file));
        else await writeFile(join(path, file), content);
      }
      await git(path, 'add', '-A');
      await git(path, 'commit', '-q', '-m', message);
      return git(path, 'rev-parse', 'HEAD');
    };
    const first = await commit(files, 'first');
    return { path, url: `file://${path}`, commit, first };
  };
  const config = async () => JSON.parse(await readFile(join(workspace, 'context-kit.json'), 'utf8'));
  const writeConfig = data => writeFile(join(workspace, 'context-kit.json'), JSON.stringify(data, null, 2) + '\n');
  return { base, env, workspace, run, cli, git, repository, config, writeConfig };
}
const hub = (id, concepts = { 'README.md': 'unverified' }) => ({
  'hub.json': JSON.stringify({ version: 1, id, description: `${id} hub.`, documents: ['README.md'], skills: [], links: [] }),
  ...Object.fromEntries(Object.entries(concepts).map(([file, trust]) => [file,
    `---\ntype: Guide\ntitle: ${id} ${file}\n${trust === 'human-reviewed' ? 'verified: { by: human:ana, at: 2026-01-01T00:00:00Z }\n' : ''}---\n\n# ${id} ${file}\n`])) });
const under = (prefix, files) => Object.fromEntries(Object.entries(files).map(([file, content]) => [`${prefix}/${file}`, content]));
const listing = async path => (await readdir(path, { recursive: true }).catch(() => [])).sort();

// spec: hub-federation / Invalid mount declaration
test('validate rejects badly shaped mounts and a mount named like a workspace hub', async t => {
  const { workspace, cli, config, writeConfig } = await fixture(t);
  const original = await config();
  const commit = '0123456789abcdef0123456789abcdef01234567';
  await writeConfig({ ...original, mounts: {
    Shared: { source: 'https://github.com/example/shared', commit },
    pinned: { source: 'https://github.com/example/shared', ref: 'main', commit: 'main' },
    extra: { source: 'https://github.com/example/shared', commit, branch: 'main' } } });
  const invalid = await cli('validate');
  assert.equal(invalid.error.code, 'INVALID_CONFIG');
  for (const name of ['mounts.Shared', 'mounts.pinned', 'mounts.extra']) assert.match(invalid.error.message, new RegExp(name.replace('.', '\\.')));
  assert.match(invalid.error.message, /commit must be a full 40-hex/);
  assert.match(invalid.error.message, /unknown keys "branch"/);

  await mkdir(join(workspace, 'hubs/team'));
  for (const [file, content] of Object.entries(hub('shared'))) await writeFile(join(workspace, 'hubs/team', file), content);
  await writeConfig({ ...original, mounts: { shared: { source: 'https://github.com/example/shared', commit } } });
  const clash = await cli('validate');
  assert.equal(clash.error.code, 'MOUNT_EXISTS');
  assert.match(clash.error.message, /shared/);
});

// spec: hub-federation / Credentials in a source
test('sources with credentials are refused without echoing them', async t => {
  const { cli, config, writeConfig } = await fixture(t);
  const before = await readFile(join((await cli('list')).json.root, 'context-kit.json'), 'utf8');
  for (const source of ['https://user:s3cret@example.com/x.git', 'https://s3cret@example.com/x.git', 'https://example.com/x.git?token=s3cret']) {
    const added = await cli('mounts', 'add', 'shared', source);
    assert.equal(added.error?.code, 'INVALID_INPUT', source);
    assert.doesNotMatch(added.output, /s3cret/);
  }
  assert.equal(await readFile(join((await cli('list')).json.root, 'context-kit.json'), 'utf8'), before);

  await writeConfig({ ...await config(), mounts: { shared: { source: 'https://user:s3cret@example.com/x.git', commit: '0123456789abcdef0123456789abcdef01234567' } } });
  const validated = await cli('validate');
  assert.equal(validated.error.code, 'INVALID_CONFIG');
  assert.match(validated.error.message, /mounts\.shared/);
  assert.doesNotMatch(validated.output, /s3cret/);
});

// spec: hub-federation / Private source without access
test('a source answering 401 fails fast with FETCH_FAILED and changes nothing', async t => {
  const { workspace, cli, config, writeConfig } = await fixture(t);
  const server = createServer((request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="private"', 'Content-Type': 'text/plain' });
    response.end('authentication required');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const source = `http://127.0.0.1:${server.address().port}/private/hub.git`;
  const before = await readFile(join(workspace, 'context-kit.json'), 'utf8');
  const added = await cli('mounts', 'add', 'private', source);
  assert.equal(added.error?.code, 'FETCH_FAILED');
  assert.match(added.error.message, /authentication failed/);
  assert.ok(added.ms < 20000, `took ${added.ms} ms`);
  assert.doesNotMatch(added.output, /:\/\/[^/\s"]*@/);
  assert.equal(await readFile(join(workspace, 'context-kit.json'), 'utf8'), before);
  assert.deepEqual(await listing(join(workspace, '.state/mounts')), []);

  const commit = '0123456789abcdef0123456789abcdef01234567';
  await writeConfig({ ...await config(), mounts: { private: { source, ref: 'main', commit } } });
  const declared = await readFile(join(workspace, 'context-kit.json'), 'utf8');
  const fetched = await cli('mounts', 'fetch');
  assert.notEqual(fetched.code, 0);
  assert.deepEqual(fetched.json.failed, ['private']);
  const [mount] = fetched.json.mounts;
  assert.equal(mount.error.code, 'FETCH_FAILED');
  assert.match(mount.error.message, /authentication failed/);
  assert.equal(mount.status, 'unfetched');
  assert.ok(fetched.ms < 20000, `took ${fetched.ms} ms`);
  assert.doesNotMatch(fetched.output, /:\/\/[^/\s"]*@/);
  assert.equal(await readFile(join(workspace, 'context-kit.json'), 'utf8'), declared);
  assert.deepEqual((await listing(join(workspace, '.state/mounts'))).filter(path => !path.startsWith('.git')), []);
});

// spec: hub-federation / Mount a hub from another repository
test('mounts add pins a hub from another repository and fetches it outside hubs/', async t => {
  const { base, workspace, cli, config, repository } = await fixture(t);
  // A symlinked directory in the mounted tree is never walked: its concepts are not counted.
  const outside = join(base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.md'), '---\ntype: Guide\n---\n# Outside\n');
  const source = await repository('shared-context', { ...under('hubs/data', hub('team/data', { 'README.md': 'human-reviewed', 'tables/orders.md': 'unverified' })),
    'hubs/data/elsewhere': { symlink: outside } });
  const hubsBefore = await listing(join(workspace, 'hubs'));
  const added = await cli('mounts', 'add', 'shared', source.url, '--path', 'hubs/data');
  assert.equal(added.code, 0, added.output);
  assert.deepEqual((await config()).mounts, { shared: { source: source.url, path: 'hubs/data', ref: 'main', commit: source.first } });
  const listed = await cli('mounts');
  assert.deepEqual(listed.json.mounts, [{ name: 'shared', source: source.url, path: 'hubs/data', ref: 'main', commit: source.first, status: 'fetched',
    manifestId: 'team/data', trust: { 'human-reviewed': 1, 'machine-confirmed': 0, unverified: 1 } }]);
  assert.deepEqual(added.json.mount, listed.json.mounts[0]);
  assert.deepEqual(await listing(join(workspace, 'hubs')), hubsBefore);
  // The export is read-only and lives in untracked state.
  const [key] = (await readdir(join(workspace, '.state/mounts/shared')));
  if (process.getuid?.() !== 0) await assert.rejects(writeFile(join(workspace, '.state/mounts/shared', key, 'README.md'), 'changed'), { code: 'EACCES' });
});

// spec: hub-federation / Source is not a hub
test('mounts add refuses a non-hub, an escaping or symlinked path and a taken name', async t => {
  const { workspace, cli, repository } = await fixture(t);
  const source = await repository('shared-context', { ...under('hubs/data', hub('team/data')), 'hubs/empty/notes.md': '# notes\n', 'hubs/link': { symlink: 'data' } });
  assert.equal((await cli('mounts', 'add', 'shared', source.url, '--path', 'hubs/data')).code, 0);
  const before = await readFile(join(workspace, 'context-kit.json'), 'utf8');
  const attempts = [
    [['other', source.url, '--path', 'hubs/empty'], 'NOT_A_HUB'],
    [['other', source.url, '--path', '../outside'], 'INVALID_PATH'],
    [['other', source.url, '--path', 'hubs/link'], 'INVALID_PATH'],
    [['shared', source.url, '--path', 'hubs/data'], 'MOUNT_EXISTS']];
  for (const [args, code] of attempts) {
    const result = await cli('mounts', 'add', ...args);
    assert.equal(result.error?.code, code, args.join(' '));
  }
  assert.equal(await readFile(join(workspace, 'context-kit.json'), 'utf8'), before);
  assert.deepEqual((await readdir(join(workspace, '.state/mounts'))).sort(), ['.git', 'shared']);
});

// spec: hub-federation / Fresh machine fetches its mounts
test('a fresh copy of a workspace fetches every mount at its pin', async t => {
  const { base, workspace, run, repository } = await fixture(t);
  const data = await repository('data-context', under('hubs/data', hub('team/data')));
  const platform = await repository('platform-context', hub('team/platform', { 'README.md': 'human-reviewed' }));
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'data', data.url, '--path', 'hubs/data'])).code, 0);
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'platform', platform.url])).code, 0);
  // Upstream moves on; the pins stay where the workspace recorded them.
  await data.commit(under('hubs/data', { 'more.md': '---\ntype: Guide\n---\n# More\n' }));
  const copy = join(base, 'other-machine');
  await cp(workspace, copy, { recursive: true, filter: path => !path.startsWith(join(workspace, '.state')) });
  const declared = await readFile(join(copy, 'context-kit.json'), 'utf8');
  assert.deepEqual((await run(['--root', copy, 'mounts'])).json.mounts.map(mount => mount.status), ['unfetched', 'unfetched']);
  const fetched = await run(['--root', copy, 'mounts', 'fetch']);
  assert.equal(fetched.code, 0, fetched.output);
  assert.deepEqual(fetched.json.failed, []);
  const listed = (await run(['--root', copy, 'mounts'])).json.mounts;
  assert.deepEqual(listed.map(({ name, status, commit, manifestId }) => ({ name, status, commit, manifestId })), [
    { name: 'data', status: 'fetched', commit: data.first, manifestId: 'team/data' },
    { name: 'platform', status: 'fetched', commit: platform.first, manifestId: 'team/platform' }]);
  assert.deepEqual(listed[0].trust, { 'human-reviewed': 0, 'machine-confirmed': 0, unverified: 1 });
  assert.equal(await readFile(join(copy, 'context-kit.json'), 'utf8'), declared);
});

// spec: hub-federation / One source unreachable
test('one unreachable source fails alone and the command exits nonzero', async t => {
  const { base, workspace, run, repository } = await fixture(t);
  const kept = await repository('kept', hub('team/kept'));
  const gone = await repository('gone', hub('team/gone'));
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'gone', gone.url])).code, 0);
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'kept', kept.url])).code, 0);
  const copy = join(base, 'other-machine');
  await cp(workspace, copy, { recursive: true, filter: path => !path.startsWith(join(workspace, '.state')) });
  await rm(gone.path, { recursive: true, force: true });
  const fetched = await run(['--root', copy, 'mounts', 'fetch']);
  assert.notEqual(fetched.code, 0);
  assert.deepEqual(fetched.json.failed, ['gone']);
  const [failed, ok] = fetched.json.mounts;
  assert.equal(failed.name, 'gone');
  assert.equal(failed.error.code, 'FETCH_FAILED');
  assert.equal(failed.status, 'unfetched');
  assert.deepEqual({ name: ok.name, status: ok.status, outcome: ok.outcome }, { name: 'kept', status: 'fetched', outcome: 'fetched' });
  // The workspace that fetched before the source went away keeps its content.
  assert.deepEqual((await run(['--root', workspace, 'mounts'])).json.mounts.map(mount => mount.status), ['fetched', 'fetched']);
});

// spec: hub-federation / Declaration changes under a fetched mount
// Reads of mounted hubs arrive with the mounted-reads slice; here the listing is the read.
test('a changed path or source is unfetched until fetched again, never the old tree', async t => {
  const { base, cli, config, writeConfig, repository, git } = await fixture(t);
  const source = await repository('shared-context', { ...under('hubs/data', hub('team/data')), ...under('hubs/platform', hub('team/platform', { 'README.md': 'human-reviewed' })) });
  assert.equal((await cli('mounts', 'add', 'shared', source.url, '--path', 'hubs/data')).code, 0);
  const current = await config();
  await writeConfig({ ...current, mounts: { shared: { ...current.mounts.shared, path: 'hubs/platform' } } });
  let [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, manifestId: mount.manifestId, path: mount.path }, { status: 'unfetched', manifestId: null, path: 'hubs/platform' });
  assert.match(mount.reason, /mounts fetch shared/);
  assert.equal((await cli('mounts', 'fetch', 'shared')).code, 0);
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, manifestId: mount.manifestId, path: mount.path, commit: mount.commit, trust: mount.trust },
    { status: 'fetched', manifestId: 'team/platform', path: 'hubs/platform', commit: source.first, trust: { 'human-reviewed': 1, 'machine-confirmed': 0, unverified: 0 } });

  // Only the source changes, to another repository holding the same commit.
  const mirror = join(base, 'mirror.git');
  await git(base, 'clone', '-q', '--bare', source.path, mirror);
  const moved = await config();
  await writeConfig({ ...moved, mounts: { shared: { ...moved.mounts.shared, source: `file://${mirror}` } } });
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, source: mount.source, manifestId: mount.manifestId }, { status: 'unfetched', source: `file://${mirror}`, manifestId: null });
  await rm(source.path, { recursive: true, force: true }); // The new source alone must serve it.
  const fetched = await cli('mounts', 'fetch', 'shared');
  assert.equal(fetched.code, 0, fetched.output);
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, source: mount.source, manifestId: mount.manifestId, commit: mount.commit },
    { status: 'fetched', source: `file://${mirror}`, manifestId: 'team/platform', commit: source.first });
});

// spec: hub-federation / Pin from another machine
test('an older pin from another machine is fetched exactly, not the moved branch tip', async t => {
  const { workspace, cli, run, config, writeConfig, repository } = await fixture(t);
  const source = await repository('shared-context', hub('team/data')); // B: one concept
  const older = source.first;
  const pinned = await source.commit({ 'two.md': '---\ntype: Guide\n---\n# Two\n' }); // A: two
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  assert.equal((await config()).mounts.shared.commit, pinned);
  await source.commit({ 'three.md': '---\ntype: Guide\n---\n# Three\n' }); // C: three, the branch tip
  const current = await config();
  await writeConfig({ ...current, mounts: { shared: { ...current.mounts.shared, commit: older } } });
  let [mount] = (await cli('mounts')).json.mounts;
  assert.equal(mount.status, 'unfetched'); // A's content is not served under B's pin.
  // Protocol v0 refuses an unadvertised SHA, so this also takes the ref-history fallback.
  const fetched = await run(['--root', workspace, 'mounts', 'fetch'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.version', GIT_CONFIG_VALUE_0: '0' });
  assert.equal(fetched.code, 0, fetched.output);
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, commit: mount.commit, concepts: mount.trust.unverified }, { status: 'fetched', commit: older, concepts: 1 });
  assert.equal((await config()).mounts.shared.commit, older);
});

// spec: hub-federation / Remove a mount
test('mounts remove deletes the declaration and fetched content, once', async t => {
  const { workspace, cli, config, repository } = await fixture(t);
  const source = await repository('shared-context', hub('shared-hub'));
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const removed = await cli('mounts', 'remove', 'shared');
  assert.equal(removed.code, 0, removed.output);
  assert.equal((await config()).mounts, undefined);
  assert.deepEqual((await cli('mounts')).json.mounts, []);
  assert.deepEqual((await cli('list')).json.hubs.map(item => item.id), ['personal/main']);
  assert.deepEqual(await listing(join(workspace, '.state/mounts')), ['.git']);
  assert.equal((await cli('mounts', 'remove', 'shared')).error.code, 'UNKNOWN_MOUNT');
  assert.equal((await cli('mounts', 'fetch', 'shared')).error.code, 'UNKNOWN_MOUNT');
});

// spec: hub-federation / List over CLI and MCP
test('mounts and list_mounts agree, and MCP cannot change mounts even with writes', async t => {
  const { env, workspace, cli, config, writeConfig, repository } = await fixture(t);
  const source = await repository('shared-context', hub('team/data', { 'README.md': 'human-reviewed', 'notes.md': 'unverified' }));
  const later = await source.commit({ 'later.md': '---\ntype: Guide\n---\n# Later\n' });
  assert.equal((await cli('mounts', 'add', 'shared', source.url, '--ref', 'main')).code, 0);
  const current = await config();
  await writeConfig({ ...current, mounts: { ...current.mounts, staging: { source: source.url, ref: 'main', commit: source.first } } });
  const listed = (await cli('mounts')).json;
  assert.deepEqual(listed.mounts.map(({ name, status, commit, trust }) => ({ name, status, commit, trust })), [
    { name: 'shared', status: 'fetched', commit: later, trust: { 'human-reviewed': 1, 'machine-confirmed': 0, unverified: 2 } },
    { name: 'staging', status: 'unfetched', commit: source.first, trust: null }]);

  const client = new Client({ name: 'mounts-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--allow-write'], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.filter(tool => /mount/.test(tool.name)).map(tool => tool.name), ['list_mounts']);
  assert.equal(tools.find(tool => tool.name === 'list_mounts').annotations.readOnlyHint, true);
  assert.deepEqual((await client.callTool({ name: 'list_mounts', arguments: {} })).structuredContent, listed);
  for (const name of ['add_mount', 'fetch_mounts', 'remove_mount']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'UNKNOWN_OPERATION');
  }
});
