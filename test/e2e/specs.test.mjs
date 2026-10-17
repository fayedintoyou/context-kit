import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = fileURLToPath(new URL('../../', import.meta.url));
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
  await writeFile(join(hub, 'README.md'), '---\ntype: Guide\n---\n\nPlatform context\n');
  await writeFile(join(hub, 'hub.json'), JSON.stringify({ version: 1, id: 'team/platform', description: 'Platform',
    documents: ['README.md'], skills: [], links: [], specStores: ['platform'] }));
  await writeSpec(workspace, 'local-only');
  const store = join(base, 'platform-store');
  await writeSpec(store, 'shared-auth');
  await writeFile(join(store, 'openspec/config.yaml'), 'schema: spec-driven\n');
  await exec(process.execPath, [openspecBin, 'store', 'register', store, '--id', 'platform', '--yes', '--json'], { env });
  const run = extra => async (...args) => {
    try {
      const { stdout } = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, ...args], { env: { ...env, ...extra } });
      return JSON.parse(stdout);
    } catch (error) {
      return JSON.parse(error.stderr || error.stdout);
    }
  };
  const hubCli = Object.assign(run({}), { withEnv: run });
  const mcp = async () => {
    const client = new Client({ name: 'specs-test', version: '1.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env, stderr: 'pipe' }));
    t.after(() => client.close());
    return async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  };
  return { base, env, workspace, store, hubCli, mcp };
}

// spec: canonical-spec-audit / Read a declared store
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
  assert.deepEqual((await hubCli('specs', 'stores')).stores, [{ storeId: 'platform', via: 'hub', hub: 'team/platform' }]);
  assert.equal((await hubCli('specs', 'read', 'missing-spec', '--store', 'platform')).error.code, 'UNKNOWN_SPEC');
});

// spec: canonical-spec-audit / Audit a store directly
test('store audits report the store root and snapshot', async t => {
  const { store, hubCli } = await fixture(t);
  const audit = await hubCli('specs', 'audit', '--store', 'platform');
  assert.equal(audit.status, 'structurally_valid');
  assert.equal(audit.root, store);
  assert.deepEqual(audit.source, { kind: 'store', storeId: 'platform' });
  assert.equal(audit.checklist[0].spec, 'shared-auth');
  assert.equal(audit.scope.semantic, 'not_assessed');
  assert.match(audit.scope.review, /each repository that references this store/);
  assert.equal(audit.referenced, undefined);
});

// spec: canonical-spec-audit / Reject an undeclared store
test('only declared, registered stores are readable', async t => {
  const { env, base, hubCli } = await fixture(t);
  assert.equal((await hubCli('specs', 'list', '--store', 'other')).error.code, 'UNKNOWN_STORE');
  assert.equal((await hubCli('specs', 'list', '--store', '../x')).error.code, 'INVALID_INPUT');
  await exec(process.execPath, [openspecBin, 'store', 'unregister', 'platform', '--json'], { env, cwd: base });
  assert.equal((await hubCli('specs', 'list', '--store', 'platform')).error.code, 'ADAPTER_FAILED');
});

// spec: canonical-spec-audit / Reject inherited root
test('a repository that delegates to a store is not mistaken for its own specs', async t => {
  const { workspace, hubCli } = await fixture(t);
  await rm(join(workspace, 'openspec'), { recursive: true });
  await mkdir(join(workspace, 'openspec'));
  await writeFile(join(workspace, 'openspec/config.yaml'), 'schema: spec-driven\nstore: platform\n');
  assert.equal((await hubCli('specs', 'list')).error.code, 'WRONG_SPEC_ROOT');
});

// spec: canonical-spec-audit / Reject inherited root
test('a workspace without its own OpenSpec root does not inherit a parent repository', async t => {
  const { base, workspace, hubCli } = await fixture(t);
  await rm(join(workspace, 'openspec'), { recursive: true });
  await writeSpec(base, 'parent-only');
  await writeFile(join(base, 'openspec/config.yaml'), 'schema: spec-driven\n');
  const listing = await hubCli('specs', 'list');
  assert.equal(listing.error.code, 'WRONG_SPEC_ROOT');
  assert.equal(listing.specs, undefined);
  assert.equal((await hubCli('specs', 'audit')).error.code, 'WRONG_SPEC_ROOT');
});

