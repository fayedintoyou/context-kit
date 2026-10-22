import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDiagram } from '../../lib/behavior/maps.mjs';

const fixtures = fileURLToPath(new URL('../e2e/fixtures/maps/', import.meta.url));

// A stand-in for the OpenSpec adapter (an external boundary) that runs `during` when the checker
// lists capabilities, between reading the map and writing its diagram.
function specSource(root, during) {
  const requirement = (name, scenario) => ({ name, text: `The app SHALL ${name}.`, scenarios: [{ name: scenario, rawText: '- **WHEN** x\n- **THEN** y' }] });
  return async () => ({
    root,
    async list() { await during(); return [{ id: 'alerts', requirementCount: 2 }]; },
    async read() {
      return { path: 'openspec/specs/alerts/spec.md', requirements: [requirement('Room post without a mention', 'Quiet dot for a room post'),
        requirement('Mention badge', 'Badge counts mentions'), requirement('Badge clears', 'Badge clears when read')] };
    },
  });
}

// because: maps/ must be swapped for a symlink after the map is read and before its diagram is
// written, a window a CLI subprocess cannot hit reliably.
test('a maps/ directory swapped for a symlink mid-write is refused and nothing outside is written', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-maps-race-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  await cp(join(fixtures, 'pigeon'), root, { recursive: true });
  const map = join(root, 'maps/alerts.md');
  await writeFile(map, (await readFile(map, 'utf8')).replace('label: The room shows a number badge', 'label: A number badge appears'));
  const outside = join(base, 'outside');
  await cp(join(root, 'maps'), outside, { recursive: true });
  const before = await readFile(join(outside, 'alerts.md'), 'utf8');

  const swap = async () => {
    await rename(join(root, 'maps'), join(base, 'checked-maps'));
    await symlink(outside, join(root, 'maps'));
  };
  await assert.rejects(writeDiagram(root, 'alerts', specSource(root, swap)), { code: 'PATH_ESCAPE' });
  assert.equal(await readFile(join(outside, 'alerts.md'), 'utf8'), before);
  assert.deepEqual(await readdir(outside), ['alerts.md']);
  assert.equal(await readFile(join(base, 'checked-maps/alerts.md'), 'utf8'), before);

  // Without the swap the same write goes through, so the refusal above is the swap's doing.
  await rm(join(root, 'maps'));
  await rename(join(base, 'checked-maps'), join(root, 'maps'));
  assert.equal((await writeDiagram(root, 'alerts', specSource(root, async () => {}))).written, true);
  assert.match(await readFile(map, 'utf8'), /n_badge\("A number badge appears"\)/);
});
