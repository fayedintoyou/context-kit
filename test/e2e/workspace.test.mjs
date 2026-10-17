import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// Isolated XDG dirs keep the user's OpenSpec registry untouched; CONTEXT_KIT_ROOT is cleared so only --root selects.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-cli-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  delete env.CONTEXT_KIT_ROOT;
  const cli = (args, input, extra = {}) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env: { ...env, ...extra }, cwd: base });
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
const concept = (type, body, extra = '') => `---\ntype: ${type}\n${extra}---\n\n${body}\n`;
const frontmatter = text => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n\n/);
  assert.ok(match, 'starts with OKF frontmatter');
  return { data: parseYaml(match[1]), body: text.slice(match[0].length) };
};
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
  assert.equal(refused.error.code, 'WORKSPACE_EXISTS');
  assert.deepEqual(await readdir(existing), ['keep.txt']);
  assert.equal((await cli(['init', join(base, 'absent/child')])).error.code, 'INVALID_PATH');
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
  const parsed = frontmatter(note);
  assert.equal(parsed.data.type, 'Note');
  assert.equal(parsed.data.status, 'draft');
  assert.match(parsed.data.generated.by, /^context-kit\/\d+\.\d+\.\d+$/);
  assert.match(parsed.data.generated.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(parsed.body, /^# Finding\n\nZebra crossings need review\.\n$/);
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
  const implicit = await cli(['capture', 'example/onboarding', 'Nope'], 'body');
  assert.equal(implicit.error.code, 'WRITE_DISABLED');
  const kitRoot = await cli(['--root', kit, 'capture', 'example/onboarding', 'Nope'], 'body');
  assert.equal(kitRoot.error.code, 'WRITE_DISABLED');
  // A workspace nested anywhere inside the checkout is still the toolkit checkout.
  await mkdir(join(kit, '.state'), { recursive: true });
  const nestedBase = await mkdtemp(join(kit, '.state', 'nested-'));
  t.after(() => rm(nestedBase, { recursive: true, force: true }));
  const nested = join(nestedBase, 'workspace');
  assert.equal((await cli(['init', nested])).code, 0);
  assert.equal((await cli(['--root', nested, 'capture', 'personal/main', 'Nope'], 'body')).error.code, 'WRITE_DISABLED');
  await assert.rejects(readdir(join(nested, 'hubs/personal/inbox')), { code: 'ENOENT' });
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
  const retrieved = await cli(['--root', workspace, 'context', 'personal/main']);
  assert.equal(retrieved.error.code, 'PATH_ESCAPE');
  assert.equal(retrieved.stdout, '');
  await rm(join(hub, 'linked.md'));
  const missing = await expectInvalid({ documents: ['missing.md'] }, /missing\.md/);
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.doesNotMatch(missing.error.message, new RegExp(base));
  assert.equal((await expectInvalid({ links: ['personal/missing'] }, /Unknown linked hub/)).error.code, 'INVALID_MANIFEST');
  await writeFile(manifestPath, JSON.stringify(original));
  await mkdir(join(workspace, 'hubs/copy'));
  await writeFile(join(workspace, 'hubs/copy/hub.json'), JSON.stringify(original));
  await writeFile(join(workspace, 'hubs/copy/README.md'), concept('Guide', 'Copy'));
  const duplicate = await cli(['--root', workspace, 'context', 'personal/main']);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.error.message, /Duplicate hub ID/);
});

// spec: context-workspaces / Create a workspace
test('CONTEXT_KIT_ROOT selects the workspace, and --root takes precedence', async t => {
  const { base, workspace, cli } = await fixture(t);
  const fromEnv = await cli(['list'], '', { CONTEXT_KIT_ROOT: workspace });
  assert.equal(fromEnv.json.root, workspace);
  assert.deepEqual(fromEnv.json.hubs.map(hub => hub.id), ['personal/main']);
  const other = join(base, 'other');
  assert.equal((await cli(['init', other])).code, 0);
  assert.equal((await cli(['--root', other, 'list'], '', { CONTEXT_KIT_ROOT: workspace })).json.root, other);
  const captured = await cli(['capture', 'personal/main', 'Via env'], 'body', { CONTEXT_KIT_ROOT: workspace });
  assert.equal(captured.code, 0, captured.stderr);
  assert.equal(captured.json.root, workspace);
});

