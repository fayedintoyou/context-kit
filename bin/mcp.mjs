#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { splitFrontmatter } from '../lib/okf.mjs';
import { z } from 'zod';
import { operations, execute } from '../lib/operations.mjs';
import { selectRoot } from '../lib/workspace.mjs';
import { parseArgs } from '../lib/arguments.mjs';
import { errorData, fail } from '../lib/files.mjs';

// OKF actor (§7) for the connected client, from its declared name and version.
function clientActor(info) {
  const clean = value => String(value ?? '').replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  const name = clean(info?.name), version = clean(info?.version);
  return `${name || 'unknown-client'}/${version || 'unknown'}`;
}
try {
  const { options, positional } = parseArgs(process.argv.slice(2), ['--root', '--allow-write']);
  if (positional.length) fail('INVALID_INPUT', 'Usage: node bin/mcp.mjs [--root <directory>] [--allow-write]');
  const selection = { ...await selectRoot(options['--root'] || process.env.CONTEXT_KIT_ROOT),
    allowWrite: Boolean(options['--allow-write']), source: 'mcp' };
  // Low-level Server so arguments reach execute(): CLI and MCP share one validation path and coded errors.
  const server = new Server({ name: 'context-kit', version: '0.2.0' }, { capabilities: { tools: {}, prompts: {} } });
  const tools = operations(selection.allowWrite).map(([name, definition]) => ({ name, description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema, { io: 'input', target: 'draft-7' }),
    annotations: { readOnlyHint: !definition.write, destructiveHint: false, openWorldHint: false, idempotentHint: !definition.write } }));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = await execute({ ...selection, actor: clientActor(server.getClientVersion()) }, params.name, params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: errorData(error) }) }] };
    }
  });
  // Each declared skill is also a prompt, so clients can invoke it directly (for example
  // as a slash command) without installing skills into the client.
  async function prompts() {
    const { skills } = await execute(selection, 'list_skills');
    const used = new Set();
    return skills.map(skill => {
      let name = skill.name;
      for (let n = 2; used.has(name); n++) name = `${skill.name}-${n}`;
      used.add(name);
      return { name, skill };
    });
  }
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: (await prompts()).map(({ name, skill }) => ({ name, description: skill.description })) }));
  server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
    const entry = (await prompts()).find(item => item.name === params.name);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${params.name}`);
    const { skill } = entry;
    const { content } = await execute(selection, 'read_skill', { id: skill.hubs[0], reference: skill.reference });
    const body = (splitFrontmatter(content)?.body ?? content).trim();
    const how = `Read this skill's other files with the Context Kit read_skill tool: ` +
      `{"id": "${skill.hubs[0]}", "reference": "${skill.reference}", "file": "<path relative to the skill directory>"}.`;
    return { description: skill.description, messages: [{ role: 'user', content: { type: 'text', text: `${body}\n\n---\n${how}` } }] };
  });
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(JSON.stringify({ error: errorData(error) }) + '\n');
  process.exitCode = 1;
}
