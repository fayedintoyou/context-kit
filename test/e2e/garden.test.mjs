import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = fileURLToPath(new URL('../../', import.meta.url));
const openspec = join(kit, 'node_modules/@fission-ai/openspec/bin/openspec.js');
const requirement = (name, scenario = `Use ${name}`, text = 'The service SHALL find matching locations by text, radius and filters.') =>
  `### Requirement: ${name}\n${text}\n${scenario ? `\n#### Scenario: ${scenario}\n- **WHEN** a caller searches locations\n- **THEN** matching locations are returned\n` : ''}`;
const spec = content => `# Locations\n\n## Purpose\nFind locations by text, radius and filters for callers of the location service.\n\n## Requirements\n\n${content}`;
async function put(root, path, content) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-garden-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  delete env.CONTEXT_KIT_ROOT;
  await put(root, 'openspec/config.yaml', 'schema: spec-driven\n');
  await put(root, 'openspec/specs/locations/spec.md', spec(requirement('Search')));
  const cli = async (...args) => {
    try { return JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env })).stdout); }
    catch (error) { return JSON.parse(error.stderr || error.stdout); }
  };
  const os = (...args) => exec(process.execPath, [openspec, ...args], { cwd: root, env });
  const git = (...args) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env });
  return { root, base, env, cli, os, git };
}
async function hashes(root) {
  const result = {};
  async function walk(path = '') {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else result[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
    }
  }
  await walk();
  return result;
}

// spec: spec-gardening / Garden a repository
// spec: spec-gardening / Gardening writes nothing
// spec: spec-gardening / Written without a change
// spec: spec-gardening / No taxonomy
// spec: spec-gardening / No link convention
test('garden reports canonical counts, audit keys and snapshot without writing', async t => {
  const { root, cli, git } = await fixture(t);
  await git('init', '-q');
  await git('add', '.');
  await git('commit', '-qm', 'Initial');
  const before = await hashes(root);
  const report = await cli('specs', 'garden');
  assert.equal(report.status, 'ok');
  assert.deepEqual(await hashes(root), before);
  const audit = await cli('specs', 'audit');
  assert.deepEqual(report.requirements.map(r => r.key), audit.checklist.map(r => r.key));
  assert.equal(report.snapshot.head, audit.snapshot.head);
  assert.equal(report.snapshot.dirty, false);
  assert.equal(report.snapshot.canonicalHash, audit.snapshot.canonicalHash);
  assert.deepEqual(report.adapter, { name: 'openspec', version: '1.14.3' });
  const [item] = report.specs;
  assert.equal(item.lines, (await readFile(join(root, 'openspec/specs/locations/spec.md'), 'utf8')).trimEnd().split('\n').length);
  assert.equal(item.requirements, 1);
  assert.equal(item.scenarios, 1);
  assert.equal(item.domain, 'unchecked');
  assert.equal(report.taxonomy.status, 'absent');
  assert.deepEqual(report.requirements[0].history, []);
  assert.equal(report.requirements[0].lastChanged, null);
  assert.deepEqual(report.trace, { convention: null, status: 'not_collected' });
  assert.equal(report.requirements[0].untested, null);
});

// spec: spec-gardening / Pending changes only
test('pending deltas are not canonical', async t => {
  const { root, cli } = await fixture(t);
  await rm(join(root, 'openspec/specs'), { recursive: true });
  await put(root, 'openspec/changes/pending/specs/locations/spec.md', '## ADDED Requirements\n'+requirement('Search'));
  const report = await cli('specs', 'garden');
  assert.equal(report.status, 'no_canonical_specs');
  assert.deepEqual(report.specs, []);
  assert.deepEqual(report.requirements, []);
});

