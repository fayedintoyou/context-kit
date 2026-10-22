import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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
  const run = async (args, extraEnv = {}, input) => {
    const started = Date.now();
    try {
      const running = exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env: { ...env, ...extraEnv } });
      if (input !== undefined) running.child.stdin.end(input);
      const { stdout, stderr } = await running;
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
        else if (content.symlink) await symlink(content.symlink, join(path, file));
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
  // An MCP SDK client over stdio for the workspace.
  const mcp = async (...flags) => {
    const client = new Client({ name: 'mounts-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, ...flags], env, stderr: 'pipe' }));
    t.after(() => client.close());
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return result.isError ? { error: JSON.parse(result.content[0].text).error } : { json: result.structuredContent };
    };
    return { client, call };
  };
  return { base, env, workspace, run, cli, git, repository, config, writeConfig, mcp };
}
const hub = (id, concepts = { 'README.md': 'unverified' }) => ({
  'hub.json': JSON.stringify({ version: 1, id, description: `${id} hub.`, documents: ['README.md'], skills: [], links: [] }),
  ...Object.fromEntries(Object.entries(concepts).map(([file, trust]) => [file,
    `---\ntype: Guide\ntitle: ${id} ${file}\n${trust === 'human-reviewed' ? 'verified: { by: human:ana, at: 2026-01-01T00:00:00Z }\n' : ''}---\n\n# ${id} ${file}\n`])) });
const under = (prefix, files) => Object.fromEntries(Object.entries(files).map(([file, content]) => [`${prefix}/${file}`, content]));
const listing = async path => (await readdir(path, { recursive: true }).catch(() => [])).sort();

// spec: hub-federation / Invalid mount declaration
test('validate rejects badly shaped mounts and a mount named like a workspace hub', async t => {
  const { workspace, run, cli, config, writeConfig } = await fixture(t);
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
  // A write to the clashing name says so, rather than calling the workspace hub a mount.
  const captured = await run(['--root', workspace, 'capture', 'shared', 'A note'], {}, 'Body.\n');
  assert.equal(captured.error?.code, 'MOUNT_EXISTS', captured.output);
  assert.match(captured.error.message, /mounts remove shared/);
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
test('a changed path or source is unfetched until fetched again, never the old tree', async t => {
  const { base, cli, config, writeConfig, repository, git } = await fixture(t);
  const source = await repository('shared-context', { ...under('hubs/data', hub('team/data')), ...under('hubs/platform', hub('team/platform', { 'README.md': 'human-reviewed' })) });
  assert.equal((await cli('mounts', 'add', 'shared', source.url, '--path', 'hubs/data')).code, 0);
  const current = await config();
  await writeConfig({ ...current, mounts: { shared: { ...current.mounts.shared, path: 'hubs/platform' } } });
  let [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, manifestId: mount.manifestId, path: mount.path }, { status: 'unfetched', manifestId: null, path: 'hubs/platform' });
  assert.match(mount.reason, /mounts fetch shared/);
  // The old tree is never read under the new provenance.
  let read = await cli('read', 'shared:/README');
  assert.equal(read.error?.code, 'MOUNT_NOT_FETCHED');
  assert.match(read.error.message, /mounts fetch shared/);
  assert.equal((await cli('mounts', 'fetch', 'shared')).code, 0);
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, manifestId: mount.manifestId, path: mount.path, commit: mount.commit, trust: mount.trust },
    { status: 'fetched', manifestId: 'team/platform', path: 'hubs/platform', commit: source.first, trust: { 'human-reviewed': 1, 'machine-confirmed': 0, unverified: 0 } });
  read = await cli('read', 'shared:/README');
  assert.equal(read.code, 0, read.output);
  assert.match(read.json.content, /^# team\/platform README\.md/);
  assert.deepEqual(read.json.mount, { name: 'shared', source: source.url, path: 'hubs/platform', commit: source.first });

  // Only the source changes, to another repository holding the same commit.
  const mirror = join(base, 'mirror.git');
  await git(base, 'clone', '-q', '--bare', source.path, mirror);
  const moved = await config();
  await writeConfig({ ...moved, mounts: { shared: { ...moved.mounts.shared, source: `file://${mirror}` } } });
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, source: mount.source, manifestId: mount.manifestId }, { status: 'unfetched', source: `file://${mirror}`, manifestId: null });
  assert.equal((await cli('read', 'shared', 'README')).error?.code, 'MOUNT_NOT_FETCHED');
  await rm(source.path, { recursive: true, force: true }); // The new source alone must serve it.
  const fetched = await cli('mounts', 'fetch', 'shared');
  assert.equal(fetched.code, 0, fetched.output);
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, source: mount.source, manifestId: mount.manifestId, commit: mount.commit },
    { status: 'fetched', source: `file://${mirror}`, manifestId: 'team/platform', commit: source.first });
  read = await cli('read', 'shared', 'README');
  assert.equal(read.code, 0, read.output);
  assert.deepEqual(read.json.mount, { name: 'shared', source: `file://${mirror}`, path: 'hubs/platform', commit: source.first });
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
  assert.equal((await cli('read', 'shared:/two')).error?.code, 'MOUNT_NOT_FETCHED');
  // Protocol v0 refuses an unadvertised SHA, so this also takes the ref-history fallback.
  const fetched = await run(['--root', workspace, 'mounts', 'fetch'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.version', GIT_CONFIG_VALUE_0: '0' });
  assert.equal(fetched.code, 0, fetched.output);
  [mount] = (await cli('mounts')).json.mounts;
  assert.deepEqual({ status: mount.status, commit: mount.commit, concepts: mount.trust.unverified }, { status: 'fetched', commit: older, concepts: 1 });
  assert.equal((await config()).mounts.shared.commit, older);
  // B's content: neither A's two.md nor C's three.md.
  assert.equal((await cli('read', 'shared:/README')).json.mount.commit, older);
  for (const id of ['two', 'three']) assert.equal((await cli('read', 'shared', id)).error?.code, 'UNKNOWN_CONCEPT', id);
  assert.deepEqual((await cli('browse', 'shared')).json.concepts.map(concept => concept.id), ['README']);
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
  for (const name of ['add_mount', 'fetch_mounts', 'upgrade_mount', 'remove_mount']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'UNKNOWN_OPERATION');
  }
});

// Review round 1 regressions.

// spec: hub-federation / Mount a hub from another repository
test('symlinked state never lets mount commands write or delete outside the workspace', async t => {
  const { base, workspace, cli, config, repository } = await fixture(t);
  const source = await repository('shared-context', hub('team/data'));
  const outside = join(base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'unrelated');
  await mkdir(join(workspace, '.state/mounts'), { recursive: true });
  await symlink(outside, join(workspace, '.state/mounts/shared'));
  const before = await readFile(join(workspace, 'context-kit.json'), 'utf8');
  const added = await cli('mounts', 'add', 'shared', source.url);
  assert.equal(added.error?.code, 'PATH_ESCAPE');
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.equal(await readFile(join(workspace, 'context-kit.json'), 'utf8'), before);

  // The cache path too, at any component.
  await rm(join(workspace, '.state/mounts/shared'));
  assert.deepEqual(await readdir(join(workspace, '.state/mounts')), []); // Refused before any change.
  await symlink(outside, join(workspace, '.state/mounts/.git'));
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).error?.code, 'PATH_ESCAPE');
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  await rm(join(workspace, '.state/mounts/.git'));

  // A mount added normally, then its state swapped for a symlink: remove refuses and keeps the pin.
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  await exec('chmod', ['-R', 'u+w', join(workspace, '.state/mounts/shared')]);
  await rm(join(workspace, '.state/mounts/shared'), { recursive: true });
  await symlink(outside, join(workspace, '.state/mounts/shared'));
  assert.equal((await cli('mounts')).json.mounts[0].status, 'broken');
  const unsafe = await cli('read', 'shared:/README');
  assert.equal(unsafe.error?.code, 'MOUNT_BROKEN');
  assert.match(unsafe.error.message, /replace the symlinked path under \.state with a real directory/);
  assert.equal((await cli('mounts', 'remove', 'shared')).error?.code, 'PATH_ESCAPE');
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.ok((await config()).mounts.shared);
});

