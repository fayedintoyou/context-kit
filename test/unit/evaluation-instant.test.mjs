import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationInstant } from '../../lib/behavior/hub.mjs';

// spec: behavior-sources / Reproducible freshness
// because: every calendar day of several years (leap, non-leap and century years) is an input space too large to drive through a subprocess.
test('every real calendar day is accepted at its own instant and every impossible one refused', () => {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  let accepted = 0;
  for (const year of [1, 4, 100, 400, 1900, 2000, 2024, 2026, 2028, 2100, 9999]) {
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        const at = `${pad(year, 4)}-${pad(month)}-${pad(day)}T09:30:15Z`;
        // The reference: the same fields through Date.UTC, kept only if they round-trip unchanged.
        const reference = new Date(Date.UTC(2000, 0, 1, 9, 30, 15));
        reference.setUTCFullYear(year, month - 1, day);
        const real = reference.getUTCFullYear() === year && reference.getUTCMonth() === month - 1 && reference.getUTCDate() === day;
        if (real) { assert.equal(evaluationInstant(at), reference.getTime(), at); accepted += 1; }
        else assert.throws(() => evaluationInstant(at), { code: 'INVALID_INPUT' }, at);
      }
    }
  }
  // 365 days in 1, 100, 1900, 2026, 2100 and 9999; 366 in 4, 400, 2000, 2024 and 2028.
  assert.equal(accepted, 6 * 365 + 5 * 366);
});
