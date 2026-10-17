#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { operations, execute } from '../lib/operations.mjs';
import { selectRoot } from '../lib/workspace.mjs';
import { parseArgs } from '../lib/arguments.mjs';
import { errorData, fail } from '../lib/files.mjs';

try {
  const { options, positional } = parseArgs(process.argv.slice(2), ['--root', '--allow-write']);
  if (positional.length) fail('INVALID_INPUT', 'Usage: node bin/mcp.mjs [--root <directory>] [--allow-write]');
  const selection = { ...await selectRoot(options['--root'] || process.env.CONTEXT_KIT_ROOT),
    allowWrite: Boolean(options['--allow-write']), source: 'mcp' };
  const server = new McpServer({ name: 'context-kit', version: '0.2.0' });
  for (const [name, definition] of operations(selection.allowWrite)) {
    server.registerTool(name, { description: definition.description, inputSchema: definition.schema,
      annotations: { readOnlyHint: !definition.write, destructiveHint: false, openWorldHint: false, idempotentHint: !definition.write } },
    async args => {
      try {
        const result = await execute(selection, name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: errorData(error) }) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(JSON.stringify({ error: errorData(error) }) + '\n');
  process.exitCode = 1;
}
