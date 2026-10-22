import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, lstat, mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const exists = path => lstat(path).then(() => true, () => false);

// A fake agent CLI: logs every call and keeps a registry so `mcp get` reflects add/remove.
const fake = (base, agent) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(base, 'calls.jsonl'))}, JSON.stringify({ agent: ${JSON.stringify(agent)}, cwd: process.cwd(), args }) + '\\n');
const file = ${JSON.stringify(join(base, `${agent}-servers.json`))};
const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const rest = args.slice(1).filter((arg, i, all) => arg !== '-s' && all[i - 1] !== '-s');
const name = rest[1];
if (args[0] !== 'mcp') process.exit(2);
if (rest[0] === 'get') process.exit(servers[name] ? 0 : 1);
if (rest[0] === 'remove') { delete servers[name]; }
if (rest[0] === 'add') { servers[name] = rest.slice(rest.indexOf('--') + 1); }
fs.writeFileSync(file, JSON.stringify(servers));
`;

// An isolated machine: home and agent config directories, and a PATH with only node, npm
// and the chosen agent CLIs (fake by default).
async function fixture(t, { agents = ['claude', 'codex'], addons } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-agents-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  await symlink(join(dirname(process.execPath), 'npm'), join(bin, 'npm'));
  for (const agent of agents) {
    await writeFile(join(bin, agent), fake(base, agent));
    await chmod(join(bin, agent), 0o755);
  }
  const env = { HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'),
    XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'), PATH: `${bin}:/usr/bin:/bin`,
    npm_config_cache: join(base, 'npm-cache'), npm_config_update_notifier: 'false' };
  await mkdir(env.HOME);
  const workspace = join(base, 'workspace');
  const run = async (args, extra = {}) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env: { ...env, ...extra }, cwd: base })).stdout) }; }
    catch (error) { return { code: error.code, error: error.stderr ? JSON.parse(error.stderr).error : error.message, stdout: error.stdout }; }
  };
  await run(['init', workspace, ...(addons ? ['--addons', addons] : [])]);
  const calls = async () => (await readFile(join(base, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { base, env, workspace, run, calls, agents: (...args) => run(['--root', workspace, 'agents', ...args]) };
}
const byAction = results => Object.fromEntries(results.map(item => [`${item.agent}:${item.kind}:${item.name}`, item.action]));

// spec: agent-installation / Install for Claude Code and Codex
test('install puts enabled skills and the MCP server into both agents', async t => {
  const { base, workspace, calls, agents } = await fixture(t);
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  for (const [dir, agent] of [[join(base, 'claude/skills'), 'claude'], [join(base, 'codex/skills'), 'codex']]) {
    assert.deepEqual((await readdir(dir)).sort(), ['audit-canonical-specs', 'context-kit', 'garden-canonical-specs', 'independent-review', 'reconcile-change', 'reflect', 'slice-change'], agent);
  }
  assert.match(await readFile(join(base, 'claude/skills/reflect/SKILL.md'), 'utf8'), /^disable-model-invocation: true$/m);
  const codexReflect = await readFile(join(base, 'codex/skills/reflect/SKILL.md'), 'utf8');
  assert.doesNotMatch(codexReflect, /disable-model-invocation/);
  assert.match(codexReflect, /^name: reflect$/m);
  assert.match(await readFile(join(base, 'codex/skills/reflect/references/synthesizer.md'), 'utf8'), /^# Reflect: synthesizer/);

  const adds = (await calls()).filter(call => call.args.includes('add'));
  const server = [process.execPath, join(kit, 'bin/mcp.mjs'), '--root', workspace, '--no-skill-prompts'];
  assert.deepEqual(adds.map(call => [call.agent, call.args]), [
    ['claude', ['mcp', 'add', '-s', 'user', 'context-workspace', '--', ...server]],
    ['codex', ['mcp', 'add', 'context-workspace', '--', ...server]]]);
  const status = await agents('status');
  assert.equal(status.json.items.length, 17);
  assert.ok(status.json.items.every(item => item.state === 'installed'), JSON.stringify(status.json.items));

  const again = await agents('install');
  assert.ok(again.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'unchanged'));
  assert.deepEqual(again.json.results.filter(item => item.kind === 'mcp').map(item => item.action), ['updated', 'updated']);
});

// spec: agent-installation / Install for Claude Code and Codex
test('install works with the real Claude Code and Codex CLIs when present', async t => {
  const real = {};
  for (const cli of ['claude', 'codex']) {
    for (const dir of (process.env.PATH || '').split(':')) {
      if (await access(join(dir, cli)).then(() => true, () => false)) { real[cli] = join(dir, cli); break; }
    }
  }
  if (!real.claude || !real.codex) return t.skip('claude and codex CLIs are not both installed');
  const { base, env, workspace, agents } = await fixture(t, { agents: [] });
  for (const [cli, path] of Object.entries(real)) await symlink(path, join(base, 'bin', cli));
  await mkdir(env.CODEX_HOME, { recursive: true });
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const mcp = installed.json.results.filter(item => item.kind === 'mcp');
  assert.deepEqual(mcp.map(item => item.action), ['installed', 'installed'], JSON.stringify(mcp));
  assert.match(await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8'), /\[mcp_servers\.context-workspace\][\s\S]*--no-skill-prompts/);
  const claudeConfig = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'));
  assert.deepEqual(claudeConfig.mcpServers['context-workspace'].args.slice(-3), ['--root', workspace, '--no-skill-prompts']);
  assert.equal((await agents('uninstall')).code, 0);
  assert.doesNotMatch(await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8'), /mcp_servers\.context-workspace/);
});

// spec: agent-installation / Project scope
test('project scope installs skills in the project and keeps MCP private', async t => {
  const { base, calls, agents } = await fixture(t);
  const project = join(base, 'project');
  await mkdir(project);
  const result = await agents('install', '--scope', 'project', '--project', project);
  assert.equal(result.code, 0, JSON.stringify(result.error));
  assert.ok(await exists(join(project, '.claude/skills/reflect/SKILL.md')));
  assert.ok(await exists(join(project, '.agents/skills/reflect/SKILL.md')));
  assert.equal(await exists(join(base, 'claude/skills')), false);
  assert.equal(await exists(join(project, '.mcp.json')), false);
  const add = (await calls()).find(call => call.args.includes('add'));
  assert.deepEqual([add.agent, add.args.slice(0, 4), add.cwd], ['claude', ['mcp', 'add', '-s', 'local'], project]);
  const codex = result.json.results.find(item => item.agent === 'codex' && item.kind === 'mcp');
  assert.equal(codex.action, 'skipped');
  assert.match(codex.reason, /--global-mcp/);
  const global = await agents('install', '--scope', 'project', '--project', project, '--global-mcp');
  assert.equal(global.json.results.find(item => item.agent === 'codex' && item.kind === 'mcp').action, 'installed');
});

async function workspaceAddon(workspace, body = 'Write plainly.') {
  const dir = join(workspace, 'addons/drafting/skills/house-style');
  await mkdir(dir, { recursive: true });
  await writeFile(join(workspace, 'addons/drafting/addon.json'), JSON.stringify({ name: 'drafting', description: 'My writing skills.', skills: ['house-style'] }));
  await writeFile(join(dir, 'SKILL.md'), `---\nname: house-style\ndescription: How I write.\n---\n\n${body}\n`);
  const configPath = join(workspace, 'context-kit.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await writeFile(configPath, JSON.stringify({ ...config, addons: [...config.addons, 'drafting'] }));
  return dir;
}

// spec: agent-installation / Disable an addon and reinstall
test('reinstalling reconciles disabled addons and changed sources', async t => {
  const { base, workspace, agents } = await fixture(t);
  const source = await workspaceAddon(workspace);
  assert.equal((await agents('install', '--agent', 'claude')).code, 0);
  await writeFile(join(source, 'SKILL.md'), '---\nname: house-style\ndescription: How I write.\n---\n\nWrite plainly and briefly.\n');
  const stale = await agents('status');
  assert.equal(stale.json.items.find(item => item.name === 'house-style').state, 'stale');
  const configPath = join(workspace, 'context-kit.json');
  await writeFile(configPath, JSON.stringify({ version: 1, addons: ['reflect', 'specs', 'drafting'] }));
  const again = await agents('install', '--agent', 'claude');
  const actions = byAction(again.json.results);
  assert.equal(actions['claude:skill:house-style'], 'updated');
  assert.equal(actions['claude:skill:independent-review'], 'removed');
  assert.equal(actions['claude:skill:reflect'], 'unchanged');
  assert.match(await readFile(join(base, 'claude/skills/house-style/SKILL.md'), 'utf8'), /briefly/);
  assert.equal(await exists(join(base, 'claude/skills/independent-review')), false);
  assert.ok((await agents('status')).json.items.every(item => item.state === 'installed'));
});

// spec: agent-installation / Iterate on a linked skill
test('linked skills follow their source', async t => {
  const { base, workspace, agents } = await fixture(t);
  const source = await workspaceAddon(workspace);
  const result = await agents('install', '--link');
  assert.equal(result.code, 0, JSON.stringify(result.error));
  for (const agent of ['claude', 'codex']) assert.ok((await lstat(join(base, agent, 'skills/house-style'))).isSymbolicLink());
  await writeFile(join(source, 'SKILL.md'), '---\nname: house-style\ndescription: How I write.\n---\n\nIterated wording.\n');
  assert.match(await readFile(join(base, 'codex/skills/house-style/SKILL.md'), 'utf8'), /Iterated wording/);
  // Reflect needs adapted frontmatter for Codex, so it cannot be linked there.
  const codexReflect = result.json.results.find(item => item.agent === 'codex' && item.name === 'reflect');
  assert.equal(codexReflect.action, 'conflict');
  assert.match(codexReflect.reason, /without --link/);
  assert.ok((await lstat(join(base, 'claude/skills/reflect'))).isSymbolicLink());
});

// spec: agent-installation / Foreign and edited skills are preserved
test('install and uninstall never touch skills they did not create or that were edited', async t => {
  const { base, agents, calls } = await fixture(t);
  await mkdir(join(base, 'claude/skills/reflect'), { recursive: true });
  await writeFile(join(base, 'claude/skills/reflect/SKILL.md'), 'mine');
  const result = await agents('install');
  const conflict = result.json.results.find(item => item.agent === 'claude' && item.name === 'reflect');
  assert.equal(conflict.action, 'conflict');
  assert.match(conflict.reason, new RegExp(`${join(base, 'claude/skills/reflect')} exists .* --force`));
  assert.equal(await readFile(join(base, 'claude/skills/reflect/SKILL.md'), 'utf8'), 'mine');

  await writeFile(join(base, 'codex/skills/independent-review/SKILL.md'), 'edited by hand');
  const removed = await agents('uninstall');
  const actions = byAction(removed.json.results);
  assert.equal(actions['codex:skill:independent-review'], 'kept');
  assert.equal(actions['claude:skill:audit-canonical-specs'], 'removed');
  assert.equal(actions['claude:mcp:context-workspace'], 'removed');
  assert.equal(await readFile(join(base, 'codex/skills/independent-review/SKILL.md'), 'utf8'), 'edited by hand');
  assert.equal(await readFile(join(base, 'claude/skills/reflect/SKILL.md'), 'utf8'), 'mine');
  assert.equal(await exists(join(base, 'codex/skills/reflect')), false);
  assert.ok((await calls()).some(call => call.agent === 'codex' && call.args.join(' ') === 'mcp remove context-workspace'));
  assert.deepEqual((await agents('status')).json.items.map(item => [item.agent, item.name, item.state]), [['codex', 'independent-review', 'changed']]);
});

// spec: agent-installation / Agent CLI missing
test('a missing agent CLI skips MCP registration but installs skills', async t => {
  const { base, agents } = await fixture(t, { agents: ['claude'] });
  const result = await agents('install');
  assert.equal(result.code, 0, JSON.stringify(result.error));
  const codex = result.json.results.find(item => item.agent === 'codex' && item.kind === 'mcp');
  assert.deepEqual([codex.action, codex.reason], ['skipped', 'codex CLI not found on PATH']);
  assert.ok(await exists(join(base, 'codex/skills/reflect/SKILL.md')));
  assert.equal(result.json.results.find(item => item.agent === 'claude' && item.kind === 'mcp').action, 'installed');
});

// spec: agent-installation / Set up a workspace
test('setup creates a pinned instance and installs it into agents', async t => {
  const { base, run, calls } = await fixture(t);
  const target = join(base, 'my-context');
  const result = await run(['setup', target, '--kit', `file:${kit}`, '--addons', 'reflect', '--agent', 'claude'], { npm_config_offline: 'true' });
  assert.equal(result.code, 0, JSON.stringify(result.error));
  assert.deepEqual(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).dependencies, { 'context-kit': `file:${kit}` });
  assert.deepEqual(JSON.parse(await readFile(join(target, 'context-kit.json'), 'utf8')).addons, ['reflect']);
  assert.deepEqual((await readdir(join(base, 'claude/skills'))).sort(), ['context-kit', 'reflect']);
  assert.deepEqual(result.json.agents.results.map(item => `${item.kind}:${item.name}:${item.action}`), ['skill:context-kit:installed', 'skill:reflect:installed', 'mcp:my-context:installed',
    'guard:merge-guard:installed', 'hook:post-merge:skipped', 'hook:post-rewrite:skipped']);
  const add = (await calls()).find(call => call.args.includes('add') && call.args.includes('my-context'));
  assert.ok(add.args.includes(join(target, 'node_modules/context-kit/bin/mcp.mjs')) || add.args.includes(join(kit, 'bin/mcp.mjs')));
});

const repository = (workspace, name, fields) => writeFile(join(workspace, 'hubs/personal', `${name}.md`),
  `---\ntype: Repository\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n# ${name}\n`);