// spec: hub-federation / Mount a hub from another repository
test('exports are raw blobs: no inherited filters run', async t => {
  const { base, workspace, run, config, repository } = await fixture(t);
  const marker = join(base, 'smudged');
  const source = await repository('shared-context', { ...hub('team/data'), '.gitattributes': '* filter=evil\n' });
  const env = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'filter.evil.smudge', GIT_CONFIG_VALUE_0: `touch ${marker}; cat`,
    GIT_CONFIG_KEY_1: 'filter.evil.required', GIT_CONFIG_VALUE_1: 'true' };
  const added = await run(['--root', workspace, 'mounts', 'add', 'shared', source.url], env);
  assert.equal(added.code, 0, added.output);
  assert.equal(added.json.mount.status, 'fetched');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const [key] = await readdir(join(workspace, '.state/mounts/shared'));
  assert.equal(await readFile(join(workspace, '.state/mounts/shared', key, '.gitattributes'), 'utf8'), '* filter=evil\n');
  assert.equal((await config()).mounts.shared.commit, source.first);
});

// spec: hub-federation / Private source without access
test('fetch failures never carry git output, even when insteadOf adds a token', async t => {
  const { workspace, run, config, writeConfig } = await fixture(t);
  const seen = [];
  const server = createServer((request, response) => { seen.push(request.url); response.writeHead(500); response.end('boom'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${origin}/t/s3cret/?token=s3cret&r=.insteadOf`, GIT_CONFIG_VALUE_0: `${origin}/declared/` };
  const added = await run(['--root', workspace, 'mounts', 'add', 'shared', `${origin}/declared/hub.git`], env);
  assert.equal(added.error?.code, 'FETCH_FAILED');
  assert.ok(seen.some(url => url.includes('s3cret')), 'the rewrite reached the server');
  assert.doesNotMatch(added.output, /s3cret/);
  await writeConfig({ ...await config(), mounts: { shared: { source: `${origin}/declared/hub.git`, ref: 'main', commit: '0123456789abcdef0123456789abcdef01234567' } } });
  const fetched = await run(['--root', workspace, 'mounts', 'fetch'], env);
  assert.equal(fetched.json.mounts[0].error.code, 'FETCH_FAILED');
  assert.doesNotMatch(fetched.output, /s3cret/);
});

// spec: hub-federation / Fresh machine fetches its mounts
test('concurrent fetches and adds are serialized, and a stale lock is taken over', async t => {
  const { base, workspace, run, config, repository } = await fixture(t);
  const one = await repository('one', hub('team/one'));
  const two = await repository('two', hub('team/two'));
  const added = await Promise.all([run(['--root', workspace, 'mounts', 'add', 'one', one.url]), run(['--root', workspace, 'mounts', 'add', 'two', two.url])]);
  assert.deepEqual(added.map(result => result.code), [0, 0], added.map(result => result.output).join('\n'));
  assert.deepEqual(Object.keys((await config()).mounts), ['one', 'two']);

  const copy = join(base, 'other-machine');
  await cp(workspace, copy, { recursive: true, filter: path => !path.startsWith(join(workspace, '.state')) });
  const fetches = await Promise.all(Array.from({ length: 4 }, () => run(['--root', copy, 'mounts', 'fetch'])));
  assert.deepEqual(fetches.map(result => result.code), [0, 0, 0, 0], fetches.map(result => result.output).join('\n'));
  assert.deepEqual((await run(['--root', copy, 'mounts'])).json.mounts.map(mount => mount.status), ['fetched', 'fetched']);
  for (const name of ['one', 'two']) assert.equal((await readdir(join(copy, '.state/mounts', name))).length, 1);
  assert.deepEqual((await readdir(join(copy, '.state/mounts'))).filter(entry => entry.startsWith('.lock')), []);

  // A lock left by a process that is gone does not block.
  const gone = (await exec(process.execPath, ['-e', 'console.log(process.pid)'])).stdout.trim();
  const third = join(base, 'third-machine');
  await cp(copy, third, { recursive: true, filter: path => !path.startsWith(join(copy, '.state')) });
  await mkdir(join(third, '.state/mounts'), { recursive: true });
  await writeFile(join(third, '.state/mounts/.lock-mount-one'), JSON.stringify({ pid: Number(gone), at: Date.now(), token: 'old' }));
  const fetched = await run(['--root', third, 'mounts', 'fetch', 'one']);
  assert.equal(fetched.code, 0, fetched.output);
  assert.equal(fetched.json.mounts[0].status, 'fetched');
});

// spec: hub-federation / Source is not a hub
test('a tree over budget is refused before anything is exported, hidden entries included', async t => {
  const { workspace, cli, repository } = await fixture(t);
  const bulk = Object.fromEntries(Array.from({ length: 10010 }, (_, i) => [`.bulk/${i}.txt`, '']));
  const source = await repository('big', { ...hub('team/big'), ...bulk });
  const before = await readFile(join(workspace, 'context-kit.json'), 'utf8');
  const added = await cli('mounts', 'add', 'big', source.url);
  assert.equal(added.error?.code, 'TOO_LARGE');
  assert.match(added.error.message, /10000 entries/);
  assert.equal(await readFile(join(workspace, 'context-kit.json'), 'utf8'), before);
  assert.deepEqual((await readdir(join(workspace, '.state/mounts'))).filter(entry => !entry.startsWith('.')), []);
});

// spec: hub-federation / Mount a hub from another repository
test('an annotated tag ref pins the commit it points at', async t => {
  const { cli, config, repository, git } = await fixture(t);
  const source = await repository('shared-context', hub('team/data'));
  await git(source.path, 'tag', '-a', 'v1', '-m', 'release');
  await source.commit({ 'later.md': '---\ntype: Guide\n---\n# Later\n' });
  const added = await cli('mounts', 'add', 'shared', source.url, '--ref', 'v1');
  assert.equal(added.code, 0, added.output);
  assert.deepEqual((await config()).mounts.shared, { source: source.url, ref: 'v1', commit: source.first });
  assert.equal(added.json.mount.trust.unverified, 1);
});

// Review round 2 regression.

// spec: hub-federation / Fresh machine fetches its mounts
test('many takers of a stale lock (or stale breaker): no success without its pin, one fetch exports', async t => {
  const { base, workspace, run, config, repository } = await fixture(t);
  const source = await repository('shared-context', hub('team/data'));
  const gone = Number((await exec(process.execPath, ['-e', 'console.log(process.pid)'])).stdout.trim());
  const stale = name => writeFile(join(workspace, '.state/mounts', name), JSON.stringify({ pid: gone, at: Date.now(), token: 'stale' }));
  await mkdir(join(workspace, '.state/mounts'), { recursive: true });
  for (let round = 0; round < 4; round++) {
    await stale('.lock-config');
    if (round === 3) {
      // A breaker left by a process that stopped mid-takeover.
      const breaker = join(workspace, '.state/mounts/.lock-config.break');
      await writeFile(breaker, JSON.stringify({ pid: gone, at: Date.now() - 60000, token: 'stale-breaker' }));
      const old = new Date(Date.now() - 60000);
      await utimes(breaker, old, old);
    }
    const names = Array.from({ length: round === 3 ? 8 : 6 }, (_, i) => `r${round}-${i}`);
    const added = await Promise.all(names.map(name => run(['--root', workspace, 'mounts', 'add', name, source.url])));
    // A lost takeover race may refuse an add (MOUNT_BUSY, nothing changed); it never reports
    // success without its pin.
    const pins = (await config()).mounts ?? {};
    for (const [index, name] of names.entries()) {
      const result = added[index];
      if (result.code === 0) assert.ok(pins[name], `round ${round}: ${name} succeeded but its pin is gone`);
      else {
        assert.equal(result.error?.code, 'MOUNT_BUSY', result.output);
        assert.equal(pins[name], undefined);
      }
    }
    if (round < 3) assert.deepEqual(added.map(result => result.code), names.map(() => 0), added.map(result => result.output).join('\n'));
  }

  const copy = join(base, 'other-machine');
  await cp(workspace, copy, { recursive: true, filter: path => !path.startsWith(join(workspace, '.state')) });
  await mkdir(join(copy, '.state/mounts'), { recursive: true });
  await writeFile(join(copy, '.state/mounts/.lock-mount-r0-0'), JSON.stringify({ pid: gone, at: Date.now(), token: 'stale' }));
  const fetches = await Promise.all(Array.from({ length: 5 }, () => run(['--root', copy, 'mounts', 'fetch', 'r0-0'])));
  assert.deepEqual(fetches.map(result => result.code), [0, 0, 0, 0, 0], fetches.map(result => result.output).join('\n'));
  assert.deepEqual(fetches.map(result => result.json.mounts[0].outcome).sort(), ['fetched', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.deepEqual((await readdir(join(copy, '.state/mounts'))).filter(entry => entry.startsWith('.lock')), []);
  // A breaker can rarely outlive its owner (it is then stale in 10 s); no lock itself remains.
  assert.deepEqual((await readdir(join(workspace, '.state/mounts'))).filter(entry => entry.startsWith('.lock') && !entry.endsWith('.break')), []);
});

// Review round 5 regression.

// spec: hub-federation / Remove a mount
test('remove that has lost its mount lock refuses before touching the declaration', async t => {
  const { workspace, run, config, repository } = await fixture(t);
  const source = await repository('shared-context', hub('team/data'));
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'shared', source.url])).code, 0);
  const locks = join(workspace, '.state/mounts');
  // Hold the config lock (as a live process), so remove waits with its mount lock taken.
  await writeFile(join(locks, '.lock-config'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'test' }));
  const removing = run(['--root', workspace, 'mounts', 'remove', 'shared']);
  const mountLock = join(locks, '.lock-mount-shared');
  for (let i = 0; i < 400 && !(await readFile(mountLock, 'utf8').catch(() => '')).includes('"token"'); i++) await new Promise(done => setTimeout(done, 25));
  // Another command takes the mount lock over, then the config lock frees up.
  await writeFile(mountLock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'usurper' }));
  await rm(join(locks, '.lock-config'));
  const removed = await removing;
  assert.equal(removed.error?.code, 'MOUNT_BUSY', removed.output);
  assert.match(removed.error.message, /nothing was changed/);
  assert.ok((await config()).mounts.shared, 'the declaration must survive a refused remove');
  await rm(mountLock);
  assert.equal((await run(['--root', workspace, 'mounts'])).json.mounts[0].status, 'fetched');
});

// Reading mounted hubs (slice mounted-reads).

const PERSONAL = { id: 'personal/main', description: 'My context, preferences and current projects.' };
const orders = '---\ntype: Table\ntitle: Orders\ndescription: One row per order.\n---\n\n# Orders\n\nGrain: one row per pelican order.\n';
// A mounted hub team/data at hubs/data with a human-reviewed README and tables/orders.
async function sharedMount(fixtureValue, extra = {}) {
  const { cli, repository } = fixtureValue;
  const source = await repository('shared-context', under('hubs/data', { ...hub('team/data', { 'README.md': 'human-reviewed' }), 'tables/orders.md': orders, ...extra }));
  const added = await cli('mounts', 'add', 'shared', source.url, '--path', 'hubs/data');
  assert.equal(added.code, 0, added.output);
  return { source, mount: { name: 'shared', source: source.url, path: 'hubs/data', commit: source.first } };
}
const iso = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

// spec: hub-federation / Read a mounted concept
test('a mounted hub reads like a workspace hub under its mount name, over CLI and MCP', async t => {
  const f = await fixture(t);
  const { cli, mcp } = f;
  const { mount } = await sharedMount(f);
  const list = await cli('list');
  assert.deepEqual(list.json.hubs, [PERSONAL, { id: 'shared', description: 'team/data hub.', manifestId: 'team/data', mount }]);
  assert.equal(list.json.warnings, undefined);

  const browse = await cli('browse', 'shared');
  assert.equal(browse.code, 0, browse.output);
  assert.deepEqual([browse.json.hub, browse.json.mount], ['shared', mount]);
  assert.deepEqual(browse.json.concepts.map(({ id, ref, trust }) => ({ id, ref, trust })), [{ id: 'README', ref: 'shared:/README', trust: 'human-reviewed' }]);
  assert.deepEqual(browse.json.directories.map(directory => directory.id), ['tables']);
  const tables = await cli('browse', 'shared', 'tables');
  assert.deepEqual(tables.json.concepts.map(({ id, ref, type, trust }) => ({ id, ref, type, trust })),
    [{ id: 'tables/orders', ref: 'shared:/tables/orders', type: 'Table', trust: 'unverified' }]);

  const read = await cli('read', 'shared', 'tables/orders');
  assert.equal(read.code, 0, read.output);
  assert.deepEqual({ hub: read.json.hub, mount: read.json.mount, id: read.json.id, ref: read.json.ref, trust: read.json.okf.trust },
    { hub: 'shared', mount, id: 'tables/orders', ref: 'shared:/tables/orders', trust: 'unverified' });
  assert.match(read.json.content, /pelican order/);

  const found = await cli('search', 'pelican order');
  assert.deepEqual(found.json.results.map(({ hub: id, mount: provenance, ref, okf }) => ({ hub: id, mount: provenance, ref, trust: okf.trust })),
    [{ hub: 'shared', mount, ref: 'shared:/tables/orders', trust: 'unverified' }]);

  const context = await cli('context', 'shared');
  assert.deepEqual({ id: context.json.manifest.id, manifestId: context.json.manifestId, mount: context.json.mount },
    { id: 'shared', manifestId: 'team/data', mount });
  assert.deepEqual(context.json.documents.map(({ path, ref, okf }) => ({ path, ref, trust: okf.trust })), [{ path: 'README.md', ref: 'shared:/README', trust: 'human-reviewed' }]);

  // The same results over MCP.
  const { call } = await mcp();
  for (const [tool, args, viaCli] of [['list_hubs', {}, list], ['browse_hub', { id: 'shared' }, browse], ['browse_hub', { id: 'shared', path: 'tables' }, tables],
    ['read_concept', { id: 'shared', concept: 'tables/orders' }, read], ['search_context', { query: 'pelican order' }, found], ['get_context', { id: 'shared' }, context]]) {
    assert.deepEqual((await call(tool, args)).json, viaCli.json, tool);
  }
});

// spec: hub-federation / Mount's own freshness policy
test('freshness of a mounted concept follows the mounted manifest, not the workspace hub', async t => {
  const { workspace, cli, repository } = await fixture(t);
  const metric = `---\ntype: Metric\ntitle: Revenue\nverified: { by: "human:ana", at: ${iso(Date.now() - 2 * 86400000)} }\n---\n\n# Revenue\n`;
  const source = await repository('metrics', { 'revenue.md': metric, 'hub.json': JSON.stringify({ version: 1, id: 'team/metrics', description: 'Metrics.',
    documents: ['revenue.md'], skills: [], links: [], freshness: { types: { Metric: 'P1D' } } }) });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const manifest = join(workspace, 'hubs/personal/hub.json');
  const personal = JSON.parse(await readFile(manifest, 'utf8'));
  await writeFile(manifest, JSON.stringify({ ...personal, documents: [...personal.documents, 'revenue.md'] }));
  await writeFile(join(workspace, 'hubs/personal/revenue.md'), metric);
  const action = async id => (await cli('context', id)).json.documents.find(document => document.path === 'revenue.md').freshness.action;
  assert.equal(await action('shared'), 'verify');
  assert.equal(await action('personal/main'), 'read');
  assert.equal((await cli('read', 'shared:/revenue')).json.freshness.action, 'verify');
});

// spec: hub-federation / Source gone after fetch
test('a fetched mount reads offline after its source is gone, with no warning', async t => {
  const f = await fixture(t);
  const { cli } = f;
  const { source, mount } = await sharedMount(f);
  await rm(source.path, { recursive: true, force: true });
  const list = await cli('list');
  assert.deepEqual([list.code, list.json.hubs.map(item => item.id), list.json.warnings], [0, ['personal/main', 'shared'], undefined]);
  const browse = await cli('browse', 'shared', 'tables');
  assert.deepEqual([browse.code, browse.json.concepts.map(concept => concept.id), browse.json.warnings], [0, ['tables/orders'], []]);
  const read = await cli('read', 'shared:/tables/orders');
  assert.deepEqual([read.code, read.json.mount, read.json.warnings], [0, mount, []]);
  const found = await cli('search', 'pelican');
  assert.deepEqual([found.code, found.json.results.length, found.json.warnings], [0, 1, undefined]);
  const repos = await cli('repos');
  assert.deepEqual([repos.code, repos.json.warnings], [0, []]);
});

// spec: hub-federation / Read by reference
test('a result ref reads the concept over CLI and MCP; a disagreeing hub is INVALID_INPUT', async t => {
  const f = await fixture(t);
  const { cli, mcp } = f;
  await sharedMount(f);
  const [result] = (await cli('search', 'pelican')).json.results;
  assert.equal(result.ref, 'shared:/tables/orders');
  const byRef = await cli('read', result.ref);
  assert.equal(byRef.code, 0, byRef.output);
  assert.deepEqual([byRef.json.hub, byRef.json.id], ['shared', 'tables/orders']);
  assert.deepEqual(byRef.json, (await cli('read', 'shared', 'tables/orders')).json);
  const { call } = await mcp();
  assert.deepEqual((await call('read_concept', { concept: result.ref })).json, byRef.json);
  assert.equal((await call('read_concept', { id: 'shared', concept: result.ref })).json.id, 'tables/orders');
  const mismatch = await call('read_concept', { id: 'personal/main', concept: result.ref });
  assert.equal(mismatch.error.code, 'INVALID_INPUT');
  assert.equal((await cli('read', 'personal/main', result.ref)).error.code, 'INVALID_INPUT');
  assert.equal((await call('read_concept', { concept: 'tables/orders' })).error.code, 'INVALID_INPUT');
  // Workspace concepts carry refs too.
  const personal = await cli('context', 'personal/main');
  assert.equal(personal.json.documents[0].ref, 'personal/main:/README');
  assert.equal((await cli('read', 'personal/main:/README')).json.id, 'README');
});

// spec: hub-federation / Same paths in two bundles
test('a workspace hub and a mount keep their own index, okf_version, log and README', async t => {
  const { workspace, cli, repository } = await fixture(t);
  await writeFile(join(workspace, 'hubs/personal/log.md'), '# Log\n\n## 2026-01-01\n\nStarted.\n');
  const source = await repository('shared-context', { ...hub('team/data'),
    'README.md': '---\ntype: Guide\ntitle: Shared readme\n---\n\n# Shared readme\n\nThe shared text.\n',
    'index.md': '---\nokf_version: "0.3"\n---\n\n# Shared index\n', 'log.md': '# Log\n\n## 2026-02-02\n\nShared log.\n' });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  assert.match((await cli('browse', 'personal/main')).json.index, /^# Personal context/);
  assert.match((await cli('browse', 'shared')).json.index, /^# Shared index/);
  const [own, mounted] = [(await cli('context', 'personal/main')).json, (await cli('context', 'shared')).json];
  assert.deepEqual([own.okfVersion, mounted.okfVersion], ['0.2', '0.3']);
  assert.ok(mounted.warnings.some(warning => /okf_version 0\.3/.test(warning)));
  assert.match((await cli('read', 'personal/main', 'README')).json.content, /^# Personal context/);
  assert.match((await cli('read', 'shared', 'README')).json.content, /The shared text/);
  // Reserved files stay files of their own bundle, not concepts.
  assert.equal((await cli('read', 'shared', 'log')).error.code, 'NOT_A_CONCEPT');
  assert.equal((await cli('read', 'personal/main', 'log')).error.code, 'NOT_A_CONCEPT');
});

// spec: hub-federation / Escaping symlinks in a mount
test('symlinks are never followed in a mounted tree or a workspace hub', async t => {
  const { base, workspace, cli, mcp, repository } = await fixture(t);
  const outside = join(base, 'outside');
  await mkdir(join(outside, 'dir'), { recursive: true });
  await writeFile(join(outside, 'secret.md'), '---\ntype: Guide\n---\n\n# Outside file OUTSIDE-TEXT\n');
  await writeFile(join(outside, 'dir/x.md'), '---\ntype: Guide\n---\n\n# Outside dir OUTSIDE-TEXT\n');
  // Committed in the source: the export leaves symlinks out and says so.
  const source = await repository('shared-context', { ...hub('team/data'), 'secret.md': { symlink: join(outside, 'secret.md') }, 'elsewhere': { symlink: join(outside, 'dir') } });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  // Neither link is listed, read (UNKNOWN_CONCEPT, no outside text), browsed or found.
  const unreachable = async (file, directory) => {
    const browse = await cli('browse', 'shared');
    assert.deepEqual(browse.json.concepts.map(concept => concept.id), ['README']);
    assert.deepEqual(browse.json.directories, []);
    for (const concept of [file, `${directory}/x`]) {
      const read = await cli('read', 'shared', concept);
      assert.equal(read.error?.code, 'UNKNOWN_CONCEPT', `${concept}: ${read.output}`);
      assert.doesNotMatch(read.output, /OUTSIDE-TEXT/);
    }
    assert.ok((await cli('browse', 'shared', directory)).error, directory);
    assert.deepEqual((await cli('search', 'OUTSIDE-TEXT')).json.results, []);
    assert.ok(browse.json.warnings.some(warning => warning.startsWith(`${file}.md:`)), browse.output);
  };
  await unreachable('secret', 'elsewhere');

  // Planted in the export itself: still neither listed, read nor searched.
  const [key] = await readdir(join(workspace, '.state/mounts/shared'));
  const tree = join(workspace, '.state/mounts/shared', key);
  await exec('chmod', ['u+w', tree]);
  await symlink(join(outside, 'secret.md'), join(tree, 'planted.md'));
  await symlink(join(outside, 'dir'), join(tree, 'planted'));
  await exec('chmod', ['u-w', tree]);
  await unreachable('planted', 'planted');
  const { call } = await mcp();
  assert.deepEqual((await call('search_context', { query: 'OUTSIDE-TEXT' })).json.results, []);

  // A workspace hub's symlinked directory is never walked either (OKF traversal uses withFileTypes).
  await symlink(join(outside, 'dir'), join(workspace, 'hubs/personal/elsewhere'));
  const own = await cli('browse', 'personal/main');
  assert.deepEqual(own.json.directories, []);
  assert.equal((await cli('read', 'personal/main', 'elsewhere/x')).error?.code, 'UNKNOWN_CONCEPT');
  assert.equal((await cli('browse', 'personal/main', 'elsewhere')).error?.code, 'PATH_ESCAPE');
  assert.deepEqual((await cli('search', 'OUTSIDE-TEXT')).json.results, []);
  assert.equal((await cli('validate')).code, 0);
});

// spec: knowledge-format / Nonconformant mount
test('validate passes with warnings naming the mount and each nonconformant file', async t => {
  const { cli, repository } = await fixture(t);
  const note = name => `inbox/1700000000000-0000000${name}-0000-0000-0000-000000000000.md`;
  const source = await repository('shared-context', { ...hub('team/data'), 'notes.md': '# No frontmatter\n', 'log.md': '# Log\n\n## yesterday\n',
    // Inbox notes that cannot be read: not UTF-8, and over the 128 KiB file limit.
    [note(1)]: Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]), [note(2)]: `---\ntype: Note\n---\n\n${'x'.repeat(140 * 1024)} Personal context\n` });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const validated = await cli('validate');
  assert.equal(validated.code, 0, validated.output);
  assert.equal(validated.json.valid, true);
  for (const file of ['notes.md', 'log.md', note(1), note(2)]) assert.ok(validated.json.warnings.some(warning => warning.startsWith(`shared: ${file}:`)), file);
  assert.equal((await cli('read', 'shared', 'notes')).error.code, 'NOT_A_CONCEPT');
  // Unreadable mounted notes never break inbox reads of the other hubs, or of the mount itself.
  const found = await cli('search', 'Personal context', '--inbox');
  assert.equal(found.code, 0, found.output);
  assert.ok(found.json.results.some(result => result.hub === 'personal/main'));
  for (const file of [note(1), note(2)]) assert.ok(found.json.warnings.some(warning => warning === `mount shared: ${file} skipped: not a readable file`), file);
  assert.doesNotMatch(found.output, /\.state/);
  const context = await cli('context', 'shared', '--inbox');
  assert.equal(context.code, 0, context.output);
  assert.deepEqual(context.json.inbox.notes, []);
});

// spec: hub-federation / Manifest fields that point elsewhere
test('a mounted manifest\'s links, skills and spec stores are warnings and not offered', async t => {
  const { cli, repository } = await fixture(t);
  const source = await repository('shared-context', { ...hub('team/data'), 'hub.json': JSON.stringify({ version: 1, id: 'team/data', description: 'Data.',
    documents: ['README.md'], skills: ['kit:context-kit'], links: ['team/elsewhere'], specStores: ['shared-specs'] }) });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const context = await cli('context', 'shared');
  assert.equal(context.code, 0, context.output);
  for (const name of ['team/elsewhere', 'kit:context-kit', 'shared-specs']) assert.ok(context.json.warnings.some(warning => warning.includes(name)), name);
  assert.deepEqual([context.json.manifest.links, context.json.manifest.skills, context.json.manifest.specStores], [[], [], []]);
  const skills = await cli('skills');
  assert.ok(skills.json.skills.every(skill => !skill.hubs.includes('shared')));
  assert.equal((await cli('read-skill', 'shared', 'kit:context-kit')).error.code, 'UNKNOWN_SKILL');
  assert.ok((await cli('specs', 'stores')).json.stores.every(store => store.storeId !== 'shared-specs'));
});

// spec: hub-federation / Writes against a mount
test('capture and repository adds against a mount fail READ_ONLY_MOUNT over CLI and MCP', async t => {
  const f = await fixture(t);
  const { workspace, run, cli, mcp } = f;
  await sharedMount(f);
  const state = join(workspace, '.state/mounts/shared');
  const before = await listing(state);
  const captured = await run(['--root', workspace, 'capture', 'shared', 'A note'], {}, 'Body.\n');
  assert.equal(captured.error?.code, 'READ_ONLY_MOUNT', captured.output);
  assert.equal((await cli('repos', 'add', 'shared', 'https://github.com/example/orders')).error?.code, 'READ_ONLY_MOUNT');
  const { call } = await mcp('--allow-write');
  assert.equal((await call('capture_note', { id: 'shared', title: 'A note', body: 'Body.' })).error.code, 'READ_ONLY_MOUNT');
  assert.equal((await call('add_repo', { id: 'shared', upstream: 'https://github.com/example/orders' })).error.code, 'READ_ONLY_MOUNT');
  assert.deepEqual(await listing(state), before);
  assert.equal((await cli('read', 'shared', 'README')).code, 0);
  // Refused first, even where the workspace's own hubs would fail to load.
  await writeFile(join(workspace, 'hubs/personal/hub.json'), '{ not json');
  assert.equal((await run(['--root', workspace, 'capture', 'shared', 'A note'], {}, 'Body.\n')).error?.code, 'READ_ONLY_MOUNT');
  assert.equal((await cli('repos', 'add', 'shared', 'https://github.com/example/orders')).error?.code, 'READ_ONLY_MOUNT');
});

// spec: hub-federation / Mount not fetched yet
test('an unfetched mount warns in list, search, repos and validate, and fails reads with MOUNT_NOT_FETCHED', async t => {
  const { cli, mcp, config, writeConfig } = await fixture(t);
  await writeConfig({ ...await config(), mounts: { shared: { source: 'https://github.com/example/shared', ref: 'main', commit: '0123456789abcdef0123456789abcdef01234567' } } });
  const remedy = /mounts fetch shared/;
  const list = await cli('list');
  assert.deepEqual(list.json.hubs, [PERSONAL]);
  assert.ok(list.json.warnings.some(warning => remedy.test(warning)), list.output);
  const found = await cli('search', 'Personal context');
  assert.ok(found.json.results.length && found.json.results.every(result => result.hub === 'personal/main'));
  assert.ok(found.json.warnings.some(warning => remedy.test(warning)));
  for (const args of [['read', 'shared:/README'], ['read', 'shared', 'README'], ['context', 'shared'], ['browse', 'shared']]) {
    const result = await cli(...args);
    assert.equal(result.error?.code, 'MOUNT_NOT_FETCHED', args.join(' '));
    assert.match(result.error.message, remedy);
  }
  const { call } = await mcp();
  assert.equal((await call('read_concept', { concept: 'shared:/README' })).error.code, 'MOUNT_NOT_FETCHED');
  assert.ok((await cli('repos')).json.warnings.some(warning => remedy.test(warning)));
  const validated = await cli('validate');
  assert.equal(validated.code, 0, validated.output);
  assert.ok(validated.json.warnings.some(warning => remedy.test(warning)));
});

// spec: hub-federation / Broken mount
test('a broken mount fails when addressed with MOUNT_BROKEN naming the file, and the workspace still works', async t => {
  const { cli, mcp, config, writeConfig, repository } = await fixture(t);
  const source = await repository('shared-context', hub('team/data'));
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const broken = await source.commit({ 'README.md': '# No frontmatter\n' });
  const current = await config();
  await writeConfig({ ...current, mounts: { shared: { ...current.mounts.shared, commit: broken } } });
  assert.equal((await cli('mounts', 'fetch', 'shared')).code, 0);
  assert.equal((await cli('mounts')).json.mounts[0].status, 'broken');
  const context = await cli('context', 'shared');
  assert.equal(context.error?.code, 'MOUNT_BROKEN');
  assert.match(context.error.message, /README\.md/);
  const { call } = await mcp();
  for (const [tool, args] of [['get_context', { id: 'shared' }], ['read_concept', { concept: 'shared:/README' }]]) {
    const result = await call(tool, args);
    assert.equal(result.error?.code, 'MOUNT_BROKEN', tool);
    assert.match(result.error.message, /README\.md/);
  }
  const listed = await call('list_hubs');
  assert.deepEqual(listed.json.hubs, [PERSONAL]);
  assert.ok(listed.json.warnings.some(warning => /shared is broken/.test(warning)));
  assert.equal((await cli('context', 'personal/main')).code, 0);
  assert.equal((await cli('read', 'personal/main:/README')).code, 0);
  const validated = await cli('validate');
  assert.equal(validated.code, 0, validated.output);
  assert.ok(validated.json.warnings.some(warning => /shared is broken/.test(warning)));
});

// Upgrades (slice mount-upgrade).

const guide = title => `---\ntype: Guide\ntitle: ${title}\n---\n\n# ${title}\n`;
const repositoryConcept = (title, resource) => `---\ntype: Repository\ntitle: ${title}\nresource: ${resource}\n---\n\n# ${title}\n`;
// What a caller sees of a mount: its declaration bytes, listing, a read and the export on disk.
async function observe({ workspace, cli }) {
  return {
    config: await readFile(join(workspace, 'context-kit.json'), 'utf8'),
    mounts: (await cli('mounts')).json.mounts,
    browse: (await cli('browse', 'shared')).json?.concepts?.map(concept => concept.id),
    readme: (await cli('read', 'shared:/README')).json?.content,
    exports: await listing(join(workspace, '.state/mounts/shared')),
  };
}
const exportsOf = async path => (await readdir(path)).filter(entry => !entry.startsWith('.'));
// No git diagnostics or local state paths in what a command printed.
const clean = result => {
  assert.doesNotMatch(result.output, /fatal:|error: |hint:|warning: |remote: /);
  assert.doesNotMatch(result.output, /\.state\/mounts\/(\.git|shared)\//);
};

// spec: hub-federation / Upstream moves on
test('upgrade --check reports what moves without moving the pin; upgrade then moves it', async t => {
  const f = await fixture(t);
  const { cli, config, repository } = f;
  const source = await repository('shared-context', { ...hub('team/data'), 'old.md': guide('Old'), 'tables/orders.md': guide('Orders'),
    'repos/billing.md': repositoryConcept('Billing', 'https://github.com/example/billing') });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const next = await source.commit({ 'tables/customers.md': guide('Customers'), 'tables/orders.md': guide('Orders, now with refunds'), 'old.md': null,
    'repos/api.md': repositoryConcept('API', 'https://github.com/example/api') });

  const first = await observe(f);
  assert.equal((await cli('read', 'shared:/tables/customers')).error?.code, 'UNKNOWN_CONCEPT');
  const checked = await cli('mounts', 'upgrade', 'shared', '--check');
  assert.equal(checked.code, 0, checked.output);
  assert.equal(checked.json.outcome, 'available');
  assert.deepEqual(checked.json.from, { commit: source.first, ref: 'main', status: 'fetched' });
  assert.deepEqual(checked.json.to, { commit: next, ref: 'main', manifestId: 'team/data' });
  assert.deepEqual(checked.json.changes, {
    concepts: { added: ['shared:/repos/api', 'shared:/tables/customers'], removed: ['shared:/old'], changed: ['shared:/tables/orders'] },
    repositories: { added: [{ ref: 'shared:/repos/api', title: 'API', upstream: 'https://github.com/example/api' }], removed: [], changed: [] } });
  assert.equal(checked.json.mount.commit, source.first);
  // The check moved nothing: same pin, listing, reads and export.
  assert.deepEqual(await observe(f), first);
  assert.equal((await cli('read', 'shared:/tables/customers')).error?.code, 'UNKNOWN_CONCEPT');

  const upgraded = await cli('mounts', 'upgrade', 'shared');
  assert.equal(upgraded.code, 0, upgraded.output);
  assert.equal(upgraded.json.outcome, 'upgraded');
  assert.deepEqual(upgraded.json.changes, checked.json.changes);
  assert.deepEqual((await config()).mounts.shared, { source: source.url, ref: 'main', commit: next });
  assert.deepEqual({ status: upgraded.json.mount.status, commit: upgraded.json.mount.commit }, { status: 'fetched', commit: next });
  const read = await cli('read', 'shared:/tables/customers');
  assert.equal(read.code, 0, read.output);
  assert.equal(read.json.mount.commit, next);
  assert.equal((await cli('read', 'shared:/old')).error?.code, 'UNKNOWN_CONCEPT');
  // The new commit's export, and the old pin's for reads that loaded it just before.
  assert.equal((await exportsOf(join(f.workspace, '.state/mounts/shared'))).length, 2);

  // Nothing new upstream: current, nothing written.
  const before = await readFile(join(f.workspace, 'context-kit.json'), 'utf8');
  const again = await cli('mounts', 'upgrade', 'shared');
  assert.equal(again.code, 0, again.output);
  assert.equal(again.json.outcome, 'current');
  assert.equal(await readFile(join(f.workspace, 'context-kit.json'), 'utf8'), before);
});

// spec: hub-federation / Upstream moves on
test('upgrade --to a commit, an annotated tag, and from an unfetched pin', async t => {
  const f = await fixture(t);
  const { base, workspace, run, cli, config, repository, git } = f;
  const source = await repository('shared-context', hub('team/data'));
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const second = await source.commit({ 'two.md': guide('Two') });
  await git(source.path, 'tag', '-a', 'v2', '-m', 'release two');
  const tagObject = await git(source.path, 'rev-parse', 'v2');
  const tip = await source.commit({ 'three.md': guide('Three') });

  // A commit: exactly that commit, not the tip; the ref stays.
  const toCommit = await cli('mounts', 'upgrade', 'shared', '--to', second);
  assert.equal(toCommit.code, 0, toCommit.output);
  assert.deepEqual((await config()).mounts.shared, { source: source.url, ref: 'main', commit: second });
  assert.equal((await cli('read', 'shared', 'three')).error?.code, 'UNKNOWN_CONCEPT');
  // An annotated tag pins the commit it points at and becomes the ref.
  await cli('mounts', 'upgrade', 'shared', '--to', source.first);
  const toTag = await cli('mounts', 'upgrade', 'shared', '--to', 'v2');
  assert.equal(toTag.code, 0, toTag.output);
  assert.deepEqual(toTag.json.changes.concepts, { added: ['shared:/two'], removed: [], changed: [] });
  assert.deepEqual((await config()).mounts.shared, { source: source.url, ref: 'v2', commit: second });
  assert.notEqual(tagObject, second);
  // A tag object's SHA is not a commit: refused, pin kept.
  const object = await cli('mounts', 'upgrade', 'shared', '--to', tagObject);
  assert.equal(object.error?.code, 'FETCH_FAILED', object.output);
  assert.match(object.error.message, /not a commit/);
  assert.equal((await config()).mounts.shared.commit, second);
  for (const bad of ['--oops', 'a..b']) assert.equal((await cli('mounts', 'upgrade', 'shared', '--to', bad)).error?.code, 'INVALID_INPUT', bad);
  assert.equal((await cli('mounts', 'upgrade', 'nothing')).error?.code, 'UNKNOWN_MOUNT');
  assert.equal((await cli('mounts', 'fetch', 'shared', '--check')).error?.code, 'INVALID_INPUT');

  // On a machine that has not fetched the pin, there is nothing to compare with, but the
  // candidate is still checked and the upgrade works.
  const copy = join(base, 'other-machine');
  await cp(workspace, copy, { recursive: true, filter: path => !path.startsWith(join(workspace, '.state')) });
  const unfetched = await run(['--root', copy, 'mounts', 'upgrade', 'shared', '--to', 'main', '--check']);
  assert.equal(unfetched.code, 0, unfetched.output);
  assert.deepEqual({ outcome: unfetched.json.outcome, status: unfetched.json.from.status, changes: unfetched.json.changes, to: unfetched.json.to.commit },
    { outcome: 'available', status: 'unfetched', changes: null, to: tip });
  assert.match(unfetched.json.baseline, /mounts fetch shared/);
  assert.equal(JSON.parse(await readFile(join(copy, 'context-kit.json'), 'utf8')).mounts.shared.commit, second);
  const moved = await run(['--root', copy, 'mounts', 'upgrade', 'shared', '--to', 'main']);
  assert.equal(moved.code, 0, moved.output);
  assert.deepEqual({ status: moved.json.mount.status, commit: moved.json.mount.commit, ref: moved.json.mount.ref }, { status: 'fetched', commit: tip, ref: 'main' });
});

// spec: hub-federation / Failed upgrade keeps the pin
test('a broken candidate and an unknown commit fail and keep the pin, content and reads', async t => {
  const f = await fixture(t);
  const { cli, repository } = f;
  const source = await repository('shared-context', { ...hub('team/data'), 'tables/orders.md': guide('Orders') });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  await source.commit({ 'README.md': '# No frontmatter\n', 'tables/customers.md': guide('Customers') });
  const before = await observe(f);

  for (const args of [[], ['--check']]) {
    const broken = await cli('mounts', 'upgrade', 'shared', ...args);
    assert.equal(broken.error?.code, 'MOUNT_BROKEN', broken.output);
    assert.match(broken.error.message, /README\.md/);
    assert.match(broken.error.message, new RegExp(`pin stays at ${source.first}`));
    clean(broken);
    assert.deepEqual(await observe(f), before);
  }
  const unknown = await cli('mounts', 'upgrade', 'shared', '--to', 'f'.repeat(40));
  assert.equal(unknown.error?.code, 'FETCH_FAILED', unknown.output);
  clean(unknown);
  const noRef = await cli('mounts', 'upgrade', 'shared', '--to', 'no-such-branch');
  assert.equal(noRef.error?.code, 'FETCH_FAILED', noRef.output);
  clean(noRef);
  assert.deepEqual(await observe(f), before);
  assert.equal((await cli('read', 'shared:/tables/customers')).error?.code, 'UNKNOWN_CONCEPT');
  assert.deepEqual((await readdir(join(f.workspace, '.state/mounts/shared'))).filter(entry => entry.startsWith('.tmp-')), []);
});

// spec: hub-federation / Failed upgrade keeps the pin
test('offline, upgrade and --check fail with FETCH_FAILED and reads keep the pin', async t => {
  const f = await fixture(t);
  const { cli, repository } = f;
  const source = await repository('shared-context', hub('team/data'));
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  await source.commit({ 'two.md': guide('Two') });
  const before = await observe(f);
  await rm(source.path, { recursive: true, force: true });
  for (const args of [[], ['--check'], ['--to', source.first.replace(/^./, c => c === 'a' ? 'b' : 'a')]]) {
    const result = await cli('mounts', 'upgrade', 'shared', ...args);
    assert.equal(result.error?.code, 'FETCH_FAILED', result.output);
    assert.match(result.error.message, /repository not found|not available|does not have commit|git failed/);
    clean(result);
  }
  assert.deepEqual(await observe(f), before);
  assert.equal(before.mounts[0].status, 'fetched');
});

// spec: hub-federation / Upstream moves on
test('upgrades and fetches running together serialize on the mount lock', async t => {
  const f = await fixture(t);
  const { workspace, run, config, repository } = f;
  const source = await repository('shared-context', hub('team/data'));
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'shared', source.url])).code, 0);
  for (let round = 0; round < 3; round++) {
    const next = await source.commit({ [`round-${round}.md`]: guide(`Round ${round}`) });
    const results = await Promise.all([
      run(['--root', workspace, 'mounts', 'upgrade', 'shared']), run(['--root', workspace, 'mounts', 'fetch', 'shared']),
      run(['--root', workspace, 'mounts', 'upgrade', 'shared']), run(['--root', workspace, 'mounts', 'fetch']),
      run(['--root', workspace, 'mounts', 'upgrade', 'shared', '--check'])]);
    assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0, 0], results.map(result => result.output).join('\n'));
    // Exactly one upgrade moved the pin; the other found it current.
    assert.deepEqual([results[0], results[2]].map(result => result.json.outcome).sort(), ['current', 'upgraded']);
    assert.equal((await config()).mounts.shared.commit, next);
    const [mount] = (await run(['--root', workspace, 'mounts'])).json.mounts;
    assert.deepEqual({ status: mount.status, commit: mount.commit }, { status: 'fetched', commit: next });
    assert.equal((await run(['--root', workspace, 'read', `shared:/round-${round}`])).code, 0);
    assert.equal((await exportsOf(join(workspace, '.state/mounts/shared'))).length, 2); // current and previous
    assert.deepEqual((await readdir(join(workspace, '.state/mounts'))).filter(entry => entry.startsWith('.lock')), []);
  }
});

