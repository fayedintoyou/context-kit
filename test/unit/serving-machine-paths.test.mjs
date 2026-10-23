import test from 'node:test';
import assert from 'node:assert/strict';
import { labelServingMachinePaths } from '../../lib/mcp/paths.mjs';

// because: every operation's declarations are collision-free, so the guard can't be made to fire
// through the HTTP server; these feed it the declarations and results it exists to refuse.
test('labeling refuses to overwrite machine or an existing servingMachine key, never overriding silently', () => {
  assert.throws(() => labelServingMachinePaths({ machine: 'x', root: '/w' }, ['root'], 'studio'), { code: 'INTERNAL', message: /machine is already/ });
  assert.throws(() => labelServingMachinePaths({ root: '/w', servingMachineRoot: '/other' }, ['root'], 'studio'), { code: 'INTERNAL', message: /servingMachineRoot is already/ });
  assert.throws(() => labelServingMachinePaths({ items: [{ path: '/a', servingMachinePath: '/b' }] }, ['items.*.path'], 'studio'), { code: 'INTERNAL' });
  // Text quoting a known path names it by label only where the path ends, longest first.
  const labeled = labelServingMachinePaths({ root: '/w', note: 'see /w/x and /w2, then /w.' }, ['root', { field: 'note', text: true }], 'studio', [{ value: '/w/x', label: 'servingMachineCheckout' }]);
  assert.deepEqual(labeled, { machine: 'studio', servingMachineRoot: '/w', note: 'see <servingMachineCheckout> and /w2, then <servingMachineRoot>.' });
});