async function gitCheckout(path, origin) {
  await mkdir(path, { recursive: true });
  await promisify(execFile)('git', ['init', '-q'], { cwd: path });
  await promisify(execFile)('git', ['remote', 'add', 'origin', origin], { cwd: path });
  return realpath(path);
}

// spec: agent-installation / Install the routing skill
test('install copies the generated my-repos skill into both agents, even with --link', async t => {
  const { base, workspace, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['fayelore.com'] });
  const installed = await agents('install', '--link');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  for (const agent of ['claude', 'codex']) {
    const path = join(base, agent, 'skills/my-repos');
    assert.equal((await lstat(path)).isSymbolicLink(), false, agent);
    assert.match(await readFile(join(path, 'SKILL.md'), 'utf8'), /^name: my-repos$/m);
  }
  const status = await agents('status');
  assert.deepEqual(status.json.items.filter(item => item.name === 'my-repos').map(item => [item.agent, item.mode, item.state]),
    [['claude', 'copy', 'installed'], ['codex', 'copy', 'installed']]);
});

// spec: agent-installation / Last repository removed
test('reinstalling after the last repository is gone removes my-repos', async t => {
  const { base, workspace, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await agents('install');
  assert.ok(await exists(join(base, 'claude/skills/my-repos')));
  await rm(join(workspace, 'hubs/personal/room.md'));
  const again = await agents('install');
  assert.equal(byAction(again.json.results)['claude:skill:my-repos'], 'removed');
  assert.equal(await exists(join(base, 'claude/skills/my-repos')), false);
  assert.equal(await exists(join(base, 'codex/skills/my-repos')), false);
});

// spec: agent-installation / Pulled hub changes
test('status reports my-repos stale after a new repository arrives, and install updates it', async t => {
  const { base, workspace, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await agents('install');
  await repository(workspace, 'garden', { title: 'the garden', resource: 'https://github.com/me/garden' });
  const stale = await agents('status');
  assert.deepEqual(stale.json.items.filter(item => item.name === 'my-repos').map(item => item.state), ['stale', 'stale']);
  await agents('install');
  assert.match(await readFile(join(base, 'codex/skills/my-repos/SKILL.md'), 'utf8'), /the garden/);
  assert.ok((await agents('status')).json.items.every(item => item.state === 'installed'));
});

// spec: agent-installation / Locating refreshes the skill
test('locating a repository updates installed copies without reinstalling', async t => {
  const { base, workspace, run, agents, calls } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await agents('install');
  // An edited copy is left alone and reported.
  await writeFile(join(base, 'codex/skills/my-repos/SKILL.md'), 'mine\n');
  const before = (await calls()).length;
  const path = await gitCheckout(join(base, 'room'), 'https://github.com/me/room');
  const located = await run(['--root', workspace, 'repos', 'locate', 'room', path]);
  assert.equal(located.code, 0, JSON.stringify(located.error));
  assert.deepEqual(byAction(located.json.skills), { 'claude:skill:my-repos': 'updated', 'codex:skill:my-repos': 'conflict' });
  assert.ok((await readFile(join(base, 'claude/skills/my-repos/SKILL.md'), 'utf8')).includes(`https://github.com/me/room at ${path}`));
  assert.equal(await readFile(join(base, 'codex/skills/my-repos/SKILL.md'), 'utf8'), 'mine\n');
  assert.equal((await calls()).length, before, 'no agent CLI calls');
});

// spec: agent-installation / Sync after editing repositories
test('repos sync rebuilds my-repos from the Repository concepts without touching MCP', async t => {
  const { base, workspace, run, agents, calls } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room'] });
  await agents('install');
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['room', 'fayelore.com'] });
  const before = (await calls()).length;
  const synced = await run(['--root', workspace, 'repos', 'sync']);
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  assert.deepEqual(byAction(synced.json.results), { 'claude:skill:my-repos': 'updated', 'codex:skill:my-repos': 'updated' });
  for (const agent of ['claude', 'codex']) {
    assert.match((await readFile(join(base, agent, 'skills/my-repos/SKILL.md'), 'utf8')).split('\n---')[0], /^description: .*fayelore\.com/m, agent);
  }
  assert.equal((await calls()).length, before, 'no agent CLI calls');
  assert.ok((await agents('status')).json.items.every(item => item.state === 'installed'));
});

