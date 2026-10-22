import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

async function fixture(t, addons) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-addons-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  delete env.CONTEXT_KIT_ROOT;
  const workspace = join(base, 'workspace');
  const run = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, error: JSON.parse(error.stderr).error, stdout: error.stdout }; }
  };
  const init = await run('init', workspace, ...(addons === undefined ? [] : ['--addons', addons]));
  assert.equal(init.code, 0, JSON.stringify(init.error));
  return { base, env, workspace, init, cli: (...args) => run('--root', workspace, ...args) };
}

// spec: addons / List addons
// spec: spec-gardening / Specs addon lists the gardener
// spec: change-progress / Specs addon lists the delivery skills
test('addons list core, kit addons and workspace skill-only addons', async t => {
  const { workspace, init, cli } = await fixture(t);
  assert.deepEqual(init.json.addons, ['maps', 'reflect', 'review', 'specs']);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, 'context-kit.json'), 'utf8')), { version: 1, addons: ['maps', 'reflect', 'review', 'specs'] });
  await mkdir(join(workspace, 'addons/drafting/skills/house-style'), { recursive: true });
  await writeFile(join(workspace, 'addons/drafting/addon.json'), JSON.stringify({ name: 'drafting', description: 'My writing skills.', skills: ['house-style'] }));
  await writeFile(join(workspace, 'addons/drafting/skills/house-style/SKILL.md'), '---\nname: house-style\ndescription: How I write.\n---\n\n# House style\n');
  const { json } = await cli('addons');
  assert.deepEqual(json.addons.map(({ name, source, enabled, skills }) => [name, source, enabled, skills]), [
    ['core', 'kit', true, ['context-kit']],
    ['maps', 'kit', true, ['behavior-map']],
    ['reflect', 'kit', true, ['reflect']],
    ['review', 'kit', true, ['independent-review']],
    ['specs', 'kit', true, ['audit-canonical-specs', 'garden-canonical-specs', 'slice-change', 'reconcile-change']],
    ['drafting', 'workspace', false, ['house-style']]]);
});

// spec: addons / Invalid configuration
test('invalid addon configuration is reported by name', async t => {
  const { workspace, cli } = await fixture(t);
  await writeFile(join(workspace, 'context-kit.json'), JSON.stringify({ version: 1, addons: ['specs', 'teleport'] }));
  const unknown = await cli('list');
  assert.equal(unknown.error.code, 'INVALID_CONFIG');
  assert.match(unknown.error.message, /unknown addon: teleport/);
  await writeFile(join(workspace, 'context-kit.json'), JSON.stringify({ version: 1, addons: [] }));
  await mkdir(join(workspace, 'addons/sneaky/skills/x'), { recursive: true });
  await writeFile(join(workspace, 'addons/sneaky/skills/x/SKILL.md'), '---\nname: x\ndescription: x\n---\n');
  await writeFile(join(workspace, 'addons/sneaky/addon.json'), JSON.stringify({ name: 'sneaky', description: 'Runs code.', skills: ['x'], operations: 'sneaky' }));
  const operations = await cli('list');
  assert.equal(operations.error.code, 'INVALID_CONFIG');
  assert.match(operations.error.message, /workspace addons may only carry skills/);
  assert.equal((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', join(workspace, '..', 'other'), '--addons', 'teleport']).catch(error => error)).code, 1);
});

// spec: addons / Core only
test('a core-only workspace has knowledge tools and no addon operations or skills', async t => {
  const { env, workspace, init, cli } = await fixture(t, 'none');
  assert.deepEqual(init.json.addons, []);
  assert.equal((await cli('list')).code, 0);
  assert.equal((await cli('browse', 'personal/main')).code, 0);
  const specs = await cli('specs', 'list');
  assert.equal(specs.error.code, 'ADDON_DISABLED');
  assert.match(specs.error.message, /specs addon/);
  assert.deepEqual((await cli('skills')).json.skills.map(skill => skill.name), ['context-kit']);
  // A hub declaring a bundled skill whose addon is disabled does not surface it.
  const manifestPath = join(workspace, 'hubs/personal/hub.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, skills: ['kit:context-kit', 'kit:reflect'] }));
  assert.deepEqual((await cli('skills')).json.skills.map(skill => skill.name), ['context-kit']);

  const client = new Client({ name: 'addons-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('browse_hub') && tools.includes('list_addons'));
  assert.ok(!tools.some(name => /spec/.test(name)));
  assert.deepEqual((await client.listPrompts()).prompts.map(prompt => prompt.name), ['context-kit']);
  const refused = await client.callTool({ name: 'audit_specs', arguments: {} });
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'ADDON_DISABLED');
});

// spec: behavior-maps / Maps addon disabled
test('without the maps addon, map commands fail and map tools are absent', async t => {
  const { env, workspace, cli } = await fixture(t, 'specs');
  const listed = await cli('maps', 'list');
  assert.equal(listed.error.code, 'ADDON_DISABLED');
  assert.match(listed.error.message, /maps addon/);
  assert.equal((await cli('maps', 'behaviors', '--source', 'openspec')).error.code, 'ADDON_DISABLED');
  const maps = (await cli('addons')).json.addons.find(addon => addon.name === 'maps');
  assert.deepEqual([maps.enabled, maps.skills], [false, ['behavior-map']]);
  assert.ok(!(await cli('skills')).json.skills.some(skill => skill.name === 'behavior-map'));

  const client = new Client({ name: 'addons-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('list_specs'));
  for (const name of ['list_behaviors', 'list_maps', 'check_map', 'render_map']) assert.ok(!tools.includes(name), name);
  const refused = await client.callTool({ name: 'list_maps', arguments: {} });
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'ADDON_DISABLED');
});

// spec: addons / Bundled skills conform
test('bundled skills use frontmatter both agents accept', async () => {
  const allowed = ['name', 'description', 'license', 'allowed-tools', 'metadata', 'disable-model-invocation'];
  const skills = (await readdir(join(kit, 'skills'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(skills.length >= 3);
  for (const name of skills) {
    const text = await readFile(join(kit, 'skills', name, 'SKILL.md'), 'utf8');
    const data = parseYaml(text.match(/^---\n([\s\S]*?)\n---\n/)[1]);
    assert.equal(data.name, name);
    assert.equal(typeof data.description, 'string');
    assert.deepEqual(Object.keys(data).filter(key => !allowed.includes(key)), [], name);
  }
  // Every bundled skill belongs to a kit addon, so it can be enabled and installed.
  const addonSkills = [];
  for (const addon of await readdir(join(kit, 'addons'))) addonSkills.push(...JSON.parse(await readFile(join(kit, 'addons', addon, 'addon.json'), 'utf8')).skills);
  assert.deepEqual(addonSkills.sort(), skills.sort());
});

// spec: addons / Core lists the routing skill
test('core lists the generated my-repos skill once repositories are registered', async t => {
  const { workspace, cli } = await fixture(t);
  assert.deepEqual((await cli('addons')).json.addons.find(addon => addon.name === 'core').skills, ['context-kit']);
  await writeFile(join(workspace, 'hubs/personal/room.md'), '---\ntype: Repository\ntitle: the room\nresource: https://github.com/me/room\n---\n\n# the room\n');
  const core = (await cli('addons')).json.addons.find(addon => addon.name === 'core');
  assert.deepEqual(core.skills, ['context-kit', 'my-repos']);
  assert.deepEqual(core.generated, ['my-repos']);
});
