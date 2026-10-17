import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHubs, context } from '../lib/hubs.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hubs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'hubs', 'one');
  await mkdir(directory, { recursive: true });
  const manifest = {
    version: 1, id: 'personal/one', description: 'Example',
    documents: ['README.md'], skills: [], links: [],
  };
  await writeFile(join(directory, 'README.md'), 'Useful context');
  const save = () => writeFile(join(directory, 'hub.json'), JSON.stringify(manifest));
  await save();
  return { root, directory, manifest, save };
}

test('context returns selected documents and rejects an unknown hub', async t => {
  const { root } = await fixture(t);
  const hubs = await loadHubs(root);
  const result = await context(hubs, 'personal/one');
  assert.equal(result.documents[0].content, 'Useful context');
  await assert.rejects(context(hubs, 'missing'), /Unknown hub/);
});

test('validation rejects missing documents and unresolved hub links', async t => {
  const { root, manifest, save } = await fixture(t);
  manifest.documents = ['missing.md'];
  await save();
  await assert.rejects(loadHubs(root), /ENOENT/);
  manifest.documents = ['README.md'];
  manifest.links = ['personal/missing'];
  await save();
  await assert.rejects(loadHubs(root), /Unknown linked hub/);
});

test('documents cannot escape the hub through traversal or a symlink', async t => {
  const { root, directory, manifest, save } = await fixture(t);
  await writeFile(join(root, 'outside.md'), 'Unrelated data');
  manifest.documents = ['../../outside.md'];
  await save();
  await assert.rejects(loadHubs(root), /escapes its root/);
  await symlink(join(root, 'outside.md'), join(directory, 'linked.md'));
  manifest.documents = ['linked.md'];
  await save();
  await assert.rejects(loadHubs(root), /escapes its root/);
});

test('duplicate hub identities are rejected', async t => {
  const { root, manifest } = await fixture(t);
  const second = join(root, 'hubs', 'two');
  await mkdir(second);
  await writeFile(join(second, 'hub.json'), JSON.stringify(manifest));
  await writeFile(join(second, 'README.md'), 'Another context');
  await assert.rejects(loadHubs(root), /Duplicate hub ID/);
});
