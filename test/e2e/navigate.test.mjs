import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, readdir } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const concept = (type, title, description, body) =>
  `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`;

// A workspace whose hub has a root index, a subdirectory without one, links of each kind,
// a non-Markdown resource, a reserved log, a stray nonconformant file and a captured note.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-nav-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  delete env.CONTEXT_KIT_ROOT;
  const workspace = join(base, 'workspace');
  const run = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, error: JSON.parse(error.stderr).error, stdout: error.stdout }; }
  };
  await run('init', workspace);
  const hub = join(workspace, 'hubs/personal');
  await mkdir(join(hub, 'playbooks'));
  await mkdir(join(hub, 'references'));
  await writeFile(join(hub, 'playbooks/deploy.md'), concept('Playbook', 'Deploy', 'How to ship a release.',
    'See [the guide](/README.md), [rollback](./rollback.md), [the checklist](../references/checklist.txt), [refs](/references/),\n' +
    '[docs](https://example.com/docs), [escape](../../../outside.md), [self](#steps) and ![diagram](/img.png).\n\n' +
    '```\n[not a link](/README.md)\n```\n\n## Steps\n1. Release.'));
  await writeFile(join(hub, 'playbooks/oncall.md'), concept('Playbook', 'On call', 'Who to page.', 'Page the owner.'));
  await writeFile(join(hub, 'references/checklist.txt'), 'checklist');
  await writeFile(join(hub, 'log.md'), '# Log\n\n## 2026-10-17\n* **Creation**: Added playbooks.\n');
  await writeFile(join(hub, 'scratch.md'), 'not a concept\n');
  await exec('sh', ['-c', `printf 'Remember the walrus.\\n' | "${process.execPath}" "${join(kit, 'bin/hub.mjs')}" --root "${workspace}" capture personal/main Idea`], { env });
  const cli = (...args) => run('--root', workspace, ...args);
  const mcp = async () => {
    const client = new Client({ name: 'nav-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env, stderr: 'pipe' }));
    t.after(() => client.close());
    return client;
  };
  return { base, workspace, hub, cli, mcp };
}

// spec: progressive-disclosure / Browse with and without an index
// spec: progressive-disclosure / Unknown or escaping directory
test('browse lists concepts progressively', async t => {
  const { base, hub, cli } = await fixture(t);
  const root = await cli('browse', 'personal/main');
  assert.equal(root.code, 0, JSON.stringify(root.error));
  assert.match(root.json.index, /^# Personal context/);
  assert.equal(root.json.indexTruncated, false);
  assert.deepEqual(root.json.directories, [
    { id: 'playbooks', concepts: 2, title: null, inbox: false },
    { id: 'references', concepts: 0, title: null, inbox: false }]);
  assert.deepEqual(root.json.concepts, [{ id: 'README', ref: 'personal/main:/README', type: 'Guide', title: 'Personal context',
    description: 'Durable context and preferences for this workspace.', status: 'stable', trust: 'unverified', stale: false,
    freshness: { action: 'read', reason: 'no freshness rule applies' }, curated: true, inbox: false }]);
  assert.deepEqual(root.json.totals, { directories: 2, concepts: 1 });
  assert.equal(root.json.truncated, false);
  assert.ok(root.json.warnings.some(warning => warning.startsWith('scratch.md:')));

  const playbooks = await cli('browse', 'personal/main', 'playbooks');
  assert.equal(playbooks.json.index, null);
  assert.deepEqual(playbooks.json.concepts.map(entry => [entry.id, entry.description, entry.curated]),
    [['playbooks/deploy', 'How to ship a release.', false], ['playbooks/oncall', 'Who to page.', false]]);
  assert.deepEqual(playbooks.json.warnings, []);

  await mkdir(join(base, 'elsewhere'));
  await symlink(join(base, 'elsewhere'), join(hub, 'linked'));
  for (const [path, code] of [['nowhere', 'UNKNOWN_PATH'], ['README.md', 'UNKNOWN_PATH'], ['../..', 'INVALID_PATH'],
    ['.hidden', 'INVALID_PATH'], ['linked', 'PATH_ESCAPE']]) {
    const result = await cli('browse', 'personal/main', path);
    assert.equal(result.error?.code, code, path);
    assert.equal(result.stdout, '');
  }
});

// spec: progressive-disclosure / Page a large directory
test('large directories page in a stable order', async t => {
  const { hub, cli } = await fixture(t);
  await mkdir(join(hub, 'many'));
  const long = 'x'.repeat(400);
  for (let i = 0; i < 205; i++) {
    await writeFile(join(hub, 'many', `c${String(i).padStart(3, '0')}.md`), concept('Fact', `Fact ${i}`, i === 0 ? long : `Fact ${i}.`, 'Body.'));
  }
  const first = await cli('browse', 'personal/main', 'many');
  assert.equal(first.json.concepts.length, 200);
  assert.deepEqual(first.json.totals, { directories: 0, concepts: 205 });
  assert.equal(first.json.truncated, true);
  assert.equal(first.json.concepts[0].description.length, 300);
  const second = await cli('browse', 'personal/main', 'many', '--offset', '200');
  assert.deepEqual(second.json.concepts.map(entry => entry.id), ['many/c200', 'many/c201', 'many/c202', 'many/c203', 'many/c204']);
  assert.equal(second.json.truncated, false);
  assert.equal(second.json.offset, 200);
  assert.equal((await cli('browse', 'personal/main', 'many', '--offset', 'lots')).error.code, 'INVALID_INPUT');
});

// spec: progressive-disclosure / Follow links
// spec: progressive-disclosure / Not a concept
test('read a concept and follow its links', async t => {
  const { cli } = await fixture(t);
  const deploy = await cli('read', 'personal/main', 'playbooks/deploy');
  assert.equal(deploy.code, 0, JSON.stringify(deploy.error));
  assert.equal(deploy.json.okf.type, 'Playbook');
  assert.match(deploy.json.content, /^See \[the guide\]/);
  assert.deepEqual(deploy.json.links.map(({ text, kind, id, path, url }) => ({ text, kind, ...(id ? { id } : {}), ...(path ? { path } : {}), ...(url ? { url } : {}) })), [
    { text: 'the guide', kind: 'concept', id: 'README' },
    { text: 'rollback', kind: 'missing' },
    { text: 'the checklist', kind: 'file', path: 'references/checklist.txt' },
    { text: 'refs', kind: 'directory', id: 'references' },
    { text: 'docs', kind: 'external', url: 'https://example.com/docs' },
    { text: 'escape', kind: 'outside' },
  ]);
  assert.equal(deploy.json.links[0].hub, 'personal/main');
  assert.equal(deploy.json.frontmatter, undefined);
  assert.equal((await cli('read', 'personal/main', 'playbooks/deploy', '--frontmatter')).json.frontmatter.type, 'Playbook');
  const followed = await cli('read', 'personal/main', deploy.json.links[0].id);
  assert.equal(followed.json.okf.title, 'Personal context');

  for (const [id, code] of [['log', 'NOT_A_CONCEPT'], ['index', 'NOT_A_CONCEPT'], ['scratch', 'NOT_A_CONCEPT'],
    ['playbooks/missing', 'UNKNOWN_CONCEPT'], ['../../outside', 'INVALID_PATH'], ['README.md', 'INVALID_INPUT']]) {
    assert.equal((await cli('read', 'personal/main', id)).error?.code, code, id);
  }
});

// spec: progressive-disclosure / Inbox requested
test('inbox notes stay opt-in for browse, read and search', async t => {
  const { cli } = await fixture(t);
  const root = await cli('browse', 'personal/main');
  assert.ok(!root.json.directories.some(entry => entry.id === 'inbox'));
  assert.equal((await cli('browse', 'personal/main', 'inbox')).error.code, 'UNKNOWN_PATH');
  assert.equal((await cli('search', 'walrus')).json.results.length, 0);

  const withInbox = await cli('browse', 'personal/main', 'inbox', '--inbox');
  assert.equal(withInbox.json.concepts.length, 1);
  const [note] = withInbox.json.concepts;
  assert.equal(note.inbox, true);
  assert.equal(note.curated, false);
  assert.equal(note.type, 'Note');
  assert.equal(note.status, 'draft');
  assert.equal((await cli('read', 'personal/main', note.id)).error.code, 'UNKNOWN_CONCEPT');
  const read = await cli('read', 'personal/main', note.id, '--inbox');
  assert.equal(read.json.inbox, true);
  assert.match(read.json.content, /Remember the walrus\./);
  const rootWithInbox = await cli('browse', 'personal/main', '--inbox');
  assert.deepEqual(rootWithInbox.json.directories.find(entry => entry.id === 'inbox'),
    { id: 'inbox', concepts: 1, title: null, inbox: true });
  const found = await cli('search', 'walrus', '--inbox');
  assert.equal(found.json.results[0].id, note.id);
  assert.equal(found.json.results[0].inbox, true);
});

// spec: progressive-disclosure / Find what browse shows
test('search finds every concept and context names where to browse', async t => {
  const { cli } = await fixture(t);
  const found = await cli('search', 'page the owner');
  assert.equal(found.json.results.length, 1);
  assert.deepEqual([found.json.results[0].id, found.json.results[0].curated, found.json.results[0].inbox], ['playbooks/oncall', false, false]);
  assert.equal(found.json.results[0].okf.type, 'Playbook');
  const context = await cli('context', 'personal/main');
  assert.deepEqual(context.json.browse, { hub: 'personal/main', path: '' });
});

test('browse and read return the same results over CLI and MCP', async t => {
  const { cli, mcp } = await fixture(t);
  const client = await mcp();
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('browse_hub') && names.includes('read_concept'));
  const viaMcp = (await client.callTool({ name: 'browse_hub', arguments: { id: 'personal/main', path: 'playbooks' } })).structuredContent;
  assert.deepEqual(viaMcp, (await cli('browse', 'personal/main', 'playbooks')).json);
  const readMcp = (await client.callTool({ name: 'read_concept', arguments: { id: 'personal/main', concept: 'playbooks/deploy' } })).structuredContent;
  assert.deepEqual(readMcp, (await cli('read', 'personal/main', 'playbooks/deploy')).json);
  const error = await client.callTool({ name: 'read_concept', arguments: { id: 'personal/main', concept: 'log' } });
  assert.equal(error.isError, true);
  assert.equal(JSON.parse(error.content[0].text).error.code, 'NOT_A_CONCEPT');
});

// A workspace plus local git repositories holding hubs, mounted over file:// on an isolated
// machine (no system or global git config). No network.
async function mountFixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-nav-mounts-')));
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill();
    await exec('chmod', ['-R', 'u+w', base]).catch(() => {}); // Fetched mounts are read-only.
    await rm(base, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: join(base, 'home'), XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const name of ['CONTEXT_KIT_ROOT', 'CONTEXT_KIT_MCP_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_COUNT']) delete env[name];
  await mkdir(env.HOME);
  const workspace = join(base, 'workspace');
  const run = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, error: error.stderr ? JSON.parse(error.stderr).error : undefined, output: `${error.stdout}${error.stderr}` }; }
  };
  await run('init', workspace);
  const cli = (...args) => run('--root', workspace, ...args);
  // A git repository with these files (a { symlink } value commits a symlink); returns its file:// URL.
  const repository = async (name, files) => {
    const path = join(base, name);
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(path, file, '..'), { recursive: true });
      if (content.symlink) await symlink(content.symlink, join(path, file));
      else await writeFile(join(path, file), content);
    }
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'first']]) await exec('git', args, { cwd: path, env });
    return `file://${path}`;
  };
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return result.isError ? { error: JSON.parse(result.content[0].text).error } : { json: result.structuredContent };
  };
  const mcp = async () => {
    const client = new Client({ name: 'nav-mounts-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env, stderr: 'pipe' }));
    t.after(() => client.close());
    return (name, args) => call(client, name, args);
  };
  // The remote HTTP server behind a bearer token, and an MCP SDK client for it.
  const http = async () => {
    const token = 'nav-test-token-0123456789abcdef0123456789abcdef';
    const child = spawn(process.execPath, [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--http', '0'],
      { env: { ...env, CONTEXT_KIT_MCP_TOKEN: token }, cwd: base, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = '';
    const line = await new Promise((resolve, reject) => {
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('\n')) resolve(stderr.split('\n')[0]); });
      child.once('exit', () => reject(new Error('server exited: ' + stderr)));
    });
    const client = new Client({ name: 'nav-mounts-http', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(JSON.parse(line).url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return (name, args) => call(client, name, args);
  };
  return { base, workspace, cli, repository, mcp, http };
}
const hubFiles = (id, extra = {}) => ({
  'hub.json': JSON.stringify({ version: 1, id, description: `${id} hub.`, documents: ['README.md'], skills: [], links: [] }),
  'README.md': concept('Guide', id, `The ${id} hub.`, `# ${id}`), ...extra });
const under = (prefix, files) => Object.fromEntries(Object.entries(files).map(([file, content]) => [`${prefix}/${file}`, content]));
const kinds = links => Object.fromEntries(links.map(({ target, text, ...rest }) => [target, rest]));

// spec: progressive-disclosure / Link into a mount
// spec: progressive-disclosure / Link into an unfetched mount
test('links into a mount resolve there, never past its fetched export, over CLI, MCP and HTTP', async t => {
  const { base, workspace, cli, repository, mcp, http } = await mountFixture(t);
  const source = await repository('shared-context', hubFiles('team/data', {
    'tables/orders.md': concept('Table', 'Orders', 'One row per order.', 'One row per pelican order.'),
    'tables/aliased.md': { symlink: 'orders.md' }, 'tables/hosts.md': { symlink: '/etc/hosts' } }));
  await writeFile(join(base, 'secret.md'), concept('Guide', 'Secret', 'Outside every hub.', 'Do not read.'));
  await writeFile(join(workspace, 'hubs/personal/links.md'), concept('Guide', 'Links', 'Links into a mount.', [
    '[orders](shared:/tables/orders)', '[orders file](shared:/tables/orders.md#columns)', '[absent](shared:/tables/absent)',
    '[other](other:/x)', '[tables](shared:/tables)', '[aliased](shared:/tables/aliased)', '[hosts](shared:/tables/hosts)',
    '[up](shared:/../secret)', '[encoded up](shared:/tables/%2e%2e/%2e%2e/secret)', '[hidden](shared:/.git/config)',
    '[absolute](shared://etc/passwd)', '[file url](file:///etc/hosts)', '[root](/../../secret.md)'].join(',\n')));
  assert.equal((await cli('mounts', 'add', 'shared', source)).code, 0);

  const read = await cli('read', 'personal/main', 'links');
  assert.equal(read.code, 0, JSON.stringify(read.error));
  const missing = { kind: 'missing', mount: 'shared' };
  const orders = { kind: 'concept', hub: 'shared', id: 'tables/orders', ref: 'shared:/tables/orders' };
  assert.deepEqual(kinds(read.json.links), {
    'shared:/tables/orders': orders, 'shared:/tables/orders.md#columns': orders, 'shared:/tables/absent': missing,
    'other:/x': { kind: 'external', url: 'other:/x' }, 'shared:/tables': missing,
    // Symlinks are never exported, so neither target is there to follow.
    'shared:/tables/aliased': missing, 'shared:/tables/hosts': missing,
    'shared:/../secret': { ...missing, reason: 'invalid-id' }, 'shared:/tables/%2e%2e/%2e%2e/secret': { ...missing, reason: 'invalid-id' },
    'shared:/.git/config': { ...missing, reason: 'invalid-id' },
    'shared://etc/passwd': { kind: 'external', url: 'shared://etc/passwd' }, 'file:///etc/hosts': { kind: 'external', url: 'file:///etc/hosts' },
    '/../../secret.md': { kind: 'outside' } });
  assert.doesNotMatch(JSON.stringify(read.json), new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(?!workspace)'));
  const followed = await cli('read', read.json.links[0].ref);
  assert.equal(followed.code, 0, JSON.stringify(followed.error));
  assert.deepEqual([followed.json.hub, followed.json.id], ['shared', 'tables/orders']);
  assert.match(followed.json.content, /pelican order/);
  // The same over MCP, stdio and HTTP; over HTTP this machine's paths (the root, a file: mount
  // source) are labeled as the serving machine's (remote-access / Serving machine paths).
  const servingMachine = ({ root, mount, ...rest }) => ({ machine: hostname(), servingMachineRoot: root, ...rest,
    ...(mount ? { mount: Object.fromEntries(Object.entries(mount).map(([key, value]) => [key === 'source' && value.startsWith('file:') ? 'servingMachineSource' : key, value])) } : {}) });
  for (const [call, overHttp] of [[await mcp(), false], [await http(), true]]) {
    const [linked, follow] = [await call('read_concept', { id: 'personal/main', concept: 'links' }), await call('read_concept', { concept: read.json.links[0].ref })];
    assert.deepEqual(linked.json, overHttp ? servingMachine(read.json) : read.json);
    assert.deepEqual(follow.json, overHttp ? servingMachine(followed.json) : followed.json);
    if (overHttp) assert.match(follow.json.mount.servingMachineSource, /^file:/);
  }

  // Declared but not fetched (the export is gone): missing with the reason, and the read succeeds.
  await exec('chmod', ['-R', 'u+w', join(workspace, '.state/mounts')]);
  await rm(join(workspace, '.state/mounts/shared'), { recursive: true });
  const unfetched = await cli('read', 'personal/main', 'links');
  assert.equal(unfetched.code, 0, JSON.stringify(unfetched.error));
  assert.deepEqual(kinds(unfetched.json.links)['shared:/tables/orders'], { kind: 'missing', mount: 'shared', reason: 'unfetched' });
  assert.deepEqual(kinds(unfetched.json.links)['other:/x'], { kind: 'external', url: 'other:/x' });
  assert.deepEqual((await (await mcp())('read_concept', { id: 'personal/main', concept: 'links' })).json, unfetched.json);

  // Fetched again, then broken: missing with reason broken.
  assert.equal((await cli('mounts', 'fetch', 'shared')).code, 0);
  const [key] = (await readdir(join(workspace, '.state/mounts/shared'))).filter(name => !name.startsWith('.'));
  await exec('chmod', ['-R', 'u+w', join(workspace, '.state/mounts/shared')]);
  await writeFile(join(workspace, '.state/mounts/shared', key, 'hub.json'), 'not json');
  assert.deepEqual(kinds((await cli('read', 'personal/main', 'links')).json.links)['shared:/tables/orders'], { kind: 'missing', mount: 'shared', reason: 'broken' });

  // A mount named like a workspace hub is not read, and its links never land in that workspace hub.
  await writeFile(join(workspace, '.state/mounts/shared', key, 'hub.json'), hubFiles('team/data')['hub.json']);
  await mkdir(join(workspace, 'hubs/decoy/tables'), { recursive: true });
  for (const [file, content] of Object.entries(hubFiles('shared', { 'tables/orders.md': concept('Table', 'Decoy', 'A decoy.', 'Decoy.') }))) {
    await writeFile(join(workspace, 'hubs/decoy', file), content);
  }
  const shadowed = await cli('read', 'personal/main', 'links');
  assert.equal(shadowed.code, 0, JSON.stringify(shadowed.error));
  assert.deepEqual(kinds(shadowed.json.links)['shared:/tables/orders'], { kind: 'missing', mount: 'shared', reason: 'name-conflict' });
});

// spec: progressive-disclosure / Outside link a mount covers
test('an outside link resolves in another mount of the same source repository that covers it', async t => {
  const { base, workspace, cli, repository, mcp } = await mountFixture(t);
  await writeFile(join(base, 'secret.md'), concept('Guide', 'Secret', 'Outside every repository.', 'Do not read.'));
  const overview = concept('Guide', 'Overview', 'Where things live.', [
    '[deploy](../platform/deploy.md)', '[deploy from root](/../platform/deploy.md)', '[platform](../platform/)',
    '[runbook](../platform/runbook.txt)', '[absent](../platform/absent.md)', '[aliased](../platform/aliased.md)',
    '[hosts](../platform/hosts.md)', '[via link](../plat/deploy.md)', '[prefix](../platformx/deploy.md)',
    '[repo root](../../README.md)', '[beyond](../../../secret.md)', '[far beyond](../../../../../../../../etc/hosts)'].join(',\n'));
  const files = { ...under('hubs/data', hubFiles('team/data', { 'overview.md': overview })),
    ...under('hubs/platform', hubFiles('team/platform', { 'deploy.md': concept('Playbook', 'Deploy', 'How to ship.', 'Ship with the heron script.'),
      'runbook.txt': 'runbook', 'aliased.md': { symlink: 'deploy.md' }, 'hosts.md': { symlink: '/etc/hosts' } })),
    ...under('hubs/platformx', hubFiles('team/platformx', { 'deploy.md': concept('Playbook', 'Other', 'Not this one.', 'No.') })),
    'hubs/plat': { symlink: 'platform' }, ...hubFiles('team/mono') };
  const mono = await repository('mono', files);
  // The same paths in a different repository never cover the first one's links.
  const copy = await repository('copy', files);
  assert.equal((await cli('mounts', 'add', 'data', mono, '--path', 'hubs/data')).code, 0);
  assert.equal((await cli('mounts', 'add', 'look-alike', copy, '--path', 'hubs/platform')).code, 0);

  const outside = { kind: 'outside' };
  const alone = await cli('read', 'data:/overview');
  assert.equal(alone.code, 0, JSON.stringify(alone.error));
  assert.ok(alone.json.links.every(link => link.kind === 'outside'), JSON.stringify(alone.json.links));

  assert.equal((await cli('mounts', 'add', 'platform', mono, '--path', 'hubs/platform')).code, 0);
  const read = await cli('read', 'data:/overview');
  assert.equal(read.code, 0, JSON.stringify(read.error));
  const deploy = { kind: 'concept', hub: 'platform', id: 'deploy', ref: 'platform:/deploy' };
  const missing = { kind: 'missing', hub: 'platform', mount: 'platform' };
  assert.deepEqual(kinds(read.json.links), {
    '../platform/deploy.md': deploy, '/../platform/deploy.md': deploy, '../platform/': { kind: 'directory', hub: 'platform', id: '' },
    '../platform/runbook.txt': { kind: 'file', hub: 'platform', path: 'runbook.txt' }, '../platform/absent.md': missing,
    // Symlinks in the source are not exported; a symlinked directory is not a path into the mount.
    '../platform/aliased.md': missing, '../platform/hosts.md': missing, '../plat/deploy.md': outside,
    '../platformx/deploy.md': outside, '../../README.md': outside, '../../../secret.md': outside,
    '../../../../../../../../etc/hosts': outside });
  const followed = await cli('read', read.json.links[0].ref);
  assert.deepEqual([followed.json.hub, followed.json.id, followed.json.mount.path], ['platform', 'deploy', 'hubs/platform']);
  assert.match(followed.json.content, /heron script/);
  const call = await mcp();
  assert.deepEqual((await call('read_concept', { concept: 'data:/overview' })).json, read.json);
  assert.deepEqual((await call('read_concept', { concept: 'platform:/deploy' })).json, followed.json);

  // A mount of the repository root covers what no deeper mount does; the deepest one wins.
  assert.equal((await cli('mounts', 'add', 'mono', mono)).code, 0);
  const rooted = kinds((await cli('read', 'data:/overview')).json.links);
  assert.deepEqual(rooted['../platform/deploy.md'], deploy);
  assert.deepEqual(rooted['../platformx/deploy.md'], { kind: 'concept', hub: 'mono', id: 'hubs/platformx/deploy', ref: 'mono:/hubs/platformx/deploy' });
  assert.deepEqual(rooted['../../README.md'], { kind: 'concept', hub: 'mono', id: 'README', ref: 'mono:/README' });
  assert.deepEqual(rooted['../plat/deploy.md'], { kind: 'missing', hub: 'mono', mount: 'mono' });
  assert.deepEqual(rooted['../../../secret.md'], outside);
  // Workspace concepts' links beyond the hub stay outside: only mounted links are resolved in a source.
  await writeFile(join(workspace, 'hubs/personal/up.md'), concept('Guide', 'Up', 'Up.', '[deploy](../../../platform/deploy.md)'));
  assert.deepEqual((await cli('read', 'personal/main', 'up')).json.links.map(link => link.kind), ['outside']);
});
