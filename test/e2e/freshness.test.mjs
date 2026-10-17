import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const iso = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = 24 * 3600 * 1000;
const now = Date.now();

async function fixture(t, policy, concepts) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-fresh-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  delete env.CONTEXT_KIT_ROOT;
  const workspace = join(base, 'workspace');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', workspace], { env });
  const hub = join(workspace, 'hubs/personal');
  for (const [name, frontmatter] of Object.entries(concepts)) {
    await writeFile(join(hub, `${name}.md`), `---\n${frontmatter}\n---\n\nZebra ${name}.\n`);
  }
  const manifestPath = join(hub, 'hub.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, documents: ['README.md', ...Object.keys(concepts).map(name => `${name}.md`)],
    ...(policy === undefined ? {} : { freshness: policy }) }));
  const cli = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', workspace, ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, error: JSON.parse(error.stderr).error }; }
  };
  return { cli };
}

// spec: freshness-policy / Invalid policy
test('freshness policies must use ISO 8601 durations', async t => {
  for (const [policy, pattern] of [[{ default: '1 day' }, /default "1 day"/], [{ types: { Metric: 'P' } }, /Metric: "P"/],
    [{ default: 'P1D', cadence: 'daily' }, /unknown keys cadence/], [{ types: ['P1D'] }, /types must map/]]) {
    const { cli } = await fixture(t, policy, {});
    const result = await cli('validate');
    assert.equal(result.error?.code, 'INVALID_MANIFEST', JSON.stringify(policy));
    assert.match(result.error.message, pattern);
  }
  const { cli } = await fixture(t, { default: 'P1Y', types: { Metric: 'P1D', Runbook: 'PT12H', Preferences: 'P6M' } }, {});
  assert.equal((await cli('validate')).code, 0);
});

// spec: freshness-policy / Read, verify and refresh
test('freshness decides read, verify or refresh from the policy and OKF fields', async t => {
  const { cli } = await fixture(t, { default: 'P1Y', types: { Metric: 'P1D' } }, {
    'old-metric': `type: Metric\nverified: { by: human:example, at: ${iso(now - 2 * day)} }`,
    'recent-guide': `type: Guide\ngenerated: { by: human:example, at: ${iso(now - 30 * day)} }`,
    expired: `type: Guide\nstale_after: ${iso(now - day)}`,
    'bare-metric': 'type: Metric',
  });
  const documents = Object.fromEntries((await cli('context', 'personal/main')).json.documents.map(item => [item.path, item.freshness]));
  assert.equal(documents['old-metric.md'].action, 'verify');
  assert.equal(documents['old-metric.md'].reason, 'last verified more than P1D ago');
  assert.ok(Math.abs(Date.parse(documents['old-metric.md'].due) - (now - day)) < 60000, documents['old-metric.md'].due);
  assert.equal(documents['recent-guide.md'].action, 'read');
  assert.equal(documents['recent-guide.md'].reason, 'generated within P1Y');
  assert.deepEqual(documents['expired.md'], { action: 'refresh', reason: 'stale_after has passed', due: iso(now - day) });
  assert.deepEqual(documents['bare-metric.md'], { action: 'verify', reason: 'no verification or generation time under a P1D rule' });

  const noDefault = await fixture(t, { types: { Metric: 'P1D' } }, { note: 'type: Thought' });
  const [, thought] = (await noDefault.cli('context', 'personal/main')).json.documents;
  assert.deepEqual(thought.freshness, { action: 'read', reason: 'no freshness rule applies' });
});

// spec: freshness-policy / Same decision on every path
test('browse, read, context and search report the same freshness', async t => {
  const { cli } = await fixture(t, { types: { Metric: 'P1D' } }, {
    revenue: `type: Metric\ngenerated: { by: process:nightly, at: ${iso(now - 3 * day)} }`,
  });
  const fromContext = (await cli('context', 'personal/main')).json.documents.find(item => item.path === 'revenue.md').freshness;
  const fromBrowse = (await cli('browse', 'personal/main')).json.concepts.find(item => item.id === 'revenue').freshness;
  const fromRead = (await cli('read', 'personal/main', 'revenue')).json.freshness;
  const fromSearch = (await cli('search', 'zebra revenue')).json.results[0].freshness;
  assert.equal(fromContext.action, 'verify');
  assert.equal(fromContext.reason, 'last generated more than P1D ago');
  for (const other of [fromBrowse, fromRead, fromSearch]) assert.deepEqual(other, fromContext);
});