// spec: hub-federation / Failed upgrade keeps the pin
test('an upgrade that lost its mount lock before the switch keeps the old pin', async t => {
  const f = await fixture(t);
  const { workspace, run, config, repository } = f;
  const source = await repository('shared-context', hub('team/data'));
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'shared', source.url])).code, 0);
  await source.commit({ 'two.md': guide('Two') });
  const locks = join(workspace, '.state/mounts');
  // Hold the config lock (as a live process), so the upgrade waits just before rewriting the pin.
  await writeFile(join(locks, '.lock-config'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'test' }));
  const upgrading = run(['--root', workspace, 'mounts', 'upgrade', 'shared']);
  const mountLock = join(locks, '.lock-mount-shared');
  // Wait until the candidate export is in place next to the old one.
  for (let i = 0; i < 800 && (await readdir(join(locks, 'shared'))).filter(entry => !entry.startsWith('.')).length < 2; i++) await new Promise(done => setTimeout(done, 25));
  await writeFile(mountLock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'usurper' }));
  await rm(join(locks, '.lock-config'));
  const upgraded = await upgrading;
  assert.equal(upgraded.error?.code, 'MOUNT_BUSY', upgraded.output);
  assert.equal((await config()).mounts.shared.commit, source.first);
  await rm(mountLock);
  const [mount] = (await run(['--root', workspace, 'mounts'])).json.mounts;
  assert.deepEqual({ status: mount.status, commit: mount.commit }, { status: 'fetched', commit: source.first });
  assert.equal((await run(['--root', workspace, 'read', 'shared:/two'])).error?.code, 'UNKNOWN_CONCEPT');
  // The next upgrade uses the complete candidate already there; current and previous are left.
  const retried = await run(['--root', workspace, 'mounts', 'upgrade', 'shared']);
  assert.equal(retried.code, 0, retried.output);
  assert.equal((await exportsOf(join(locks, 'shared'))).length, 2);
});

