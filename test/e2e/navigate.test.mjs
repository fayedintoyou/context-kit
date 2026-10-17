import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  assert.deepEqual(root.json.concepts, [{ id: 'README', type: 'Guide', title: 'Personal context',
    description: 'Durable context and preferences for this workspace.', status: 'stable', trust: 'unverified', stale: false,
    curated: true, inbox: false }]);
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
