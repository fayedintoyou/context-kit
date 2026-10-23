// The MCP server shared by the stdio and HTTP transports, so both offer the same tools and prompts.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { splitFrontmatter } from '../okf.mjs';
import { operations, execute, localPathFields, quotedLocalPaths } from '../operations.mjs';
import { enabledOperations } from '../addons.mjs';
import { errorData } from '../files.mjs';
import { labelServingMachinePaths } from './paths.mjs';

// OKF actor (§7) for the connected client, from its declared name and version.
function clientActor(info) {
  const clean = value => String(value ?? '').replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  const name = clean(info?.name), version = clean(info?.version);
  return `${name || 'unknown-client'}/${version || 'unknown'}`;
}

// Returns a function that builds one configured Server for selection.transport ('stdio' or 'http';
// local-only tools are left out over HTTP, and execute() refuses them there too); each connected client (a stdio process,
// or an HTTP session) gets its own, so captures name the client that initialized it.
export async function serverFactory(selection, { skillPrompts = true } = {}) {
  const http = selection.transport === 'http';
  const tools = operations(selection.allowWrite, await enabledOperations(selection.root), selection.transport).map(([name, definition]) => ({ name,
    description: http && definition.httpDescription ? definition.httpDescription : definition.description,
    inputSchema: z.toJSONSchema(definition.schema, { io: 'input', target: 'draft-7' }),
    annotations: { readOnlyHint: !definition.write, destructiveHint: false, openWorldHint: false, idempotentHint: !definition.write } }));
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
  return () => {
    // Low-level Server so arguments reach execute(): CLI and MCP share one validation path and coded errors.
    const server = new Server({ name: 'context-kit', version: '0.2.0' }, { capabilities: { tools: {}, ...(skillPrompts ? { prompts: {} } : {}) } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const raw = await execute({ ...selection, actor: clientActor(server.getClientVersion()) }, params.name, params.arguments ?? {});
        // Over HTTP the client is elsewhere: this machine's paths are labeled as the serving machine's,
        // in both the structured result and its text.
        const result = http ? labelServingMachinePaths(raw, localPathFields(params.name), selection.machine, await quotedLocalPaths(selection, params.name)) : raw;
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: errorData(error) }) }] };
      }
    });
    // Skip prompts when the skills are installed into the agent natively.
    if (skillPrompts) server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: (await prompts()).map(({ name, skill }) => ({ name, description: skill.description })) }));
    if (skillPrompts) server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
      const entry = (await prompts()).find(item => item.name === params.name);
      if (!entry) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${params.name}`);
      const { skill } = entry;
      const { content } = await execute(selection, 'read_skill', { id: skill.hubs[0], reference: skill.reference });
      const body = (splitFrontmatter(content)?.body ?? content).trim();
      const how = `Read this skill's other files with the Context Kit read_skill tool: ` +
        `{"id": "${skill.hubs[0]}", "reference": "${skill.reference}", "file": "<path relative to the skill directory>"}.`;
      return { description: skill.description, messages: [{ role: 'user', content: { type: 'text', text: `${body}\n\n---\n${how}` } }] };
    });
    return server;
  };
}
