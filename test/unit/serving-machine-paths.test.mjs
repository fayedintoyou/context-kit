import test from 'node:test';
import assert from 'node:assert/strict';
import { labelServingMachinePaths } from '../../lib/mcp/paths.mjs';

// because: every operation's declarations are collision-free, so the guard can't be made to fire
// through the HTTP server; these feed it the declarations and results it exists to refuse.
test('labeling refuses to overwrite machine or an existing servingMachine key, never overriding silently', () => {
  assert.throws(() => labelServingMachinePaths({ machine: 'x', root: '/w' }, ['root'], 'studio'), { code: 'INTERNAL', message: /machine is already/ });
  assert.throws(() => labelServingMachinePaths({ root: '/w', servingMachineRoot: '/other' }, ['root'], 'studio'), { code: 'INTERNAL', message: /servingMachineRoot is already/ });
  assert.throws(() => labelServingMachinePaths({ items: [{ path: '/a', servingMachinePath: '/b' }] }, ['items.*.path'], 'studio'), { code: 'INTERNAL' });
});

const quoted = (note, known) => labelServingMachinePaths({ note }, [{ field: 'note', text: true }], 'studio', known).note;
// because: the boundaries are about known paths that are prefixes, suffixes or parts of other
// text (/w inside /x/w, /root inside a URL, / or // as a home), which a real workspace's results
// can't be arranged to quote; the e2e sweep covers the remedies and reasons operations produce.
test('free text names a known path by its label only where the whole path stands', () => {
  const w = [{ value: '/w', label: 'servingMachineRoot' }];
  assert.equal(quoted('see /w and /x/w and https://h/w/x, (/w) =/w :/w [/w] {/w} </w> /w! /w? /w/sub /w.md /w. end', w),
    'see <servingMachineRoot> and /x/w and https://h/w/x, (<servingMachineRoot>) =<servingMachineRoot> :<servingMachineRoot> [<servingMachineRoot>] ' +
    '{<servingMachineRoot>} <<servingMachineRoot>> <servingMachineRoot>! <servingMachineRoot>? <servingMachineRoot>/sub /w.md <servingMachineRoot>. end');
  assert.equal(quoted('https://git.example/root/x and /root/y', [{ value: '/root', label: 'servingMachineHome' }]), 'https://git.example/root/x and <servingMachineHome>/y');
  assert.equal(quoted('/private/tmp/w and /tmp/w', [{ value: '/tmp/w', label: 'servingMachineCheckout' }]), '/private/tmp/w and <servingMachineCheckout>');
  // A home of /, // or /// is no known path at all.
  assert.equal(quoted('x // y /a', [{ value: '/', label: 'h' }, { value: '//', label: 'h' }, { value: '///', label: 'h' }]), 'x // y /a');
  // Case matters on the path; a checkout inside a known directory is named as the checkout.
  assert.equal(quoted('/W/x and /w/x', [{ value: '/w', label: 'servingMachineHome' }, { value: '/w/x', label: 'servingMachineCheckout' }]), '/W/x and <servingMachineCheckout>');
  // file: forms, as a known value and in the text.
  for (const value of ['file:/m/s', 'file:///m/s', 'file://localhost/m/s']) {
    assert.equal(quoted('at /m/s, file:///m/s, file://localhost/m/s, file:/m/s, file:///m/sx', [{ value, label: 'servingMachineSource' }]),
      'at <servingMachineSource>, <servingMachineSource>, <servingMachineSource>, <servingMachineSource>, file:///m/sx', value);
  }
});
