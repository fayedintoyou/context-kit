#!/usr/bin/env node
import { initWorkspace, selectRoot } from '../lib/workspace.mjs';
import { execute } from '../lib/operations.mjs';
import { parseArgs } from '../lib/arguments.mjs';
import { fail, errorData } from '../lib/files.mjs';

const help = `Usage: node bin/hub.mjs [--root <directory>] <command>
  init <new-directory> [--kit <npm-spec>]
  list | validate
  context <hub-id> [--inbox]
  search <text> [--inbox]
  read-skill <hub-id> <reference>
  capture <hub-id> <title>      (UTF-8 body on stdin)
  specs stores | specs list | specs read <spec-id> | specs audit   [--store <id>]
Root precedence: --root, CONTEXT_KIT_ROOT, toolkit checkout (read-only).`;
try {
  const { options, positional } = parseArgs(process.argv.slice(2), ['--root', '--inbox', '--store', '--kit', '--help']);
  if (options['--help']) { process.stdout.write(help + '\n'); }
  else {
    const [command, ...args] = positional;
    let result;
    if (command === 'init' && args.length === 1) {
      if (options['--root'] || options['--inbox'] || options['--store']) fail('INVALID_INPUT', 'init takes its destination as an argument');
      result = await initWorkspace(args[0], { kit: options['--kit'] });
    } else {
      if (options['--kit']) fail('INVALID_INPUT', '--kit applies only to init');
      const selection = { ...await selectRoot(options['--root'] || process.env.CONTEXT_KIT_ROOT), source: 'cli', allowWrite: true };
      const count = { list: 0, validate: 0, context: 1, search: 1, 'read-skill': 2, capture: 2 };
      if (options['--inbox'] && !['context', 'search'].includes(command)) fail('INVALID_INPUT', '--inbox applies only to context/search');
      if (options['--store'] && (command !== 'specs' || args[0] === 'stores')) fail('INVALID_INPUT', '--store applies only to specs list/read/audit');
      const store = options['--store'] ? { store: options['--store'] } : {};
      if (command === 'specs') {
        if (args[0] === 'stores' && args.length === 1) result = await execute(selection, 'list_spec_stores');
        else if (args[0] === 'list' && args.length === 1) result = await execute(selection, 'list_specs', store);
        else if (args[0] === 'audit' && args.length === 1) result = await execute(selection, 'audit_specs', store);
        else if (args[0] === 'read' && args.length === 2) result = await execute(selection, 'read_spec', { id: args[1], ...store });
        else fail('INVALID_INPUT', help);
      } else {
        if (!Object.hasOwn(count, command) || args.length !== count[command]) fail('INVALID_INPUT', help);
        const includeInbox = Boolean(options['--inbox']);
        if (command === 'list') result = await execute(selection, 'list_hubs');
        if (command === 'validate') result = await execute(selection, 'validate_hubs');
        if (command === 'context') result = await execute(selection, 'get_context', { id: args[0], includeInbox });
        if (command === 'search') result = await execute(selection, 'search_context', { query: args[0], includeInbox });
        if (command === 'read-skill') result = await execute(selection, 'read_skill', { id: args[0], reference: args[1] });
        if (command === 'capture') {
          if (process.stdin.isTTY) fail('INVALID_INPUT', 'Pipe a UTF-8 note body into capture');
          const chunks = []; let bytes = 0;
          for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > 65536) fail('TOO_LARGE', 'Capture body exceeds 64 KiB');
            chunks.push(chunk);
          }
          let body;
          try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
          catch { fail('INVALID_UTF8', 'Capture body must be UTF-8'); }
          result = await execute(selection, 'capture_note', { id: args[0], title: args[1], body });
        }
      }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.valid === false || ['structurally_invalid', 'no_canonical_specs'].includes(result.status)) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: errorData(error) }) + '\n');
  process.exitCode = 1;
}
