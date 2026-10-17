import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-skills-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  delete env.CONTEXT_KIT_ROOT;
  const workspace = join(base, 'workspace');
  const cli = async (...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env })).stdout) }; }
    catch (error) { return { code: error.code, error: JSON.parse(error.stderr).error, stdout: error.stdout }; }
  };
  await cli('init', workspace);
  return { base, env, workspace, cli: (...args) => cli('--root', workspace, ...args) };
}

// spec: skill-library / Read reflect and its references
test('the bundled reflect skill and every reference it names are readable', async t => {
  const { cli } = await fixture(t);
  const skill = await cli('read-skill', 'personal/main', 'kit:reflect');
  assert.equal(skill.code, 0, JSON.stringify(skill.error));
  assert.match(skill.json.content, /^---\nname: reflect\n/);
  const references = [...new Set(skill.json.content.match(/references\/[a-z-]+\.md/g))];
  assert.deepEqual(references.sort(), ['references/divergent-reviewer.md', 'references/judgment-reviewer.md',
    'references/synthesizer.md', 'references/tooling-reviewer.md']);
  for (const file of references) {
    const read = await cli('read-skill', 'personal/main', 'kit:reflect', '--file', file);
    assert.equal(read.code, 0, file);
    assert.equal(read.json.content, await readFile(join(kit, 'skills/reflect', file), 'utf8'));
    assert.match(read.json.content, /\{\{TRANSCRIPT_PATH_OR_DIGEST\}\}/, file);
    assert.match(read.json.content, /\{\{SKILLS_AND_HUBS\}\}/, file);
  }
});

// spec: skill-library / Confined skill files
test('skill files are confined to the skill directory', async t => {
  const { cli } = await fixture(t);
  for (const [file, code] of [['../independent-review/SKILL.md', 'INVALID_PATH'], ['.hidden.md', 'INVALID_PATH'],
    ['references/notes.txt', 'INVALID_PATH'], ['references/missing.md', 'NOT_FOUND']]) {
    const result = await cli('read-skill', 'personal/main', 'kit:reflect', '--file', file);
    assert.equal(result.error?.code, code, file);
    assert.equal(result.stdout, '');
  }
  assert.equal((await cli('read-skill', 'personal/main', 'kit:nope')).error.code, 'UNKNOWN_SKILL');
  assert.equal((await cli('list', '--file', 'x.md')).error.code, 'INVALID_INPUT');
});

// spec: skill-library / Shared skill listed once
test('skills declared by several hubs are listed once', async t => {
  const { workspace, cli } = await fixture(t);
  const second = join(workspace, 'hubs/team');
  await mkdir(second);
  await writeFile(join(second, 'README.md'), '---\ntype: Guide\n---\n\nTeam.\n');
  await writeFile(join(second, 'hub.json'), JSON.stringify({ version: 1, id: 'team/main', description: 'Team',
    documents: ['README.md'], skills: ['kit:reflect'], links: [] }));
  const { json } = await cli('skills');
  assert.deepEqual(json.skills.map(skill => [skill.reference, skill.name, skill.hubs]), [
    ['kit:reflect', 'reflect', ['personal/main', 'team/main']],
    ['kit:independent-review', 'independent-review', ['personal/main']],
    ['kit:audit-canonical-specs', 'audit-canonical-specs', ['personal/main']]]);
  assert.match(json.skills[0].description, /Use when the user says reflect\.$/);
});

// spec: skill-library / Invoke a skill as a prompt
test('the MCP server offers declared skills as prompts', async t => {
  const { env, workspace } = await fixture(t);
  const client = new Client({ name: 'skills-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(prompt => prompt.name), ['reflect', 'independent-review', 'audit-canonical-specs']);
  assert.match(prompts[0].description, /three parallel reviewers/);
  const prompt = await client.getPrompt({ name: 'reflect' });
  const text = prompt.messages[0].content.text;
  assert.match(text, /^# Reflect\n/);
  assert.match(text, /read_skill tool: \{"id": "personal\/main", "reference": "kit:reflect", "file": /);
  await assert.rejects(client.getPrompt({ name: 'nope' }), /Unknown prompt/);
  const viaTool = await client.callTool({ name: 'read_skill', arguments: { id: 'personal/main', reference: 'kit:reflect', file: 'references/synthesizer.md' } });
  assert.match(viaTool.structuredContent.content, /^# Reflect: synthesizer/);
});
