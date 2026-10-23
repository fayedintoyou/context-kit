import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEvidence } from '../../lib/behavior/status.mjs';

// A repository whose models/ holds Alerts.tla, and a directory outside it holding Secret.tla.
async function repository(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-evidence-race-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  await mkdir(join(root, 'models'), { recursive: true });
  await writeFile(join(root, 'models/Alerts.tla'), 'in the repository\n');
  await mkdir(join(base, 'outside'));
  await writeFile(join(base, 'outside/Alerts.tla'), 'outside\n');
  await writeFile(join(base, 'outside/Secret.tla'), 'outside only\n');
  const swap = async () => {
    await rename(join(root, 'models'), join(base, 'checked-models'));
    await symlink(join(base, 'outside'), join(root, 'models'));
  };
  return { root, swap };
}

// The real file system, with swap run once right after the call that matches when.
function swapping(when, swap) {
  let done = false;
  const after = call => async path => {
    const result = await call(path);
    if (!done && when(call, path)) { done = true; await swap(); }
    return result;
  };
  return { lstat: after(lstat), realpath: after(realpath) };
}

// because: models/ must be swapped for a symlink between two lookups of one evidence path, a window
// a CLI subprocess cannot hit reliably; the file system is the faked boundary.
test('an evidence directory swapped for a symlink while it is checked fails closed', async t => {
  const changed = /changed while it was checked/;
  // Swapped right after models/ was checked: the file is then found only outside.
  let { root, swap } = await repository(t);
  let result = await resolveEvidence(root, 'models/Secret.tla', swapping((call, path) => call === lstat && path.endsWith('/models'), swap));
  assert.match(result.problem, changed);
  // Swapped after the real-path check, before each component is compared with what was first seen.
  ({ root, swap } = await repository(t));
  result = await resolveEvidence(root, 'models/Alerts.tla', swapping((call, path) => call === realpath && path.endsWith('/Alerts.tla'), swap));
  assert.match(result.problem, changed);
  // The same message whether or not the swapped-in directory holds the file.
  ({ root, swap } = await repository(t));
  result = await resolveEvidence(root, 'models/Alerts.tla', swapping((call, path) => call === lstat && path.endsWith('/models'), swap));
  assert.match(result.problem, changed);

  // Without a swap, evidence in the repository resolves and evidence only outside does not exist.
  ({ root } = await repository(t));
  assert.deepEqual(await resolveEvidence(root, 'models/Alerts.tla'), { kind: 'path', value: 'models/Alerts.tla' });
  assert.match((await resolveEvidence(root, 'models/Secret.tla')).problem, /does not exist/);
});