// spec: spec-gardening / Oversized spec
// spec: spec-gardening / Domain override
test('limits resolve per domain, taxonomy and built-in defaults', async t => {
  const { root, cli } = await fixture(t);
  const content = spec(requirement('Search')+'\n'+requirement('Browse', ''));
  await put(root, 'openspec/specs/locations/spec.md', content);
  await put(root, 'openspec/specs/other/spec.md', content);
  await put(root, 'openspec/taxonomy.yaml', 'limits: { maxRequirements: 1 }\ndomains:\n  locations:\n    purpose: Finding places\n    limits: { maxRequirements: 2 }\n');
  const report = await cli('specs', 'garden');
  assert.deepEqual(report.specs[0].flags, []);
  assert.deepEqual(report.specs[1].flags, ['oversized']);
  assert.equal(report.specs[0].limits.maxRequirements, 2);
  assert.equal(report.specs[1].limits.maxRequirements, 1);
  assert.equal(report.specs[1].limits.maxLines, report.limits.maxLines);
  assert.deepEqual(report.specs[0].requirementsWithoutScenarios, ['Browse']);
  await put(root, 'openspec/taxonomy.yaml', 'limits: { maxLines: 1 }\ndomains: {}\n');
  assert.ok((await cli('specs', 'garden')).specs.every(s => s.flags.includes('oversized')));
});

async function propose(os, root, name, delta, metadata = '') {
  await os('new', 'change', name);
  await put(root, `openspec/changes/${name}/proposal.md`, '# Why\n\nImprove location behavior for callers.\n\n## What Changes\n\nUpdate the location requirements.\n\n## Impact\n\nLocation specifications.\n');
  await put(root, `openspec/changes/${name}/tasks.md`, '- [x] Update behavior\n');
  await put(root, `openspec/changes/${name}/specs/locations/spec.md`, delta);
  if (metadata) await put(root, `openspec/changes/${name}/.openspec.yaml`, 'schema: spec-driven\n'+metadata);
}

// spec: spec-gardening / History across a rename
test('history follows CLI-archived additions, modifications and renames', async t => {
  const { root, cli, os } = await fixture(t);
  await rm(join(root, 'openspec/specs'), { recursive: true });
  await propose(os, root, 'z-add-search', '## ADDED Requirements\n'+requirement('Search'));
  await os('archive', 'z-add-search', '--yes');
  await propose(os, root, 'y-modify-search', '## MODIFIED Requirements\n'+requirement('Search', 'Use Search', 'The service SHALL find matching locations by text, radius and optional filters.'));
  await os('archive', 'y-modify-search', '--yes');
  await propose(os, root, 'a-rename-search', '## RENAMED Requirements\n- FROM: `### Requirement: Search`\n- TO: `### Requirement: Find places`\n');
  await os('archive', 'a-rename-search', '--yes');
  await propose(os, root, 'combined-rename', '## MODIFIED Requirements\n'+requirement('Lookup places', 'Use Search')+
    '\n## RENAMED Requirements\n- FROM: `### Requirement: Find places`\n- TO: `### Requirement: Lookup places`\n');
  await os('archive', 'combined-rename', '--yes');
  const report = await cli('specs', 'garden');
  assert.equal(report.requirements[0].requirement, 'Lookup places');
  assert.deepEqual(report.requirements[0].history.map(h => [h.change, h.op]),
    [['z-add-search', 'ADDED'], ['y-modify-search', 'MODIFIED'], ['a-rename-search', 'RENAMED'],
      ['combined-rename', 'RENAMED'], ['combined-rename', 'MODIFIED']]);
  assert.ok(report.requirements[0].history.every(h => /^\d{4}-\d{2}-\d{2}$/.test(h.date)));
  assert.equal(report.requirements[0].lastChanged, report.requirements[0].history.at(-1).date);
  await propose(os, root, 'reintroduce-search', '## ADDED Requirements\n'+requirement('Search', 'External search', 'The service SHALL query an external catalog.'));
  await os('archive', 'reintroduce-search', '--yes');
  const reused = await cli('specs', 'garden');
  const lookup = reused.requirements.find(r => r.requirement === 'Lookup places');
  const search = reused.requirements.find(r => r.requirement === 'Search');
  assert.ok(!lookup.history.some(h => h.change === 'reintroduce-search'));
  assert.deepEqual(search.history, []);
  for (const item of [lookup, search]) {
    assert.deepEqual(item.historyAmbiguities, [{ key: search.key, date: report.requirements[0].lastChanged,
      reason: 'same_day_name_reuse', changes: ['reintroduce-search', 'z-add-search'] }]);
  }
});

