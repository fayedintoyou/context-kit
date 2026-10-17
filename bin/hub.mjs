#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadHubs, context } from '../lib/hubs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command, ...args] = process.argv.slice(2);
try {
  if (!['list', 'context', 'validate'].includes(command) ||
      args.length !== (command === 'context' ? 1 : 0)) {
    throw new Error('Usage: node bin/hub.mjs list | context <id> | validate');
  }
  const hubs = await loadHubs(root);
  let result;
  if (command === 'list') {
    result = hubs.map(({ manifest: { id, description } }) => ({ id, description }));
  } else if (command === 'context') {
    result = await context(hubs, args[0]);
  } else {
    result = { valid: true, hubs: hubs.length };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
