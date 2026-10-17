import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// Isolated XDG dirs keep the user's OpenSpec registry untouched; CONTEXT_KIT_ROOT is cleared so only --root selects.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-cli-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  delete env.CONTEXT_KIT_ROOT;
  const cli = (args, input) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env, cwd: base });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => done({ code, stdout, stderr,
      json: stdout.startsWith('{') ? JSON.parse(stdout) : null, error: stderr ? JSON.parse(stderr).error : null }));
    child.stdin.end(input ?? '');
  });
  const workspace = join(base, 'workspace');
  const init = await cli(['init', workspace]);
  assert.equal(init.code, 0, init.stderr);
  return { base, workspace, cli, hub: join(workspace, 'hubs/personal') };
}
const snapshot = async directory => Object.fromEntries(await Promise.all((await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(async entry => [join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), 'utf8')])));

// spec: context-workspaces / Create a workspace
test('init creates a valid starter workspace and refuses an existing directory', async t => {
  const { base, workspace, cli } = await fixture(t);
  const validate = await cli(['--root', workspace, 'validate']);
  assert.equal(validate.code, 0, validate.stderr);
  assert.deepEqual(validate.json, { root: workspace, valid: true, hubs: 1 });
  const listed = await cli(['--root', workspace, 'list']);
  assert.deepEqual(listed.json.hubs.map(hub => hub.id), ['personal/main']);
  const skill = await cli(['--root', workspace, 'read-skill', 'personal/main', 'kit:independent-review']);
  assert.equal(skill.code, 0, skill.stderr);
  assert.equal(skill.json.content, await readFile(join(kit, 'skills/independent-review/SKILL.md'), 'utf8'));

  const existing = join(base, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'keep.txt'), 'mine');
  const refused = await cli(['init', existing]);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.stdout, '');
  assert.equal(typeof refused.error.code, 'string');
  assert.deepEqual(await readdir(existing), ['keep.txt']);
  assert.notEqual((await cli(['init', workspace])).code, 0);
  assert.equal((await cli(['--root', base, 'init', join(base, 'other')])).error.code, 'INVALID_INPUT');
});