// spec: spec-gardening / Requirement under active change
test('active deltas touch specs and lock only modified, removed or renamed requirements', async t => {
  const { root, cli, os } = await fixture(t);
  await put(root, 'openspec/specs/locations/spec.md', spec(requirement('Search')+requirement('Browse')+requirement('Old name')));
  await propose(os, root, 'edit-search', '## MODIFIED Requirements\n'+requirement('Search'));
  await propose(os, root, 'retire-browse', '## REMOVED Requirements\n### Requirement: Browse\n');
  await propose(os, root, 'rename-old', '## RENAMED Requirements\n- FROM: `### Requirement: Old name`\n- TO: `### Requirement: New name`\n');
  await propose(os, root, 'add-new', '## ADDED Requirements\n'+requirement('Extra'));
  const report = await cli('specs', 'garden');
  assert.deepEqual(report.specs[0].lockedBy, ['add-new', 'edit-search', 'rename-old', 'retire-browse']);
  assert.deepEqual(report.requirements.map(r => r.lockedBy), [['edit-search'], ['retire-browse'], ['rename-old']]);
  await put(root, 'openspec/specs/locations/spec.md', spec(requirement('Search')+requirement('Untouched')));
  assert.deepEqual((await cli('specs', 'garden')).requirements[1].lockedBy, []);
});

// spec: spec-gardening / Near-duplicate requirements
test('lexical overlap reports related wording within and across specs', async t => {
  const { root, cli } = await fixture(t);
  await put(root, 'openspec/specs/places/spec.md', spec(requirement('Search')+requirement('Browse')));
  await put(root, 'openspec/specs/weather/spec.md', spec(requirement('Forecast', '', 'The system MUST predict rainfall accurately tomorrow.')));
  const report = await cli('specs', 'garden');
  assert.equal(report.overlap.length, 3);
  assert.ok(report.overlap.every(pair => pair.method === 'lexical' && pair.score >= report.limits.overlapThreshold));
  assert.ok(report.overlap.every(pair => !pair.a.startsWith('weather:') && !pair.b.startsWith('weather:')));
  assert.equal(report.truncated, false);
});

// spec: spec-gardening / Near-duplicate requirements
test('overlap keeps the highest scores within the output budget', async t => {
  const { root, cli } = await fixture(t);
  await put(root, 'openspec/specs/locations/spec.md', spec(Array.from({ length: 65 }, (_, i) => requirement(`Search ${i}`)).join('\n')));
  const report = await cli('specs', 'garden');
  assert.equal(report.truncated, true);
  assert.ok(report.overlap.length > 0 && report.overlap.length < 65 * 64 / 2);
  assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2)) <= 128 * 1024);
  assert.ok(report.overlap.every((pair, i) => !i || pair.score <= report.overlap[i - 1].score));
});

// spec: spec-gardening / Unlinked scenario
test('trace uses attached spec links and reports uncovered scenario names', async t => {
  const { root, cli } = await fixture(t);
  await put(root, 'openspec/specs/locations/spec.md', spec(requirement('Search')+requirement('Browse')));
  await put(root, 'test/e2e/search.test.mjs', "// spec: locations / Use Search\ntest('search', () => {});\n// spec: locations / Use Browse\n\ntest('detached', () => {});\n");
  const report = await cli('specs', 'garden');
  assert.deepEqual(report.trace, { convention: 'spec-links', status: 'collected' });
  assert.deepEqual(report.requirements.map(r => r.untested), [[], ['Use Browse']]);
});

