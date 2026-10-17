#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { specLinks } from '../lib/specs/links.mjs';
export { specLinks } from '../lib/specs/links.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await specLinks(fileURLToPath(new URL('../', import.meta.url)));
  for (const { key, tests } of result.coverage) {
    process.stdout.write(`${tests.length ? '✔' : '✖'} ${key}  ${tests.map(test => `[${test.kind}] ${test.file}:${test.line}`).join(', ')}\n`);
  }
  for (const problem of result.problems) process.stderr.write(`✖ ${problem}\n`);
  process.exitCode = result.problems.length ? 1 : 0;
}
