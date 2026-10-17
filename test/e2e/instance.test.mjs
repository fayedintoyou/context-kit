import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// spec: context-workspaces / Run the core from an instance
test('an initialized workspace runs the core from its own dependencies', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-instance-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    npm_config_cache: join(base, 'npm-cache'), npm_config_update_notifier: 'false' };
  delete env.CONTEXT_KIT_ROOT;
  const workspace = join(base, 'my-context');

  const init = JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', workspace, '--kit', `file:${kit}`], { env })).stdout);
  assert.deepEqual(init.core, { spec: `file:${kit}`, pinned: true });
  const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { 'context-kit': `file:${kit}` });
  assert.match(await readFile(join(workspace, '.gitignore'), 'utf8'), /^node_modules\/$/m);

  await exec('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: workspace, env });
  // Run from elsewhere to prove the scripts, not the caller's directory, select the workspace.
  const listed = JSON.parse((await exec('npm', ['run', '-s', '--prefix', workspace, 'hub', '--', 'list'], { cwd: base, env })).stdout);
  assert.equal(listed.root, workspace);
  assert.deepEqual(listed.hubs.map(hub => hub.id), ['personal/main']);
  const skill = JSON.parse((await exec('npm', ['run', '-s', 'hub', '--', 'read-skill', 'personal/main', 'kit:independent-review'], { cwd: workspace, env })).stdout);
  assert.match(skill.content, /^---\nname: independent-review/);

  const client = new Client({ name: 'instance-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'npm', args: ['run', '-s', 'mcp'], cwd: workspace, env, stderr: 'pipe' }));
  t.after(() => client.close());
  const result = await client.callTool({ name: 'list_hubs', arguments: {} });
  assert.equal(result.structuredContent.root, workspace);
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'capture_note'));
});

test('init pins the core repository, at a commit when the core is a clean checkout', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-instance-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const init = JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', join(base, 'w')])).stdout);
  assert.match(init.core.spec, init.core.pinned ? /^github:fayedintoyou\/context-kit#[0-9a-f]{40}$/ : /^github:fayedintoyou\/context-kit$/);
  const misuse = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--kit', 'x', 'list']).catch(error => error);
  assert.equal(JSON.parse(misuse.stderr).error.code, 'INVALID_INPUT');
});
