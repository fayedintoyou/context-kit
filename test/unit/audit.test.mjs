import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { auditSpecs } from '../../lib/specs/audit.mjs';

// spec: canonical-spec-audit / Referenced store changes during audit
// because: the change must land between the audit's two collections, which a subprocess cannot time reliably.
test('an audit fails when a referenced store changes mid-collection', async () => {
  const fake = (kind, versions) => {
    let reads = 0;
    const content = () => versions[Math.min(reads++, versions.length - 1)];
    return { name: 'fake', version: '0', root: tmpdir(), source: kind === 'store' ? { kind, storeId: 'platform' } : { kind },
      list: async () => [{ id: 'spec', requirementCount: 1 }],
      read: async id => ({ id, content: content(), requirements: [{ name: 'R', text: 'T', scenarios: [] }] }),
      validate: async () => ({ strict: true, valid: true, items: [] }) };
  };
  const repo = fake('repo', ['stable']);
  const store = fake('store', ['before', 'after']);
  await assert.rejects(auditSpecs(repo, [{ storeId: 'platform', source: store }]), { code: 'SNAPSHOT_CHANGED' });
});