// Review round 1 regression.

// spec: hub-federation / Upstream moves on
test('reads running during upgrades back and forth never fail', async t => {
  const f = await fixture(t);
  const { workspace, run, repository } = f;
  const files = { ...hub('team/data') };
  for (let i = 0; i < 300; i++) files[`c/n${i}.md`] = guide(`n${i}`);
  const source = await repository('shared-context', files);
  const a = source.first;
  const b = await source.commit({ 'extra.md': guide('Extra') });
  assert.equal((await run(['--root', workspace, 'mounts', 'add', 'shared', source.url, '--ref', 'main'])).code, 0);
  let stop = false;
  const failures = [];
  let reads = 0;
  const reader = async () => {
    while (!stop) {
      const result = await run(['--root', workspace, ...(reads % 2 ? ['read', 'shared:/README'] : ['search', 'n299'])]);
      reads++;
      if (result.code !== 0) failures.push(result.output.slice(0, 200));
    }
  };
  const readers = Array.from({ length: 4 }, reader);
  for (let i = 0; i < 8; i++) {
    const result = await run(['--root', workspace, 'mounts', 'upgrade', 'shared', '--to', i % 2 ? b : a]);
    assert.equal(result.code, 0, result.output);
  }
  stop = true;
  await Promise.all(readers);
  assert.ok(reads > 0);
  assert.deepEqual(failures, [], `${failures.length}/${reads} reads failed`);
  assert.ok((await exportsOf(join(workspace, '.state/mounts/shared'))).length <= 2);
});

