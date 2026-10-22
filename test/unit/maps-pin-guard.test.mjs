import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pinRewriteProblem } from '../../lib/behavior/maps.mjs';

const original = await readFile(new URL('../e2e/fixtures/maps/pigeon/maps/alerts.md', import.meta.url), 'utf8');
const content = original.indexOf('```yaml map\n') + '```yaml map\n'.length;
const pinsText = original.match(/pins:\n(?: {2}.*\n)*/)[0];
const at = original.indexOf(pinsText) - content;
const region = [at, at + pinsText.length];
const expected = [...pinsText.matchAll(/^ {2}(.+): ([0-9a-f]{12})$/gm)].map(match => [match[1], match[2]]);

// because: pinMap only produces safe edits, so its guard can't be made to fire through the CLI;
// these feed it the bad rewrites it exists to stop, through the same parser maps check uses.
test('the pin guard refuses a rewrite that breaks the map or changes anything but its pins', () => {
  assert.equal(pinRewriteProblem('alerts', original, original, region, expected), null);
  // The round-2 bug: the pins value and its final newline replaced, joining it to the closing fence.
  const joined = original.replace(pinsText, 'pins:\n  {}');
  assert.match(pinRewriteProblem('alerts', original, joined, region, []), /would not parse/);
  const outside = original.replace('scope: [alerts]', 'scope: [alerts, other]');
  assert.match(pinRewriteProblem('alerts', original, outside, region, expected), /outside the pins/);
  // Within an allowed span, yet changing a key other than pins.
  const whole = [0, original.indexOf('```\n\n<!--') - content];
  const relabelled = original.replace('label: The room shows a number badge', 'label: A number badge appears');
  assert.match(pinRewriteProblem('alerts', original, relabelled, whole, expected), /changed the map, not only its pins/);
  const wrong = original.replace(expected[0][1], 'abcdefabcdef');
  assert.match(pinRewriteProblem('alerts', original, wrong, region, expected), /not the current fingerprints/);
});
