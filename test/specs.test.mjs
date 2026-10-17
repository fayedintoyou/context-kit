import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const kit = fileURLToPath(new URL('../', import.meta.url));
const openspecBin = join(kit, 'node_modules/@fission-ai/openspec/bin/openspec.js');

const spec = name => `# ${name}

## Purpose
Shared ${name} behavior that several repositories rely on and must agree about.

## Requirements

### Requirement: ${name} works
The system SHALL support ${name}.

#### Scenario: Use ${name}
- **WHEN** a caller uses ${name}
- **THEN** it works
`;

async function writeSpec(root, id) {
  await mkdir(join(root, 'openspec/specs', id), { recursive: true });
  await writeFile(join(root, 'openspec/specs', id, 'spec.md'), spec(id));
}

// An isolated OpenSpec registry so the test never reads or changes the user's stores.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-specs-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  const workspace = join(base, 'workspace');
  const hub = join(workspace, 'hubs/platform');
  await mkdir(hub, { recursive: true });
  await writeFile(join(hub, 'README.md'), 'Platform context');
  await writeFile(join(hub, 'hub.json'), JSON.stringify({ version: 1, id: 'team/platform', description: 'Platform',
    documents: ['README.md'], skills: [], links: [], specStores: ['platform'] }));
  await writeSpec(workspace, 'local-only');
  const store = join(base, 'platform-store');
  await writeSpec(store, 'shared-auth');
  await writeFile(join(store, 'openspec/config.yaml'), 'schema: spec-driven\n');
  await exec(process.execPath, [openspecBin, 'store', 'register', store, '--id', 'platform', '--yes', '--json'], { env });
  const hubCli = async (...args) => {
    try {
      const { stdout } = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, ...args], { env });
      return JSON.parse(stdout);
    } catch (error) {
      return JSON.parse(error.stderr || error.stdout);
    }
  };
  return { base, env, workspace, store, hubCli };
}

test('repository and shared store specs stay separate with provenance', async t => {
  const { workspace, store, hubCli } = await fixture(t);
  const local = await hubCli('specs', 'list');
  assert.deepEqual(local.source, { kind: 'repo', path: workspace });
  assert.deepEqual(local.specs.map(item => item.id), ['local-only']);

  const shared = await hubCli('specs', 'list', '--store', 'platform');
  assert.deepEqual(shared.source, { kind: 'store', storeId: 'platform' });
  assert.equal(shared.root, store);
  assert.deepEqual(shared.specs.map(item => item.id), ['shared-auth']);

  const read = await hubCli('specs', 'read', 'shared-auth', '--store', 'platform');
  assert.match(read.spec.content, /Shared shared-auth behavior/);
  assert.deepEqual((await hubCli('specs', 'stores')).stores, [{ storeId: 'platform', hub: 'team/platform' }]);
});

test('store audits report the store root and snapshot', async t => {
  const { store, hubCli } = await fixture(t);
  const audit = await hubCli('specs', 'audit', '--store', 'platform');
  assert.equal(audit.status, 'structurally_valid');
  assert.equal(audit.root, store);
  assert.deepEqual(audit.source, { kind: 'store', storeId: 'platform' });
  assert.equal(audit.checklist[0].spec, 'shared-auth');
});

test('only declared, registered stores are readable', async t => {
  const { env, base, hubCli } = await fixture(t);
  assert.equal((await hubCli('specs', 'list', '--store', 'other')).error.code, 'UNKNOWN_STORE');
  assert.equal((await hubCli('specs', 'list', '--store', '../x')).error.code, 'INVALID_INPUT');
  await exec(process.execPath, [openspecBin, 'store', 'unregister', 'platform', '--json'], { env, cwd: base });
  assert.equal((await hubCli('specs', 'list', '--store', 'platform')).error.code, 'ADAPTER_FAILED');
});

test('a repository that delegates to a store is not mistaken for its own specs', async t => {
  const { workspace, hubCli } = await fixture(t);
  await rm(join(workspace, 'openspec'), { recursive: true });
  await mkdir(join(workspace, 'openspec'));
  await writeFile(join(workspace, 'openspec/config.yaml'), 'schema: spec-driven\nstore: platform\n');
  assert.equal((await hubCli('specs', 'list')).error.code, 'WRONG_SPEC_ROOT');
});