// spec: context-workspaces / Read curated context
// spec: context-workspaces / Capture and find
test('context excludes inbox unless requested; stdin capture is searchable and leaves documents unchanged', async t => {
  const { workspace, cli, hub } = await fixture(t);
  const before = await snapshot(hub);
  const captured = await cli(['--root', workspace, 'capture', 'personal/main', 'Finding'], 'Zebra crossings need review.\n');
  assert.equal(captured.code, 0, captured.stderr);
  assert.equal(captured.json.status, 'unreviewed');
  assert.match(captured.json.path, /^hubs\/personal\/inbox\/\d{13}-[0-9a-f-]{36}\.md$/);
  const note = await readFile(join(workspace, captured.json.path), 'utf8');
  assert.match(note, /^# Finding\n/);
  assert.match(note, /Source: cli\nStatus: unreviewed\n\nZebra crossings need review\./);
  for (const [path, content] of Object.entries(before)) assert.equal(await readFile(path, 'utf8'), content);

  const curated = await cli(['--root', workspace, 'context', 'personal/main']);
  assert.equal(curated.json.inbox, undefined);
  assert.deepEqual(curated.json.documents.map(document => document.path), ['README.md']);
  const withInbox = await cli(['--root', workspace, 'context', 'personal/main', '--inbox']);
  assert.equal(withInbox.json.inbox.status, 'unreviewed');
  assert.equal(withInbox.json.inbox.notes[0].content, note);

  assert.deepEqual((await cli(['--root', workspace, 'search', 'zebra'])).json.results, []);
  const found = await cli(['--root', workspace, 'search', 'zebra', '--inbox']);
  assert.equal(found.json.results.length, 1);
  assert.equal(found.json.results[0].status, 'unreviewed');
  assert.equal(found.json.results[0].path, captured.json.path.replace('hubs/personal/', ''));
  assert.equal((await cli(['--root', workspace, 'validate'])).code, 0);

  const second = await cli(['--root', workspace, 'capture', 'personal/main', 'Finding'], 'Zebra again');
  assert.notEqual(second.json.path, captured.json.path);
});

test('capture requires an explicit workspace outside the toolkit and valid input', async t => {
  const { workspace, cli, hub } = await fixture(t);
  const implicit = await cli(['capture', 'working-with-agents', 'Nope'], 'body');
  assert.equal(implicit.error.code, 'WRITE_DISABLED');
  const kitRoot = await cli(['--root', kit, 'capture', 'working-with-agents', 'Nope'], 'body');
  assert.equal(kitRoot.error.code, 'WRITE_DISABLED');
  assert.equal((await cli(['--root', workspace, 'capture', 'personal/main', 'Empty'], '  \n')).error.code, 'INVALID_INPUT');
  assert.equal((await cli(['--root', workspace, 'capture', 'personal/main', 'Bad'], Buffer.from([0xff, 0xfe]))).error.code, 'INVALID_UTF8');
  assert.equal((await cli(['--root', workspace, 'capture', 'personal/main', 'Big'], 'x'.repeat(65537))).error.code, 'TOO_LARGE');
  assert.equal((await cli(['--root', workspace, 'capture', 'missing/hub', 'Lost'], 'body')).error.code, 'UNKNOWN_HUB');
  await assert.rejects(readdir(join(hub, 'inbox')), { code: 'ENOENT' });
});

// spec: context-workspaces / Reject escaped inbox
test('capture into a symlinked inbox fails before writing', async t => {
  const { base, workspace, cli, hub } = await fixture(t);
  const outside = join(base, 'outside');
  await mkdir(outside);
  await symlink(outside, join(hub, 'inbox'));
  const result = await cli(['--root', workspace, 'capture', 'personal/main', 'Escape'], 'secret');
  assert.notEqual(result.code, 0);
  assert.equal(result.error.code, 'PATH_ESCAPE');
  assert.deepEqual(await readdir(outside), []);
  assert.equal((await cli(['--root', workspace, 'context', 'personal/main', '--inbox'])).error.code, 'PATH_ESCAPE');
});

// spec: agent-interface / Invalid CLI request
test('unsupported commands and options exit nonzero with a coded stderr error', async t => {
  const { workspace, cli } = await fixture(t);
  for (const args of [['frobnicate'], ['list', 'extra'], ['--bogus', 'list'], ['list', '--inbox'], ['--root']]) {
    const result = await cli(['--root', workspace, ...args]);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.error.code, 'INVALID_INPUT');
  }
  assert.equal((await cli(['--root', workspace, 'context', 'missing/hub'])).error.code, 'UNKNOWN_HUB');
  assert.equal((await cli(['--root', workspace, 'read-skill', 'personal/main', 'kit:missing'])).error.code, 'UNKNOWN_SKILL');
  assert.equal((await cli(['--root', workspace, 'search', '   '])).error.code, 'INVALID_INPUT');
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage:/);
});

// spec: context-workspaces / Reject escaped document
test('validation rejects escaped, missing, duplicate and unlinked hub content', async t => {
  const { base, workspace, cli, hub } = await fixture(t);
  const manifestPath = join(hub, 'hub.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expectInvalid = async (change, pattern) => {
    await writeFile(manifestPath, JSON.stringify({ ...original, ...change }));
    const result = await cli(['--root', workspace, 'validate']);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.error.message, pattern);
    return result;
  };
  await writeFile(join(base, 'outside.md'), 'Outside secret');
  await expectInvalid({ documents: ['../../../outside.md'] }, /escapes its root/);
  await symlink(join(base, 'outside.md'), join(hub, 'linked.md'));
  const linked = await expectInvalid({ documents: ['linked.md'] }, /escapes its root/);
  assert.doesNotMatch(linked.stderr, /Outside secret/);
  await expectInvalid({ documents: ['missing.md'] }, /ENOENT|missing/);
  await expectInvalid({ links: ['personal/missing'] }, /Unknown linked hub/);
  await writeFile(manifestPath, JSON.stringify(original));
  await mkdir(join(workspace, 'hubs/copy'));
  await writeFile(join(workspace, 'hubs/copy/hub.json'), JSON.stringify(original));
  await writeFile(join(workspace, 'hubs/copy/README.md'), 'Copy');
  const duplicate = await cli(['--root', workspace, 'context', 'personal/main']);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.error.message, /Duplicate hub ID/);
});

