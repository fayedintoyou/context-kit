#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specLinks } from '../lib/specs/links.mjs';
export { specLinks } from '../lib/specs/links.mjs';

// `node scripts/spec-links.mjs [root]`: this repository by default.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
  const result = await specLinks(root);
  for (const { key, tests, pending, behind } of result.coverage) {
    const waits = tests.length ? ''
      : pending ? `pending: ${pending.map(({ change, slices }) => `${change} slice ${slices.join(', ')} not started`).join('; ')}`
      : behind ? `no landing record: ${behind.map(({ change, slices, base }) => `${change} slice ${slices.join(', ')} landed on ${base}; if the branch is behind, update it`).join('; ')}` : '';
    process.stdout.write(`${tests.length ? '✔' : pending ? '○' : '✖'} ${key}  ${waits || tests.map(test => `[${test.kind}] ${test.file}:${test.line}`).join(', ')}\n`);
  }
  for (const note of result.notes) process.stderr.write(`• ${note}\n`);
  for (const problem of result.problems) process.stderr.write(`✖ ${problem}\n`);
  process.exitCode = result.problems.length ? 1 : 0;
}