// The workspace repository references `platform` (registered) and `missing` (not registered);
// `platform` itself references `nested`, which must not be followed.
async function referencing(t) {
  const context = await fixture(t);
  const { base, env, workspace, store } = context;
  const nested = join(base, 'nested-store');
  await writeSpec(nested, 'deep');
  await writeFile(join(nested, 'openspec/config.yaml'), 'schema: spec-driven\n');
  await exec(process.execPath, [openspecBin, 'store', 'register', nested, '--id', 'nested', '--yes', '--json'], { env });
  await writeFile(join(store, 'openspec/config.yaml'), 'schema: spec-driven\nreferences:\n  - nested\n');
  await writeSpec(workspace, 'shared-auth');
  await writeFile(join(workspace, 'openspec/config.yaml'),
    'schema: spec-driven\nreferences:\n  - platform\n  - id: missing\n    remote: https://example.com/missing.git\n');
  // Readable through the reference alone, not through a hub declaration.
  await writeFile(join(workspace, 'hubs/platform/hub.json'), JSON.stringify({ version: 1, id: 'team/platform',
    description: 'Platform', documents: ['README.md'], skills: [], links: [] }));
  return context;
}

// spec: canonical-spec-audit / Repository references a registered store
// spec: canonical-spec-audit / Referenced store is missing
// spec: canonical-spec-audit / Same identifier in repository and store
// spec: canonical-spec-audit / Read a referenced store
test('repository listings report referenced stores separately and one level deep', async t => {
  const { hubCli } = await referencing(t);
  const listing = await hubCli('specs', 'list');
  assert.deepEqual(listing.specs.map(item => item.id), ['local-only', 'shared-auth']);
  const [platform, missing, ...rest] = listing.references;
  assert.equal(rest.length, 0);
  assert.equal(platform.storeId, 'platform');
  assert.equal(platform.status, 'available');
  assert.deepEqual(platform.specs.map(item => item.id), ['shared-auth']);
  assert.equal(missing.storeId, 'missing');
  assert.equal(missing.status, 'warning');
  assert.equal(missing.issues[0].code, 'reference_unresolved');
  assert.equal(missing.specs, undefined);

  const read = await hubCli('specs', 'read', 'shared-auth', '--store', 'platform');
  assert.deepEqual(read.source, { kind: 'store', storeId: 'platform' });
  const stores = (await hubCli('specs', 'stores')).stores;
  assert.deepEqual(stores.map(({ storeId, via, status }) => ({ storeId, via, status })),
    [{ storeId: 'platform', via: 'reference', status: 'available' }, { storeId: 'missing', via: 'reference', status: 'warning' }]);
  assert.equal((await hubCli('specs', 'list', '--store', 'nested')).error.code, 'UNKNOWN_STORE');
});

// spec: canonical-spec-audit / Audit a repository with references
// spec: canonical-spec-audit / Audit current code
test('repository audits list referenced requirements apart from their own', async t => {
  const { hubCli, workspace, env } = await referencing(t);
  const git = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: workspace, env });
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Snapshot');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const audit = await hubCli('specs', 'audit');
  assert.equal(audit.status, 'structurally_valid');
  assert.equal(audit.semantic, 'not_assessed');
  assert.deepEqual(audit.adapter, { name: 'openspec', version: '1.14.3' });
  assert.equal(audit.snapshot.head, head);
  assert.equal(audit.snapshot.dirty, false);
  assert.match(audit.snapshot.canonicalHash, /^[0-9a-f]{64}$/);
  assert.equal(audit.snapshot.implementationEvidence, 'not_collected');
  assert.ok(audit.checklist.every(item => item.semantic === 'not_assessed' && !item.evidence.length));
  assert.deepEqual(audit.checklist.map(item => item.spec), ['local-only', 'shared-auth']);
  assert.ok(audit.checklist.every(item => !('applicability' in item)));
  assert.equal(audit.referenced.length, 1);
  const [platform] = audit.referenced;
  assert.equal(platform.storeId, 'platform');
  assert.match(platform.snapshot.canonicalHash, /^[0-9a-f]{64}$/);
  assert.equal(platform.checklist.length, 1);
  assert.match(platform.checklist[0].key, /^store:platform\/shared-auth:[0-9a-f]{16}$/);
  assert.equal(platform.checklist[0].applicability, 'not_assessed');
  assert.equal(platform.checklist[0].semantic, 'not_assessed');
  const ownKeys = new Set(audit.checklist.map(item => item.key));
  assert.ok(!ownKeys.has(platform.checklist[0].key));
  assert.equal(platform.status, 'structurally_valid');
  assert.equal(platform.structural.strict, true);
  assert.equal(audit.snapshot.gitRoot, workspace);
  assert.equal(audit.snapshot.rootIsGitRoot, true);
  assert.deepEqual(audit.referenceWarnings.map(item => item.storeId), ['missing']);
});