// spec: knowledge-format / Concept without a type
// spec: knowledge-format / Reserved file structure
// spec: knowledge-format / Permissive consumption
// spec: knowledge-format / Conformant starter
test('hubs must be conformant OKF bundles', async t => {
  const { workspace, cli, hub } = await fixture(t);
  const index = await readFile(join(hub, 'index.md'), 'utf8');
  assert.equal(frontmatter(index).data.okf_version, '0.2');
  assert.match(index, /^\* \[Personal context\]\(README\.md\) - /m);
  assert.equal(frontmatter(await readFile(join(hub, 'README.md'), 'utf8')).data.type, 'Guide');
  assert.equal((await cli(['--root', workspace, 'validate'])).code, 0);

  const invalid = async (file, content, pattern) => {
    await mkdir(join(hub, file, '..'), { recursive: true });
    await writeFile(join(hub, file), content);
    const result = await cli(['--root', workspace, 'validate']);
    assert.notEqual(result.code, 0, file);
    assert.equal(result.error.code, 'INVALID_OKF');
    assert.match(result.error.message, pattern);
    await rm(join(hub, file));
  };
  await invalid('notes.md', '# No frontmatter\n', /hubs\/personal\/notes\.md: missing YAML frontmatter/);
  await invalid('untyped.md', '---\ntitle: Untyped\n---\n\nBody\n', /untyped\.md: frontmatter needs a non-empty type/);
  await invalid('nested/index.md', '---\ntitle: Nope\n---\n\n# Nested\n', /nested\/index\.md: index files may only declare okf_version/);
  await invalid('log.md', '# Log\n\n## Last week\n* **Update**: x\n', /log\.md: log date headings must be YYYY-MM-DD/);

  await writeFile(join(hub, 'index.md'), index.replace('okf_version: "0.2"', 'okf_version: "9.9"'));
  await writeFile(join(hub, 'log.md'), '# Log\n\n## 2026-10-17\n* **Creation**: Added things.\n');
  await mkdir(join(hub, 'deep'));
  await writeFile(join(hub, 'deep/odd.md'), concept('Totally New Kind', 'See [missing](/nowhere.md) and [also](./gone.md).', 'flavour: unusual\nsomething_else: [1, 2]\n'));
  assert.equal((await cli(['--root', workspace, 'validate'])).code, 0);
  const read = await cli(['--root', workspace, 'context', 'personal/main']);
  assert.equal(read.json.okfVersion, '9.9');
  assert.ok(read.json.warnings.some(warning => /okf_version 9\.9/.test(warning)));
});

// spec: knowledge-format / Trust tiers and staleness
// spec: knowledge-format / Offsetless staleness
test('context reports OKF trust and staleness', async t => {
  const { workspace, cli, hub } = await fixture(t);
  await writeFile(join(hub, 'reviewed.md'), concept('Policy', 'Zanzibar policy.', 'verified: { by: human:example, at: 2026-01-01T00:00:00Z }\nstale_after: 2026-01-02T00:00:00Z\n'));
  await writeFile(join(hub, 'checked.md'), concept('Policy', 'Checked.', 'verified:\n  - { by: process:nightly, at: 2026-01-01T00:00:00Z }\nstale_after: 2999-01-01T00:00:00Z\nstatus: deprecated\n'));
  await writeFile(join(hub, 'offsetless.md'), concept('Policy', 'Offsetless.', 'stale_after: 2001-01-01T00:00:00\n'));
  const manifestPath = join(hub, 'hub.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.documents = ['README.md', 'reviewed.md', 'checked.md', 'offsetless.md'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await cli(['--root', workspace, 'context', 'personal/main']);
  assert.equal(result.code, 0, result.stderr);
  const okf = Object.fromEntries(result.json.documents.map(document => [document.path, document.okf]));
  assert.deepEqual([okf['reviewed.md'].trust, okf['reviewed.md'].stale, okf['reviewed.md'].status], ['human-reviewed', true, 'stable']);
  assert.deepEqual([okf['checked.md'].trust, okf['checked.md'].stale, okf['checked.md'].status], ['machine-confirmed', false, 'deprecated']);
  assert.deepEqual([okf['README.md'].trust, okf['README.md'].stale, okf['README.md'].status, okf['README.md'].type], ['unverified', false, 'stable', 'Guide']);
  assert.equal(okf['offsetless.md'].stale, false);
  assert.ok(result.json.warnings.some(warning => /offsetless\.md: stale_after needs .*UTC offset/.test(warning)));
  const found = await cli(['--root', workspace, 'search', 'zanzibar']);
  assert.equal(found.json.results[0].status, 'curated');
  assert.equal(found.json.results[0].okf.trust, 'human-reviewed');
});

// spec: knowledge-format / Stray file
test('a stray file warns on reads but fails validation', async t => {
  const { workspace, cli, hub } = await fixture(t);
  await writeFile(join(hub, 'scratch.md'), 'just some notes\n');
  const read = await cli(['--root', workspace, 'context', 'personal/main']);
  assert.equal(read.code, 0, read.stderr);
  assert.deepEqual(read.json.documents.map(document => document.path), ['README.md']);
  assert.ok(read.json.warnings.some(warning => /^scratch\.md: missing YAML frontmatter/.test(warning)));
  assert.equal((await cli(['--root', workspace, 'search', 'notes'])).code, 0);
  assert.equal((await cli(['--root', workspace, 'validate'])).error.code, 'INVALID_OKF');
  await writeFile(join(hub, 'README.md'), 'curated but not a concept\n');
  assert.equal((await cli(['--root', workspace, 'context', 'personal/main'])).error.code, 'INVALID_OKF');
});

// spec: context-workspaces / Captured note records its author
// spec: context-workspaces / Actor cannot be forged
test('CLI captures record --by and reject malformed actors before writing', async t => {
  const { workspace, cli, hub } = await fixture(t);
  const captured = await cli(['--root', workspace, 'capture', 'personal/main', 'Mine', '--by', 'human:example'], 'Hand written.\n');
  assert.equal(captured.code, 0, captured.stderr);
  assert.equal(frontmatter(await readFile(join(workspace, captured.json.path), 'utf8')).data.generated.by, 'human:example');
  const bad = await cli(['--root', workspace, 'capture', 'personal/main', 'Bad', '--by', 'not an actor'], 'x');
  assert.equal(bad.error.code, 'INVALID_INPUT');
  assert.equal((await readdir(join(hub, 'inbox'))).length, 1);
  assert.equal((await cli(['--root', workspace, 'list', '--by', 'human:example'])).error.code, 'INVALID_INPUT');
});

