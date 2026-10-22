import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, lstat, mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, realpath, symlink } from 'node:fs/promises';
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
// Where each harness's user skills are in the fixture: Claude Code's own directory, and the
// shared ~/.agents/skills for the others.
const skillsOf = (base, agent) => agent === 'claude' ? join(base, 'claude/skills') : join(base, 'home/.agents/skills');
const byAction = results => Object.fromEntries(results.map(item => [`${item.agent}:${item.kind}:${item.name}`, item.action]));

// spec: agent-installation / Install for Claude Code and Codex
test('install puts enabled skills and the MCP server into both agents', async t => {
  const { base, workspace, calls, agents } = await fixture(t);
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  for (const [dir, agent] of [[join(base, 'claude/skills'), 'claude'], [join(base, 'home/.agents/skills'), 'codex']]) {
    assert.deepEqual((await readdir(dir)).sort(), ['audit-canonical-specs', 'context-kit', 'garden-canonical-specs', 'independent-review', 'reconcile-change', 'reflect', 'slice-change'], agent);
  }
  assert.equal(await exists(join(base, 'codex/skills')), false, 'nothing under $CODEX_HOME/skills');
  assert.match(await readFile(join(base, 'claude/skills/reflect/SKILL.md'), 'utf8'), /^disable-model-invocation: true$/m);
  const codexReflect = await readFile(join(base, 'home/.agents/skills/reflect/SKILL.md'), 'utf8');
  assert.doesNotMatch(codexReflect, /disable-model-invocation/);
  assert.match(codexReflect, /^name: reflect$/m);
  assert.match(await readFile(join(base, 'home/.agents/skills/reflect/references/synthesizer.md'), 'utf8'), /^# Reflect: synthesizer/);

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
  for (const agent of ['claude', 'codex']) assert.ok((await lstat(join(skillsOf(base, agent), 'house-style'))).isSymbolicLink());
  await writeFile(join(source, 'SKILL.md'), '---\nname: house-style\ndescription: How I write.\n---\n\nIterated wording.\n');
  assert.match(await readFile(join(base, 'home/.agents/skills/house-style/SKILL.md'), 'utf8'), /Iterated wording/);
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

  await writeFile(join(base, 'home/.agents/skills/independent-review/SKILL.md'), 'edited by hand');
  const removed = await agents('uninstall');
  const actions = byAction(removed.json.results);
  assert.equal(actions['codex:skill:independent-review'], 'kept');
  assert.equal(actions['claude:skill:audit-canonical-specs'], 'removed');
  assert.equal(actions['claude:mcp:context-workspace'], 'removed');
  assert.equal(await readFile(join(base, 'home/.agents/skills/independent-review/SKILL.md'), 'utf8'), 'edited by hand');
  assert.equal(await readFile(join(base, 'claude/skills/reflect/SKILL.md'), 'utf8'), 'mine');
  assert.equal(await exists(join(base, 'home/.agents/skills/reflect')), false);
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
  assert.ok(await exists(join(base, 'home/.agents/skills/reflect/SKILL.md')));
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
    const path = join(skillsOf(base, agent), 'my-repos');
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
  assert.equal(await exists(join(base, 'home/.agents/skills/my-repos')), false);
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
  assert.match(await readFile(join(base, 'home/.agents/skills/my-repos/SKILL.md'), 'utf8'), /the garden/);
  assert.ok((await agents('status')).json.items.every(item => item.state === 'installed'));
});

// spec: agent-installation / Locating refreshes the skill
test('locating a repository updates installed copies without reinstalling', async t => {
  const { base, workspace, run, agents, calls } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  await agents('install');
  // An edited copy is left alone and reported.
  await writeFile(join(base, 'home/.agents/skills/my-repos/SKILL.md'), 'mine\n');
  const before = (await calls()).length;
  const path = await gitCheckout(join(base, 'room'), 'https://github.com/me/room');
  const located = await run(['--root', workspace, 'repos', 'locate', 'room', path]);
  assert.equal(located.code, 0, JSON.stringify(located.error));
  assert.deepEqual(byAction(located.json.skills), { 'claude:skill:my-repos': 'updated', 'codex:skill:my-repos': 'conflict' });
  assert.ok((await readFile(join(base, 'claude/skills/my-repos/SKILL.md'), 'utf8')).includes(`https://github.com/me/room at ${path}`));
  assert.equal(await readFile(join(base, 'home/.agents/skills/my-repos/SKILL.md'), 'utf8'), 'mine\n');
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
    assert.match((await readFile(join(skillsOf(base, agent), 'my-repos/SKILL.md'), 'utf8')).split('\n---')[0], /^description: .*fayelore\.com/m, agent);
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
  for (const agent of ['claude', 'codex']) assert.match(await readFile(join(skillsOf(base, agent), 'my-repos/SKILL.md'), 'utf8'), /the garden/, agent);
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
// spec: repository-registry / Balanced shards
// spec: repository-registry / Shards shrink back
test('repositories whose minimal entries overflow one description shard evenly into my-repos-2, and shrink back', async t => {
  const { base, workspace, run, agents } = await fixture(t);
  const ids = Array.from({ length: 20 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);
  for (const id of ids) await repository(workspace, id, { title: `repo ${id}`, resource: `https://github.com/me/${id}`, aliases: [padded(`${id}-nickname-`, 40), `${id}-b`], keywords: [`${id} topic`] });
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  assert.deepEqual(installed.json.skipped, {});
  for (const agent of ['claude', 'codex']) {
    const skills = (await readdir(skillsOf(base, agent))).filter(name => name.startsWith('my-repos'));
    assert.deepEqual(skills.sort(), ['my-repos', 'my-repos-2'], agent);
    const named = [];
    for (const skill of skills) {
      const front = await frontmatter(join(skillsOf(base, agent), skill));
      assert.equal(front.name, skill);
      assert.ok(points(front.description) <= 1024, `${skill} is ${points(front.description)} code points`);
      const here = ids.filter(id => front.description.includes(`repo ${id} (${id}-nickname-`));
      // Balanced: ten each, so both shards have room for every second alias and keyword.
      assert.equal(here.length, 10, `${agent} ${skill}`);
      for (const id of here) assert.ok(front.description.includes(`${id}-b, ${id} topic)`), `${skill} names all of ${id}`);
      named.push(...here);
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
    assert.equal(await exists(join(skillsOf(base, agent), 'my-repos-2')), false, agent);
    const front = await frontmatter(join(skillsOf(base, agent), 'my-repos'));
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

const BUNDLED = ['audit-canonical-specs', 'context-kit', 'garden-canonical-specs', 'independent-review', 'reconcile-change', 'reflect', 'slice-change'];
const STANDARD_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const skillResults = (results, name) => results.filter(item => item.kind === 'skill' && item.name === name);

// spec: agent-installation / Claude Code with harnesses that share
test('Claude Code, Codex and Gemini CLI get Claude Code\'s directory and one shared copy', async t => {
  const { base, env, agents } = await fixture(t);
  const installed = await agents('install', '--agent', 'claude,codex,gemini');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const shared = join(env.HOME, '.agents/skills');
  assert.deepEqual((await readdir(join(base, 'claude/skills'))).sort(), BUNDLED);
  assert.deepEqual((await readdir(shared)).sort(), BUNDLED);
  assert.equal(await exists(join(base, 'codex/skills')), false);
  assert.equal(await exists(join(env.HOME, '.gemini')), false);
  // One copy each place: the shared result names both harnesses it serves.
  assert.deepEqual(skillResults(installed.json.results, 'reflect').map(item => [item.path, item.agents, item.action]),
    [[join(base, 'claude/skills/reflect'), ['claude'], 'installed'], [join(shared, 'reflect'), ['codex', 'gemini'], 'installed']]);
  for (const name of BUNDLED) {
    const keys = Object.keys(await frontmatter(join(shared, name)));
    assert.ok(keys.every(key => STANDARD_KEYS.includes(key)), `${name}: ${keys}`);
  }
  assert.match(await readFile(join(base, 'claude/skills/reflect/SKILL.md'), 'utf8'), /^disable-model-invocation: true$/m);
  const gemini = installed.json.results.filter(item => item.agent === 'gemini' && item.kind !== 'skill');
  assert.deepEqual(gemini.map(item => [item.kind, item.action]), [['mcp', 'unsupported'], ['guard', 'unsupported']]);
  const status = await agents('status');
  assert.deepEqual(status.json.items.filter(item => item.name === 'reflect').map(item => [item.agent, item.path, item.state]),
    [['claude', join(base, 'claude/skills/reflect'), 'installed'], ['codex', join(shared, 'reflect'), 'installed'], ['gemini', join(shared, 'reflect'), 'installed']]);
});

// spec: agent-installation / Cursor with or without Claude Code
test('Cursor alone gets the shared directory, and with Claude Code reads Claude Code\'s copy', async t => {
  // Cursor reads ~/.claude/skills, so Claude Code's directory must be the default one here.
  const alone = await fixture(t);
  const home = alone.env.HOME;
  assert.equal((await alone.run(['--root', alone.workspace, 'agents', 'install', '--agent', 'cursor'], { CLAUDE_CONFIG_DIR: '' })).code, 0);
  assert.deepEqual((await readdir(join(home, '.agents/skills'))).sort(), BUNDLED);
  assert.equal(await exists(join(home, '.claude')), false);

  const both = await fixture(t);
  const installed = await both.run(['--root', both.workspace, 'agents', 'install', '--agent', 'claude,cursor'], { CLAUDE_CONFIG_DIR: '' });
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  assert.deepEqual((await readdir(join(both.env.HOME, '.claude/skills'))).sort(), BUNDLED);
  assert.equal(await exists(join(both.env.HOME, '.agents')), false);
  assert.deepEqual(skillResults(installed.json.results, 'reflect').map(item => item.agents), [['claude', 'cursor']]);

  // With CLAUDE_CONFIG_DIR elsewhere, Cursor can't see Claude Code's copy, so it gets the shared one.
  const moved = await fixture(t);
  assert.equal((await moved.agents('install', '--agent', 'claude,cursor')).code, 0);
  assert.deepEqual((await readdir(join(moved.base, 'claude/skills'))).sort(), BUNDLED);
  assert.deepEqual((await readdir(join(moved.env.HOME, '.agents/skills'))).sort(), BUNDLED);
});

// spec: agent-installation / Selective uninstall of shared copies
test('uninstalling one harness keeps the shared copies another still uses', async t => {
  const { env, agents, calls } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex,gemini')).code, 0);
  const first = await agents('uninstall', '--agent', 'codex');
  assert.equal(first.code, 0, JSON.stringify(first.error));
  const reflect = skillResults(first.json.results, 'reflect')[0];
  assert.deepEqual([reflect.action, reflect.code, reflect.reason], ['kept', 'STILL_USED', 'still used by Gemini CLI']);
  assert.deepEqual((await readdir(shared)).sort(), BUNDLED);
  assert.ok((await calls()).some(call => call.agent === 'codex' && call.args.join(' ') === 'mcp remove context-workspace'));
  const status = await agents('status');
  const skills = status.json.items.filter(item => item.kind === 'skill');
  assert.equal(skills.length, BUNDLED.length);
  assert.ok(skills.every(item => item.agent === 'gemini' && item.state === 'installed'), JSON.stringify(skills));
  const second = await agents('uninstall', '--agent', 'gemini');
  assert.ok(skillResults(second.json.results, 'reflect').every(item => item.action === 'removed'));
  assert.deepEqual(await readdir(shared), []);
  assert.deepEqual((await agents('status')).json.items, []);
});

// Records as a core from before the shared location wrote them: Codex skills under
// <codexHome>/skills, each naming one agent and no location.
async function legacyCodexInstall({ env, workspace, agents }, codexHome) {
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  const legacy = join(codexHome, 'skills');
  await mkdir(codexHome, { recursive: true });
  await rename(join(env.HOME, '.agents/skills'), legacy);
  const file = join(workspace, '.state/agents.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.items = state.items.map(({ agents: _, location, scope, ...item }) => item.kind !== 'skill' ? { ...item, ...(scope ? { scope } : {}) }
    : { agent: 'codex', ...item, path: join(legacy, item.name) });
  await writeFile(file, JSON.stringify(state, null, 2));
  return legacy;
}
const records = async workspace => JSON.parse(await readFile(join(workspace, '.state/agents.json'), 'utf8')).items.filter(item => item.kind === 'skill')
  .map(item => ({ agents: item.agents ?? [item.agent], name: item.name, path: item.path, installedHash: item.installedHash }));

// spec: agent-installation / Upgrade an existing Codex install
test('reinstalling for Codex moves its unchanged legacy copies to the shared location and keeps an edited one', async t => {
  const machine = await fixture(t);
  const { base, env, workspace, agents } = machine;
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const legacy = await legacyCodexInstall(machine, join(base, 'codex'));
  const all = [...BUNDLED, 'my-repos'].sort();
  assert.deepEqual((await readdir(legacy)).sort(), all);
  await writeFile(join(legacy, 'independent-review/SKILL.md'), 'edited by hand');
  const upgraded = await agents('install', '--agent', 'codex');
  assert.equal(upgraded.code, 0, JSON.stringify(upgraded.error));
  const shared = join(env.HOME, '.agents/skills');
  assert.deepEqual((await readdir(shared)).sort(), all);
  assert.deepEqual(await readdir(legacy), ['independent-review']);
  assert.equal(await readFile(join(legacy, 'independent-review/SKILL.md'), 'utf8'), 'edited by hand');
  const moves = upgraded.json.results.filter(item => item.kind === 'skill' && item.path.startsWith(legacy));
  assert.deepEqual(moves.map(item => [item.name, item.action, item.code]).sort(),
    all.map(name => name === 'independent-review' ? [name, 'kept', 'SKILL_EDITED'] : [name, 'moved', undefined]));
  assert.equal(moves.find(item => item.name === 'my-repos').to, join(shared, 'my-repos'));
  const kept = moves.find(item => item.name === 'independent-review');
  assert.match(kept.reason, /edited since install/);
  assert.equal(kept.replacement, join(shared, 'independent-review'));
  // The edited copy keeps its record; everything else is recorded once, in the shared location.
  assert.deepEqual((await records(workspace)).filter(item => item.path.startsWith(legacy)).map(item => item.name), ['independent-review']);
  const status = await agents('status');
  assert.deepEqual(status.json.items.filter(item => item.name === 'independent-review').map(item => [item.path, item.state]).sort(),
    [[join(legacy, 'independent-review'), 'changed'], [join(shared, 'independent-review'), 'installed']]);
  // Nothing left to move: the next install changes nothing, and uninstall still keeps the edit.
  const again = await agents('install', '--agent', 'codex');
  assert.ok(again.json.results.filter(item => item.kind === 'skill').every(item => ['unchanged', 'kept'].includes(item.action)));
  const removed = await agents('uninstall');
  assert.deepEqual(byAction(removed.json.results.filter(item => item.path?.startsWith(legacy))), { 'codex:skill:independent-review': 'kept' });
  assert.deepEqual(await readdir(shared), []);
});

// spec: agent-installation / Destination blocked
test('a foreign or edited shared copy keeps that legacy Codex copy, and the rest move', async t => {
  const machine = await fixture(t);
  const { base, env, workspace, agents } = machine;
  const shared = join(env.HOME, '.agents/skills');
  const legacy = await legacyCodexInstall(machine, join(base, 'codex'));
  // Gemini CLI installed the shared copies since; one was edited, and one is foreign: its record is gone.
  assert.equal((await agents('install', '--agent', 'gemini')).code, 0);
  await writeFile(join(shared, 'slice-change/SKILL.md'), 'edited for Gemini');
  await writeFile(join(shared, 'reflect/SKILL.md'), 'mine');
  const file = join(workspace, '.state/agents.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.items = state.items.filter(item => item.path !== join(shared, 'reflect'));
  await writeFile(file, JSON.stringify(state));

  const result = await agents('install', '--agent', 'codex');
  assert.equal(result.code, 0, JSON.stringify(result.error));
  const moves = Object.fromEntries(result.json.results.filter(item => item.kind === 'skill' && item.path.startsWith(legacy)).map(item => [item.name, item]));
  assert.deepEqual([moves.reflect.action, moves.reflect.code], ['kept', 'SKILL_FOREIGN']);
  assert.match(moves.reflect.reason, /was not installed by Context Kit/);
  assert.deepEqual([moves['slice-change'].action, moves['slice-change'].code], ['kept', 'SKILL_EDITED']);
  assert.match(moves['slice-change'].reason, /edited since install/);
  for (const name of BUNDLED.filter(name => !['reflect', 'slice-change'].includes(name))) assert.equal(moves[name].action, 'moved', name);
  assert.deepEqual((await readdir(legacy)).sort(), ['reflect', 'slice-change']);
  assert.equal(await readFile(join(shared, 'reflect/SKILL.md'), 'utf8'), 'mine');
  assert.equal(await readFile(join(shared, 'slice-change/SKILL.md'), 'utf8'), 'edited for Gemini');
  assert.deepEqual((await records(workspace)).filter(item => item.path.startsWith(legacy)).map(item => item.name).sort(), ['reflect', 'slice-change']);
  // The shared copies Gemini CLI already had now serve Codex too.
  assert.deepEqual((await records(workspace)).find(item => item.path === join(shared, 'context-kit')).agents, ['gemini', 'codex']);
});

// spec: agent-installation / Destination blocked
test('an unwritable or symlinked shared directory keeps every legacy Codex copy and its record', async t => {
  for (const blocked of ['unwritable', 'symlinked']) {
    if (blocked === 'unwritable' && process.getuid?.() === 0) continue;
    const machine = await fixture(t);
    const { base, env, workspace, agents } = machine;
    const legacy = await legacyCodexInstall(machine, join(base, 'codex'));
    const before = await records(workspace);
    const elsewhere = join(base, 'elsewhere');
    if (blocked === 'unwritable') {
      await mkdir(join(env.HOME, '.agents/skills'), { recursive: true });
      await chmod(join(env.HOME, '.agents/skills'), 0o555);
    } else {
      await mkdir(elsewhere);
      await rm(join(env.HOME, '.agents'), { recursive: true });
      await symlink(elsewhere, join(env.HOME, '.agents'));
    }
    const result = await agents('install', '--agent', 'codex');
    assert.equal(result.code, 0, JSON.stringify(result.error));
    const code = blocked === 'unwritable' ? 'NOT_WRITABLE' : 'SYMLINKED_PATH';
    const shared = result.json.results.filter(item => item.kind === 'skill' && !item.path.startsWith(legacy));
    assert.ok(shared.length && shared.every(item => item.action === 'failed' && item.code === code), JSON.stringify(shared));
    const kept = result.json.results.filter(item => item.kind === 'skill' && item.path.startsWith(legacy));
    assert.deepEqual(kept.map(item => item.name).sort(), BUNDLED);
    assert.ok(kept.every(item => item.action === 'kept' && item.code === code && /was not installed/.test(item.reason)), JSON.stringify(kept));
    assert.deepEqual((await readdir(legacy)).sort(), BUNDLED);
    assert.deepEqual(await records(workspace), before);
    if (blocked === 'symlinked') assert.deepEqual(await readdir(elsewhere), [], 'nothing written through the link');
    assert.ok((await agents('status')).json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
    if (blocked === 'unwritable') {
      // Once it is writable again, the move completes.
      await chmod(join(env.HOME, '.agents/skills'), 0o755);
      const retried = await agents('install', '--agent', 'codex');
      assert.ok(retried.json.results.filter(item => item.kind === 'skill' && item.path.startsWith(legacy)).every(item => item.action === 'moved'));
      assert.deepEqual(await readdir(legacy), []);
    }
  }
});

// spec: agent-installation / Codex home changed since install
test('legacy Codex copies are moved from the recorded directory, not today\'s $CODEX_HOME', async t => {
  const machine = await fixture(t);
  const { base, env, workspace, run } = machine;
  const legacy = await legacyCodexInstall(machine, join(base, 'old-codex-home'));
  // Today's default Codex home holds a skill of the same name that Context Kit never wrote.
  await mkdir(join(env.HOME, '.codex/skills/reflect'), { recursive: true });
  await writeFile(join(env.HOME, '.codex/skills/reflect/SKILL.md'), 'mine');
  const result = await run(['--root', workspace, 'agents', 'install', '--agent', 'codex'], { CODEX_HOME: '' });
  assert.equal(result.code, 0, JSON.stringify(result.error));
  assert.deepEqual(await readdir(legacy), []);
  assert.ok(result.json.results.filter(item => item.kind === 'skill' && item.path.startsWith(legacy)).every(item => item.action === 'moved'));
  assert.deepEqual(await readdir(join(env.HOME, '.codex/skills')), ['reflect']);
  assert.equal(await readFile(join(env.HOME, '.codex/skills/reflect/SKILL.md'), 'utf8'), 'mine');
  assert.deepEqual((await readdir(join(env.HOME, '.agents/skills'))).sort(), BUNDLED);
});