// spec: canonical-spec-audit / Pending-only repository
test('a repository with only pending changes is reported, not passed', async t => {
  const { workspace, hubCli } = await fixture(t);
  await rm(join(workspace, 'openspec/specs'), { recursive: true });
  await mkdir(join(workspace, 'openspec/changes/draft/specs/pending'), { recursive: true });
  await writeFile(join(workspace, 'openspec/changes/draft/specs/pending/spec.md'), spec('pending').replace('## Requirements', '## ADDED Requirements'));
  await writeFile(join(workspace, 'openspec/config.yaml'), 'schema: spec-driven\n');
  const audit = await hubCli('specs', 'audit');
  assert.equal(audit.status, 'no_canonical_specs');
  assert.deepEqual(audit.checklist, []);
  assert.equal(audit.structural.valid, false);
});

// spec: canonical-spec-audit / Referenced store changes during audit
test('an audit fails when a referenced store changes between its collections', async t => {
  const { base, store, hubCli } = await referencing(t);
  // The audit reads git state once per root per collection; this stand-in git edits the
  // store when the audit inspects it the second time, i.e. during the second collection.
  const shim = join(base, 'bin');
  await mkdir(shim);
  const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  await writeFile(join(shim, 'git'), `#!/bin/sh
if [ "$(pwd -P)" = "${store}" ] && [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then
  n=$(( $(cat "${base}/git-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${base}/git-count"
  [ "$n" = 2 ] && printf '\\nEdited mid-audit.\\n' >> "${store}/openspec/specs/shared-auth/spec.md"
fi
exec "${realGit}" "$@"
`);
  await chmod(join(shim, 'git'), 0o755);
  const audit = await hubCli.withEnv({ PATH: `${shim}:${process.env.PATH}` })('specs', 'audit');
  assert.equal(audit.error?.code, 'SNAPSHOT_CHANGED');
});


// spec: canonical-spec-audit / Audit current code
test('an audit nested in a larger repository reports that repository and only its own changes', async t => {
  const { base, env, workspace, hubCli } = await fixture(t);
  const git = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: base, env });
  await git('init', '-q');
  await git('add', 'workspace');
  await git('commit', '-q', '-m', 'Workspace only');
  await writeFile(join(base, 'unrelated.txt'), 'outside the audited root');
  const audit = await hubCli('specs', 'audit');
  assert.equal(audit.snapshot.gitRoot, base);
  assert.equal(audit.snapshot.rootIsGitRoot, false);
  assert.equal(audit.snapshot.dirty, false);
  await writeFile(join(workspace, 'new.txt'), 'inside');
  assert.equal((await hubCli('specs', 'audit')).snapshot.dirty, true);
});

// spec: canonical-spec-audit / Read a referenced store
test('a repository without hubs can still read the stores it references', async t => {
  const { workspace, hubCli } = await referencing(t);
  await rm(join(workspace, 'hubs'), { recursive: true });
  const read = await hubCli('specs', 'read', 'shared-auth', '--store', 'platform');
  assert.deepEqual(read.source, { kind: 'store', storeId: 'platform' });
  assert.deepEqual((await hubCli('specs', 'list', '--store', 'platform')).specs.map(item => item.id), ['shared-auth']);
  assert.deepEqual((await hubCli('specs', 'stores')).stores.map(({ storeId, via }) => ({ storeId, via })),
    [{ storeId: 'platform', via: 'reference' }, { storeId: 'missing', via: 'reference' }]);
  assert.equal((await hubCli('specs', 'list', '--store', 'nested')).error.code, 'UNKNOWN_STORE');
});