// Exports verified before reuse (follow-up to review of #68).

// The export directory holding the given commit, made writable so a test can damage it.
async function exportAt(workspace, commit) {
  const parent = join(workspace, '.state/mounts/shared');
  for (const key of await exportsOf(parent)) {
    const descriptor = JSON.parse(await readFile(join(parent, key, '.mount.json'), 'utf8'));
    if (descriptor.commit === commit) { await exec('chmod', ['-R', 'u+w', join(parent, key)]); return join(parent, key); }
  }
  throw new Error(`no export of ${commit}`);
}

// spec: hub-federation / Failed upgrade keeps the pin
test('an export with its descriptor but missing files is rebuilt by upgrade, not reused', async t => {
  const f = await fixture(t);
  const { workspace, cli, config, repository } = f;
  const source = await repository('shared-context', { ...hub('team/data'), 'tables/orders.md': guide('Orders'), 'tables/customers.md': guide('Customers') });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const next = await source.commit({ 'two.md': guide('Two') });
  assert.equal((await cli('mounts', 'upgrade', 'shared')).code, 0);
  // The previous pin's export, as an interrupted delete could leave it: descriptor kept, files gone.
  const previous = await exportAt(workspace, source.first);
  await rm(join(previous, 'tables/orders.md'));
  await writeFile(join(previous, 'tables/customers.md'), guide('Customerz'));
  const back = await cli('mounts', 'upgrade', 'shared', '--to', source.first);
  assert.equal(back.code, 0, back.output);
  assert.equal((await config()).mounts.shared.commit, source.first);
  const orders = await cli('read', 'shared:/tables/orders');
  assert.equal(orders.code, 0, orders.output);
  assert.match((await cli('read', 'shared:/tables/customers')).json.content, /# Customers\n/);
  assert.equal((await cli('mounts')).json.mounts[0].status, 'fetched');
  assert.notEqual(next, source.first);
});

// spec: hub-federation / Fresh machine fetches its mounts
test('fetch repairs an export at the pin whose files are missing or changed', async t => {
  const f = await fixture(t);
  const { workspace, cli, repository } = f;
  const source = await repository('shared-context', { ...hub('team/data'), 'tables/orders.md': guide('Orders') });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  assert.equal((await cli('mounts', 'fetch', 'shared')).json.mounts[0].outcome, 'unchanged');
  for (const damage of [dir => rm(join(dir, 'tables/orders.md')), dir => writeFile(join(dir, 'tables/orders.md'), guide('Orderz'))]) {
    await damage(await exportAt(workspace, source.first));
    const fetched = await cli('mounts', 'fetch', 'shared');
    assert.equal(fetched.code, 0, fetched.output);
    assert.equal(fetched.json.mounts[0].outcome, 'fetched');
    const read = await cli('read', 'shared:/tables/orders');
    assert.equal(read.code, 0, read.output);
    assert.match(read.json.content, /# Orders\n/);
    assert.equal((await cli('mounts', 'fetch', 'shared')).json.mounts[0].outcome, 'unchanged');
  }
});

// spec: hub-federation / Fresh machine fetches its mounts
test('a mount with thousands of files is fetched and verified, its long descriptor read', async t => {
  const { workspace, cli, repository } = await fixture(t);
  const assets = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`assets/a${i}.txt`, `asset ${i}\n`]));
  const source = await repository('shared-context', { ...hub('team/data'), ...assets });
  const added = await cli('mounts', 'add', 'shared', source.url);
  assert.equal(added.code, 0, added.output);
  // The descriptor is over the 128 KiB document limit, and is still read back by a new process.
  const [key] = await exportsOf(join(workspace, '.state/mounts/shared'));
  assert.ok((await stat(join(workspace, '.state/mounts/shared', key, '.mount.json'))).size > 128 * 1024);
  assert.equal((await cli('mounts')).json.mounts[0].status, 'fetched');
  assert.equal((await cli('read', 'shared:/README')).code, 0);
  assert.equal((await cli('mounts', 'fetch', 'shared')).json.mounts[0].outcome, 'unchanged');
});