// spec: spec-gardening / Taxonomy drift
test('taxonomy distinguishes undeclared, absent and retired domains', async t => {
  const { root, cli } = await fixture(t);
  await put(root, 'openspec/taxonomy.yaml', 'domains:\n  future:\n    purpose: Future work\nretired: [locations]\n');
  const report = await cli('specs', 'garden');
  assert.deepEqual(report.taxonomy, { status: 'checked', undeclared: ['locations'], empty: ['future'], retiredInUse: ['locations'] });
  assert.equal(report.specs[0].domain, 'undeclared');
});

// spec: spec-gardening / Malformed taxonomy
test('bad YAML, invalid identifiers and limits name the configuration problem', async t => {
  const { root, cli } = await fixture(t);
  for (const yaml of ['domains: [', 'domains: { Bad_ID: { purpose: Bad } }', 'domains: {}\nlimits: { maxLines: -1 }', 'domains: { valid: {} }', 'domains: {}\nunknown: true']) {
    await put(root, 'openspec/taxonomy.yaml', yaml);
    const result = await cli('specs', 'garden');
    assert.equal(result.error?.code, 'INVALID_CONFIG', JSON.stringify(result));
    assert.match(result.error.message, /openspec\/taxonomy.yaml: .+/s);
  }
});

// spec: spec-gardening / Garden over MCP
test('MCP and CLI return the same report and respect addon selection', async t => {
  const { root, env, cli } = await fixture(t);
  const client = new Client({ name: 'garden-test', version: '1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
  t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'garden_specs'));
  const report = await client.callTool({ name: 'garden_specs', arguments: {} });
  assert.deepEqual(JSON.parse(report.content[0].text), await cli('specs', 'garden'));
  const disabled = join(root, 'core-only');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', disabled, '--addons', 'none'], { env });
  const core = new Client({ name: 'garden-disabled', version: '1.0' });
  await core.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', disabled], env, stderr: 'pipe' }));
  t.after(() => core.close());
  assert.ok(!(await core.listTools()).tools.some(tool => tool.name === 'garden_specs'));
  const refused = await core.callTool({ name: 'garden_specs', arguments: {} });
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'ADDON_DISABLED');
});

// spec: spec-gardening / Garden a repository
test('gardening rejects a snapshot changed during collection', async t => {
  const { root, base, env, cli } = await fixture(t);
  const shim = join(base, 'bin');
  await mkdir(shim);
  const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  await writeFile(join(shim, 'git'), `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then
  n=$(( $(cat "${base}/git-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${base}/git-count"
  [ "$n" = 2 ] && printf '\\nChanged.\\n' >> "${root}/openspec/specs/locations/spec.md"
fi
exec "${realGit}" "$@"
`);
  await chmod(join(shim, 'git'), 0o755);
  env.PATH = `${shim}:${env.PATH}`;
  assert.equal((await cli('specs', 'garden')).error?.code, 'SNAPSHOT_CHANGED');
});

// spec: spec-gardening / History across a rename
test('OpenSpec requires explicit capability retirement and deletes the emptied spec', async t => {
  const { root, os, cli } = await fixture(t);
  await propose(os, root, 'retire-locations', '## REMOVED Requirements\n### Requirement: Search\n**Reason**: Confirmed obsolete.\n**Migration**: No callers remain.\n');
  const blocked = await os('archive', 'retire-locations', '--yes').catch(error => error);
  assert.notEqual(blocked.code, undefined);
  assert.match(blocked.stdout + blocked.stderr, /retire_capabilities/);
  assert.match(await readFile(join(root, 'openspec/specs/locations/spec.md'), 'utf8'), /Requirement: Search/);
  await put(root, 'openspec/changes/retire-locations/.openspec.yaml', 'schema: spec-driven\nretire_capabilities: true\n');
  await os('archive', 'retire-locations', '--yes');
  await assert.rejects(readFile(join(root, 'openspec/specs/locations/spec.md')), { code: 'ENOENT' });
  assert.equal((await cli('specs', 'garden')).status, 'no_canonical_specs');
});