// spec: spec-gardening / Garden a repository
test('store gardening uses its own canonical tree, locks, taxonomy and no code trace', async t => {
  const { store, workspace, hubCli } = await fixture(t);
  await writeFile(join(store, 'openspec/taxonomy.yaml'), 'domains: { shared-auth: { purpose: Shared authentication } }\n');
  await mkdir(join(store, 'openspec/changes/edit/specs/shared-auth'), { recursive: true });
  await writeFile(join(store, 'openspec/changes/edit/specs/shared-auth/spec.md'), '## MODIFIED Requirements\n### Requirement: shared-auth works\n');
  await mkdir(join(store, 'test/e2e'), { recursive: true });
  await writeFile(join(store, 'test/e2e/auth.test.mjs'), "// spec: shared-auth / Use shared-auth\ntest('auth', () => {});\n");
  const report = await hubCli('specs', 'garden', '--store', 'platform');
  assert.equal(report.root, store);
  assert.deepEqual(report.source, { kind: 'store', storeId: 'platform' });
  assert.deepEqual(report.specs.map(s => s.id), ['shared-auth']);
  assert.equal(report.specs[0].domain, 'declared');
  assert.deepEqual(report.requirements[0].lockedBy, ['edit']);
  assert.equal(report.trace.status, 'not_collected');
  assert.equal(report.requirements[0].untested, null);
  assert.deepEqual(report.requirements.map(r => r.key), (await hubCli('specs', 'audit', '--store', 'platform')).checklist.map(r => r.key));
  assert.equal((await hubCli('specs', 'garden', '--store', 'unknown')).error.code, 'UNKNOWN_STORE');
  assert.equal((await hubCli('specs', 'garden', '--store', '../bad')).error.code, 'INVALID_INPUT');
});

// Parties use fictional upstreams; contracts map spec ids to party names.
const site = 'https://github.com/example/site';
const game = 'https://github.com/example/game';
const partiesFile = (contracts, parties = { site, game }) => 'parties:\n' +
  Object.entries(parties).map(([name, upstream]) => `  ${name}: ${upstream}\n`).join('') +
  'contracts:\n' + Object.entries(contracts).map(([spec, names]) => `  ${spec}: [${names.join(', ')}]\n`).join('');
async function storeChange(store, env, name, specId) {
  await exec(process.execPath, [openspecBin, 'new', 'change', name], { cwd: store, env });
  await writeFile(join(store, 'openspec/changes', name, 'proposal.md'), `# Why\n\nAgree on ${specId} between the site and the game.\n\n## What Changes\n\nAdd ${specId}.\n\n## Impact\n\nShared specs.\n`);
  await writeFile(join(store, 'openspec/changes', name, 'tasks.md'), `- [x] Write ${specId}\n`);
  await mkdir(join(store, 'openspec/changes', name, 'specs', specId), { recursive: true });
  await writeFile(join(store, 'openspec/changes', name, 'specs', specId, 'spec.md'), spec(specId).replace('## Requirements', '## ADDED Requirements'));
}

// spec: cross-repo-contracts / Parties are listed
test('a store lists its parties and contracts the same over CLI and MCP', async t => {
  const { store, hubCli, mcp } = await fixture(t);
  const source = { kind: 'store', storeId: 'platform' };
  assert.deepEqual(await hubCli('specs', 'parties', '--store', 'platform'), { root: store, source, parties: [], contracts: [] });
  await writeFile(join(store, 'openspec/parties.yaml'), partiesFile({ 'shared-auth': ['site', 'game'] }));
  const listed = await hubCli('specs', 'parties', '--store', 'platform');
  assert.deepEqual(listed, { root: store, source, parties: [{ name: 'site', upstream: site }, { name: 'game', upstream: game }],
    contracts: [{ spec: 'shared-auth', parties: ['site', 'game'], status: 'canonical' }] });
  assert.deepEqual(await (await mcp())('list_parties', { store: 'platform' }), listed);
});

// spec: cross-repo-contracts / Parties belong to stores
test('parties are read only from stores, never from a repository', async t => {
  const { workspace, hubCli, mcp } = await fixture(t);
  await writeFile(join(workspace, 'openspec/parties.yaml'), 'parties: [not: valid\n');
  const refused = await hubCli('specs', 'parties');
  assert.equal(refused.error.code, 'INVALID_INPUT');
  assert.match(refused.error.message, /declared by stores/);
  assert.deepEqual(await (await mcp())('list_parties', {}), refused);
  assert.deepEqual((await hubCli('specs', 'list')).specs.map(item => item.id), ['local-only']);
});

