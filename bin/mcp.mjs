#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { selectRoot } from '../lib/workspace.mjs';
import { parseArgs } from '../lib/arguments.mjs';
import { errorData, fail } from '../lib/files.mjs';
import { serverFactory } from '../lib/mcp/server.mjs';
import { httpOptions, serveHttp } from '../lib/mcp/http.mjs';

const usage = 'Usage: node bin/mcp.mjs [--root <directory>] [--allow-write] [--no-skill-prompts] ' +
  '[--http <port> [--host <address>] [--public-host <host>]... [--allow-origin <origin>]... [--max-sessions <n>] [--session-idle <seconds>]]';
try {
  const { options, positional } = parseArgs(process.argv.slice(2), ['--root', '--allow-write', '--no-skill-prompts',
    '--http', '--host', '--public-host', '--allow-origin', '--max-sessions', '--session-idle'], ['--public-host', '--allow-origin']);
  if (positional.length) fail('INVALID_INPUT', usage);
  // HTTP settings, including the token, are validated before the workspace is touched or anything listens.
  const http = options['--http'] === undefined ? undefined : httpOptions(options, process.env);
  if (!http && ['--host', '--public-host', '--allow-origin', '--max-sessions', '--session-idle'].some(name => name in options)) fail('INVALID_INPUT', 'HTTP options require --http. ' + usage);
  const selection = { ...await selectRoot(options['--root'] || process.env.CONTEXT_KIT_ROOT),
    allowWrite: Boolean(options['--allow-write']), source: 'mcp', transport: http ? 'http' : 'stdio' };
  const create = await serverFactory(selection, { skillPrompts: !options['--no-skill-prompts'] });
  if (http) await serveHttp(create, http);
  else await create().connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(JSON.stringify({ error: errorData(error) }) + '\n');
  process.exitCode = 1;
}