// spec: agent-installation / Sync before any install
test('repos sync before any install renders the skill and says to install', async t => {
  const { workspace, run } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const synced = await run(['--root', workspace, 'repos', 'sync']);
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  assert.deepEqual(synced.json.results, []);
  assert.match(synced.json.next, /agents install/);
  assert.match(await readFile(synced.json.skill, 'utf8'), /^name: my-repos$/m);
});

// A workspace that is a git checkout tracking a bare remote, plus a second clone that
// stands in for another machine pushing hub changes.
async function gitWorkspace(base, workspace) {
  const git = (cwd, ...args) => promisify(execFile)('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  await git(workspace, 'init', '-q', '-b', 'main');
  await git(workspace, 'add', '-A');
  await git(workspace, 'commit', '-qm', 'workspace');
  const remote = join(base, 'remote.git');
  await git(base, 'clone', '-q', '--bare', workspace, remote);
  await git(workspace, 'remote', 'add', 'origin', remote);
  await git(workspace, 'fetch', '-q', 'origin');
  await git(workspace, 'branch', '-q', '--set-upstream-to', 'origin/main');
  const other = join(base, 'other');
  await git(base, 'clone', '-q', remote, other);
  return { git, other };
}

// spec: agent-installation / A pull rebuilds the skill
test('a pull that brings a new repository rebuilds the installed my-repos skill', async t => {
  const { base, workspace, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const { git, other } = await gitWorkspace(base, workspace);
  const installed = await agents('install');
  assert.deepEqual(installed.json.results.filter(item => item.kind === 'hook').map(item => [item.name, item.action]), [['post-merge', 'installed'], ['post-rewrite', 'installed']]);
  assert.match(await readFile(join(workspace, '.git/hooks/post-merge'), 'utf8'), /repos sync/);
  // Elsewhere, someone registers a repository and pushes; here, a plain pull.
  await repository(other, 'garden', { title: 'the garden', resource: 'https://github.com/me/garden' });
  await git(other, 'add', '-A');
  await git(other, 'commit', '-qm', 'garden');
  await git(other, 'push', '-q');
  await git(workspace, 'pull', '-q', '--no-rebase');
  for (const agent of ['claude', 'codex']) assert.match(await readFile(join(base, agent, 'skills/my-repos/SKILL.md'), 'utf8'), /the garden/, agent);
  const status = await agents('status');
  assert.ok(status.json.items.every(item => item.state === 'installed'), JSON.stringify(status.json.items));
  assert.deepEqual(status.json.items.filter(item => item.kind === 'hook').map(item => item.name), ['post-merge', 'post-rewrite']);
});

// spec: agent-installation / Existing hooks are kept
test('install keeps a post-merge hook it did not write, and uninstall removes only its own', async t => {
  const { base, workspace, agents } = await fixture(t);
  await gitWorkspace(base, workspace);
  const mine = '#!/bin/sh\necho mine\n';
  await writeFile(join(workspace, '.git/hooks/post-merge'), mine, { mode: 0o755 });
  const installed = await agents('install');
  const hooks = Object.fromEntries(installed.json.results.filter(item => item.kind === 'hook').map(item => [item.name, item]));
  assert.equal(hooks['post-merge'].action, 'conflict');
  assert.match(hooks['post-merge'].reason, /post-merge exists and was not installed by Context Kit/);
  assert.equal(hooks['post-rewrite'].action, 'installed');
  assert.equal(await readFile(join(workspace, '.git/hooks/post-merge'), 'utf8'), mine);
  const removed = await agents('uninstall');
  assert.deepEqual(removed.json.results.filter(item => item.kind === 'hook').map(item => [item.name, item.action]), [['post-rewrite', 'removed']]);
  assert.equal(await exists(join(workspace, '.git/hooks/post-rewrite')), false);
  assert.equal(await readFile(join(workspace, '.git/hooks/post-merge'), 'utf8'), mine);
});

const points = text => [...text].length;
const frontmatter = async path => parseYaml((await readFile(join(path, 'SKILL.md'), 'utf8')).match(/^---\n([\s\S]*?)\n---\n/)[1]);
const padded = (prefix, length) => prefix + 'x'.repeat(length - points(prefix));

// spec: repository-registry / Too many repositories for one
// spec: repository-registry / Shards shrink back
test('repositories whose minimal entries overflow one description shard into my-repos-2, and shrink back', async t => {
  const { base, workspace, run, agents } = await fixture(t);
  const ids = Array.from({ length: 20 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);
  for (const id of ids) await repository(workspace, id, { title: `repo ${id}`, resource: `https://github.com/me/${id}`, aliases: [padded(`${id}-nickname-`, 40)] });
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  assert.deepEqual(installed.json.skipped, {});
  for (const agent of ['claude', 'codex']) {
    const skills = (await readdir(join(base, agent, 'skills'))).filter(name => name.startsWith('my-repos'));
    assert.deepEqual(skills.sort(), ['my-repos', 'my-repos-2'], agent);
    const named = [];
    for (const skill of skills) {
      const front = await frontmatter(join(base, agent, 'skills', skill));
      assert.equal(front.name, skill);
      assert.ok(points(front.description) <= 1024, `${skill} is ${points(front.description)} code points`);
      named.push(...ids.filter(id => front.description.includes(`repo ${id} (${id}-nickname-`)));
    }
    assert.deepEqual(named, ids, `${agent}: each repository once, in id order`);
  }
  assert.ok((await agents('status')).json.items.every(item => item.state === 'installed'));
  // Remove repositories until every minimal entry fits one description again.
  for (const id of ids.slice(10)) await rm(join(workspace, 'hubs/personal', `${id}.md`));
  const synced = await run(['--root', workspace, 'repos', 'sync']);
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  assert.deepEqual(byAction(synced.json.results.filter(item => item.name === 'my-repos-2')), { 'claude:skill:my-repos-2': 'removed', 'codex:skill:my-repos-2': 'removed' });
  for (const agent of ['claude', 'codex']) {
    assert.equal(await exists(join(base, agent, 'skills/my-repos-2')), false, agent);
    const front = await frontmatter(join(base, agent, 'skills/my-repos'));
    for (const id of ids.slice(0, 10)) assert.ok(front.description.includes(`repo ${id}`), `${agent} names ${id}`);
  }
  assert.equal(synced.json.skills.length, 1);
  assert.ok((await agents('status')).json.items.every(item => item.state === 'installed'));
});

// spec: repository-registry / Longest allowed names
test('a repository with the longest allowed title and twenty longest aliases fits on its own, reporting the rest', async t => {
  const { base, workspace, agents } = await fixture(t);
  const title = padded('the room ', 80);
  const aliases = Array.from({ length: 20 }, (_, i) => padded(`room-${String(i + 1).padStart(2, '0')} `, 60));
  await repository(workspace, 'room', { title, resource: 'https://github.com/me/room', aliases });
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const front = await frontmatter(join(base, 'claude/skills/my-repos'));
  assert.ok(points(front.description) <= 1024);
  assert.ok(front.description.includes(`${title} (${aliases[0]}`), 'minimal entry');
  const skipped = installed.json.skipped['personal/main/room'];
  assert.ok(skipped.length > 0);
  assert.deepEqual(aliases.filter(alias => !front.description.includes(alias)), skipped);
  assert.equal(await exists(join(base, 'claude/skills/my-repos-2')), false);
});