// spec: cross-repo-contracts / Contract names an unknown party
test('an invalid parties file fails store reads with INVALID_CONFIG naming the problem', async t => {
  const { store, hubCli, mcp } = await fixture(t);
  const call = await mcp();
  const tools = { parties: 'list_parties', list: 'list_specs' };
  const file = join(store, 'openspec/parties.yaml');
  const fails = async (content, problem, commands = [['parties']]) => {
    await writeFile(file, content);
    for (const command of commands) {
      const { error } = await hubCli('specs', ...command, '--store', 'platform');
      assert.equal(error?.code, 'INVALID_CONFIG', `${command} ${content}`);
      assert.match(error.message, /openspec\/parties\.yaml/);
      assert.match(error.message, problem);
      assert.deepEqual(await call(tools[command[0]], { store: 'platform' }), { error });
    }
  };
  await fails(partiesFile({ 'shared-auth': ['site', 'web'] }), /undeclared party "web"/, [['parties'], ['list']]);
  await fails(partiesFile({ 'shared-auth': ['site', '""'] }), /undeclared party ""/);
  await fails(partiesFile({}, { site: 'file:///tmp/%ZZ', game }), /party site upstream is not a git URL/);
  await fails('parties:\n  site: { url: x }\n  game: ' + game + '\n', /party site upstream is not a git URL: a map/);
  await fails('parties:\n  site: &loop { self: *loop }\n  game: ' + game + '\n', /party site upstream is not a git URL: a map/);
  await fails('parties:\n  site: &loop [*loop]\n  game: ' + game + '\n', /party site upstream is not a git URL: a list/);
  await fails('parties: [site\n', /not valid YAML/);
  await fails(partiesFile({}, { Site: site, game }), /invalid party name Site/);
  await fails(partiesFile({}, { site: 'example/site', game }), /party site upstream is not a git URL/);
  await fails(partiesFile({}, { site, web: 'git@github.com:Example/site.git' }), /parties site and web share upstream/);
  await fails(partiesFile({ 'shared-auth': ['site'] }), /contract shared-auth needs at least two parties/);
  await fails(partiesFile({ 'shared-auth': ['site', 'site'] }), /contract shared-auth needs at least two parties/);
  await fails('parties: { site: ' + site + ' }\nowners: []\n', /parties and contracts/);
});

// spec: cross-repo-contracts / Contract names no spec
test('a contract whose spec is neither canonical nor proposed fails', async t => {
  const { env, store, hubCli, mcp } = await fixture(t);
  await writeFile(join(store, 'openspec/parties.yaml'), partiesFile({ 'game-embedding': ['site', 'game'] }));
  await storeChange(store, env, 'embed', 'game-embedding');
  assert.equal((await hubCli('specs', 'parties', '--store', 'platform')).contracts[0].status, 'proposed');
  await rm(join(store, 'openspec/changes/embed'), { recursive: true });
  const { error } = await hubCli('specs', 'parties', '--store', 'platform');
  assert.equal(error.code, 'INVALID_CONFIG');
  assert.match(error.message, /openspec\/parties\.yaml: contract game-embedding names no canonical spec/);
  assert.deepEqual(await (await mcp())('list_parties', { store: 'platform' }), { error });
});

// spec: cross-repo-contracts / Contract proposed with its change
test('a contract declared with its change is proposed until the change archives', async t => {
  const { env, store, hubCli, mcp } = await fixture(t);
  const call = await mcp();
  await writeFile(join(store, 'openspec/parties.yaml'), partiesFile({ 'game-embedding': ['site', 'game'] }));
  await storeChange(store, env, 'embed', 'game-embedding');
  const proposed = await hubCli('specs', 'parties', '--store', 'platform');
  assert.deepEqual(proposed.contracts, [{ spec: 'game-embedding', parties: ['site', 'game'], status: 'proposed' }]);
  assert.deepEqual(await call('list_parties', { store: 'platform' }), proposed);
  assert.deepEqual((await hubCli('specs', 'list', '--store', 'platform')).specs.map(item => item.id), ['shared-auth']);
  const archive = JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', store, 'specs', 'archive', '--ready'], { env })).stdout);
  assert.deepEqual([archive.archived.map(item => item.name), archive.valid], [['embed'], true]);
  const canonical = await hubCli('specs', 'parties', '--store', 'platform');
  assert.deepEqual(canonical.contracts, [{ spec: 'game-embedding', parties: ['site', 'game'], status: 'canonical' }]);
  assert.deepEqual(await call('list_parties', { store: 'platform' }), canonical);
});