// Review round 1 regressions (#70).

// spec: hub-federation / Fresh machine fetches its mounts
test('a source with its own top-level .mount.json: not exported, warned, and fetch finds the export intact', async t => {
  const { workspace, cli, repository } = await fixture(t);
  const source = await repository('shared-context', { ...hub('team/data'), '.mount.json': '{"commit": "planted"}\n' });
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  for (let i = 0; i < 2; i++) assert.equal((await cli('mounts', 'fetch', 'shared')).json.mounts[0].outcome, 'unchanged', `fetch ${i + 1}`);
  const [key] = await exportsOf(join(workspace, '.state/mounts/shared'));
  const descriptor = JSON.parse(await readFile(join(workspace, '.state/mounts/shared', key, '.mount.json'), 'utf8'));
  assert.equal(descriptor.commit, source.first);
  assert.ok(!descriptor.files.some(([path]) => path === '.mount.json'));
  assert.deepEqual(descriptor.skipped, ['.mount.json']);
  assert.ok((await cli('context', 'shared')).json.warnings.some(warning => /^\.mount\.json: not exported/.test(warning)));
});

// spec: hub-federation / Fresh machine fetches its mounts
test('an export made before descriptors listed files is re-exported once, or kept when offline', async t => {
  const { base, workspace, cli, repository } = await fixture(t);
  const source = await repository('shared-context', hub('team/data'));
  assert.equal((await cli('mounts', 'add', 'shared', source.url)).code, 0);
  const legacy = async () => {
    const [key] = await exportsOf(join(workspace, '.state/mounts/shared'));
    const directory = join(workspace, '.state/mounts/shared', key);
    await exec('chmod', ['-R', 'u+w', directory]);
    const { files, tree, ...old } = JSON.parse(await readFile(join(directory, '.mount.json'), 'utf8'));
    await writeFile(join(directory, '.mount.json'), JSON.stringify(old));
    return directory;
  };
  let directory = await legacy();
  let fetched = await cli('mounts', 'fetch', 'shared');
  assert.equal(fetched.json.mounts[0].outcome, 'fetched', fetched.output);
  assert.ok(Array.isArray(JSON.parse(await readFile(join(directory, '.mount.json'), 'utf8')).files));
  assert.equal((await cli('mounts', 'fetch', 'shared')).json.mounts[0].outcome, 'unchanged');
  // Offline: kept as it is, and fetch still succeeds.
  directory = await legacy();
  await cp(source.path, join(base, 'away'), { recursive: true });
  await rm(source.path, { recursive: true, force: true });
  fetched = await cli('mounts', 'fetch', 'shared');
  assert.equal(fetched.code, 0, fetched.output);
  assert.equal(fetched.json.mounts[0].outcome, 'unchanged');
  assert.equal((await cli('read', 'shared:/README')).code, 0);
});
