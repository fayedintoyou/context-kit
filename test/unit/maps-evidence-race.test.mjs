import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeStatuses, resolveEvidence } from '../../lib/behavior/status.mjs';

// A repository whose models/ holds Alerts.tla, and a directory outside it that holds Alerts.tla
// and Secret.tla (filled) or nothing (empty).
async function repository(t, filled) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-evidence-race-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  await mkdir(join(root, 'models'), { recursive: true });
  await writeFile(join(root, 'models/Alerts.tla'), 'in the repository\n');
  await mkdir(join(base, 'outside'));
  if (filled) for (const name of ['Alerts.tla', 'Secret.tla']) await writeFile(join(base, 'outside', name), 'outside\n');
  const swap = async () => {
    await rename(join(root, 'models'), join(base, 'checked-models'));
    await symlink(join(base, 'outside'), join(root, 'models'));
  };
  return { root, swap };
}

// The real file system, swapping models/ for a symlink right after its call number `after` (none
// when after is -1). calls counts the calls made.
function swapping(after, swap) {
  const state = { calls: 0 };
  const wrap = call => async path => {
    try { return await call(path); }
    finally { if (state.calls++ === after) await swap(); }
  };
  return Object.assign(state, { lstat: wrap(lstat), realpath: wrap(realpath) });
}

const data = item => ({ source: { kind: 'lid' }, nodes: [{ id: 'proof', kind: 'state', label: 'A proof', status: { state: 'works', evidence: [item] } }] });

// because: models/ must be swapped for a symlink between two lookups of one evidence path, at
// every point in between, which a CLI subprocess cannot hit reliably; the file system is the faked boundary.
test('an evidence directory swapped for a symlink at any point gives one result, whatever exists outside', async t => {
  for (const item of ['models/Secret.tla', 'models/Alerts.tla', 'models/Secret.tla/inner']) {
    const unswapped = swapping(-1, async () => {});
    await resolveEvidence((await repository(t, true)).root, item, unswapped);
    for (let after = 0; after < unswapped.calls; after++) {
      const results = [];
      for (const filled of [true, false]) {
        const { root, swap } = await repository(t, filled);
        const result = await resolveEvidence(root, item, swapping(after, swap));
        const again = await repository(t, filled);
        const report = await nodeStatuses(again.root, data(item), new Map(), new Map(), async () => new Map(), swapping(after, again.swap));
        results.push([result, report.errors]);
      }
      assert.deepEqual(results[0], results[1], `${item}, swapped after call ${after}`);
      // A swap after the last call comes once the check is over; before it, nothing is accepted.
      if (after < unswapped.calls - 1) assert.ok(results[0][0].problem, `${item} is never accepted once swapped (after call ${after})`);
    }
  }
  // The same message for a symlink found on the path and for a swap caught later.
  const { root, swap } = await repository(t, true);
  const caught = (await resolveEvidence(root, 'models/Alerts.tla', swapping(0, swap))).problem;
  assert.match(caught, /not a plain path in the repository/);
  assert.equal((await resolveEvidence(root, 'models/Alerts.tla')).problem, caught);

  // Without a swap, evidence in the repository resolves and evidence only outside does not exist.
  const plain = await repository(t, true);
  assert.deepEqual(await resolveEvidence(plain.root, 'models/Alerts.tla'), { kind: 'path', value: 'models/Alerts.tla' });
  assert.match((await resolveEvidence(plain.root, 'models/Secret.tla')).problem, /does not exist/);
});
