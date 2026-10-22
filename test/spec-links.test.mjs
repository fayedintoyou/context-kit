import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { specLinks } from '../scripts/spec-links.mjs';

test('every spec scenario is linked to a test and every link resolves', async () => {
  const { problems, notes } = await specLinks(fileURLToPath(new URL('../', import.meta.url)));
  assert.deepEqual(problems, [], '\n' + [...notes, ...problems].join('\n') + '\nRun `npm run spec-links` for the full map.');
});
