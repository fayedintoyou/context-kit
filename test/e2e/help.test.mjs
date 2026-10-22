import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, realpath, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const references = join(kit, 'skills/context-kit/references');

async function workspace(t, ...initArgs) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-help-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  delete env.CONTEXT_KIT_ROOT;
  const root = join(base, 'workspace');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', root, ...initArgs], { env });
  const cli = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, error: JSON.parse(error.stderr).error }; }
  };
  return { base, env, root, cli };
}

// spec: help / Read help
test('help lists and shows topics over CLI and MCP, even with broken addon config', async t => {
  const { env, root, cli } = await workspace(t);
  const listed = await cli('help');
  assert.deepEqual(listed.json.topics.map(topic => topic.topic), ['addons-and-install', 'capturing', 'commands', 'getting-started',
    'knowledge', 'maps', 'mounts', 'navigating', 'remote', 'repositories', 'skills', 'specs', 'troubleshooting']);
  assert.ok(listed.json.topics.every(topic => topic.title && topic.summary));
  const shown = await cli('help', 'getting-started');
  assert.equal(shown.json.content, await readFile(join(references, 'getting-started.md'), 'utf8'));
  const unknown = await cli('help', 'teleport');
  assert.equal(unknown.error.code, 'UNKNOWN_TOPIC');
  assert.match(unknown.error.message, /topics: addons-and-install/);

  await writeFile(join(root, 'context-kit.json'), '{"version": 1, "addons": ["teleport"]}');
  assert.equal((await cli('help', 'troubleshooting')).code, 0);
  assert.equal((await cli('list')).error.code, 'INVALID_CONFIG');
  await writeFile(join(root, 'context-kit.json'), '{"version": 1, "addons": []}');

  const client = new Client({ name: 'help-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
  t.after(() => client.close());
  assert.deepEqual((await client.callTool({ name: 'help', arguments: {} })).structuredContent, (await cli('help')).json);
  assert.deepEqual((await client.callTool({ name: 'help', arguments: { topic: 'commands' } })).structuredContent, (await cli('help', 'commands')).json);
});

// spec: help / Help ships with core
test('the core help skill ships with every workspace and install', async t => {
  const { base, root, cli } = await workspace(t, '--addons', 'none');
  const manifest = JSON.parse(await readFile(join(root, 'hubs/personal/hub.json'), 'utf8'));
  assert.deepEqual(manifest.skills, ['kit:context-kit']);
  const skill = await cli('read-skill', 'personal/main', 'kit:context-kit');
  const files = (await readdir(references)).map(name => name.slice(0, -3)).sort();
  const table = [...skill.json.content.matchAll(/^\| `([a-z-]+)` \|/gm)].map(match => match[1]).sort();
  assert.deepEqual(table, files);

  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const env = { HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'), PATH: `${bin}:/usr/bin:/bin` };
  await mkdir(env.HOME);
  const installed = JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, 'agents', 'install', '--agent', 'claude'], { env })).stdout);
  assert.deepEqual(installed.results.filter(item => item.kind === 'skill').map(item => item.name), ['context-kit']);
  assert.deepEqual((await readdir(join(base, 'claude/skills/context-kit/references'))).sort(), files.map(name => `${name}.md`));
});

// spec: help / Help covers the tool
test('help mentions every CLI command, MCP tool and error code', async () => {
  const help = (await Promise.all((await readdir(references)).map(name => readFile(join(references, name), 'utf8')))).join('\n');
  const usage = (await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--help'])).stdout;
  const commands = new Set();
  for (const line of usage.split('\n').slice(1)) {
    for (const part of line.trim().split('|')) {
      const words = part.trim().split(/\s+/).filter(word => /^[a-z][a-z-]*$/.test(word));
      if (!words.length || line.startsWith('Root')) continue;
      commands.add(['agents', 'specs', 'maps'].includes(words[0]) ? `${words[0]} ${words[1] ?? ''}`.trim() : words[0]);
    }
  }
  assert.ok(commands.size >= 20 && commands.has('agents install') && commands.has('specs audit') && commands.has('maps render') && commands.has('help'), [...commands].join(', '));
  for (const command of commands) assert.ok(help.includes(`\`${command}`), `help is missing the ${command} command`);

  const { operations } = await import('../../lib/operations.mjs');
  const tools = operations(true, new Set(['core', 'specs', 'maps']));
  assert.ok(tools.some(([name]) => name === 'render_map'));
  for (const [name] of tools) assert.ok(help.includes(`\`${name}\``), `help is missing the ${name} tool`);

  const codes = new Set();
  for (const directory of ['lib', 'lib/specs', 'lib/behavior', 'bin']) {
    for (const file of (await readdir(join(kit, directory))).filter(name => name.endsWith('.mjs'))) {
      for (const match of (await readFile(join(kit, directory, file), 'utf8')).matchAll(/fail\('([A-Z_]+)'/g)) codes.add(match[1]);
    }
  }
  assert.ok(codes.size > 20);
  for (const code of codes) assert.ok(help.includes(`\`${code}\``), `help is missing the ${code} error code`);
});
