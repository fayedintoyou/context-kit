import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, cp, lstat, mkdtemp, mkdir, writeFile, readFile, readdir, link, rename, rm, realpath, symlink, utimes } from 'node:fs/promises';
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
  assert.equal(status.json.items.length, 18);
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
  // The launcher serves every agent, so it stays while an edited skill is kept.
  assert.deepEqual((await agents('status')).json.items.map(item => [item.agent, item.name, item.state]), [['codex', 'independent-review', 'changed'], [undefined, 'context-kit', 'installed']]);
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
  assert.deepEqual(result.json.agents.results.map(item => `${item.kind}:${item.name}:${item.action}`), ['launcher:context-kit:installed', 'skill:context-kit:installed', 'skill:reflect:installed', 'mcp:my-context:installed',
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
// The old core kept Codex's five keys, the standard set less `compatibility`. No bundled skill
// declares `compatibility`, so its copies were byte-identical to today's shared ones.
async function legacyCodexInstall({ env, workspace, agents }, codexHome) {
  for (const name of BUNDLED) assert.doesNotMatch(await readFile(join(kit, 'skills', name, 'SKILL.md'), 'utf8'), /^compatibility:/m, name);
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

// spec: agent-installation / Upgrade an existing Codex install
test('a hook that cannot be written still leaves the move recorded, so the next install is clean', async t => {
  if (process.getuid?.() === 0) return t.skip('permissions do not bind root');
  const machine = await fixture(t);
  const { base, env, workspace, agents } = machine;
  const legacy = await legacyCodexInstall(machine, join(base, 'codex'));
  await promisify(execFile)('git', ['init', '-q'], { cwd: workspace });
  const hooks = join(workspace, '.git/hooks');
  await mkdir(hooks, { recursive: true });
  await chmod(hooks, 0o555);
  const upgraded = await agents('install', '--agent', 'codex');
  await chmod(hooks, 0o755);
  assert.equal(upgraded.code, 0, JSON.stringify(upgraded.error));
  assert.deepEqual(upgraded.json.results.filter(item => item.kind === 'hook').map(item => [item.name, item.action, item.code]),
    [['post-merge', 'failed', 'NOT_WRITABLE'], ['post-rewrite', 'failed', 'NOT_WRITABLE']]);
  assert.deepEqual(await readdir(legacy), []);
  const shared = join(env.HOME, '.agents/skills');
  assert.deepEqual((await records(workspace)).map(item => item.path).sort(), BUNDLED.map(name => join(shared, name)));
  const again = await agents('install', '--agent', 'codex');
  assert.ok(again.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'unchanged'), JSON.stringify(again.json.results));
  assert.deepEqual(again.json.results.filter(item => item.kind === 'hook').map(item => item.action), ['installed', 'installed']);
  const removed = await agents('uninstall');
  assert.ok(removed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'removed'));
  assert.deepEqual(await readdir(shared), []);
});

test('install sweeps copies an interrupted install left behind, but not recent ones', async t => {
  const { env, agents } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  // Age comes from the creation time in the name: a set-aside copy keeps its old mtime.
  const stale = join(shared, `.context-kit-reflect-123-${Date.now() - 2 * 3600000}-old`);
  const recent = join(shared, `.context-kit-reflect-456-${Date.now()}-old`);
  for (const path of [stale, recent]) { await mkdir(path); await writeFile(join(path, 'SKILL.md'), 'left over'); }
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600000);
  await utimes(recent, yearAgo, yearAgo);
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  assert.equal(await exists(stale), false);
  assert.ok(await exists(recent));
});

// spec: agent-installation / Upgrade an existing Codex install
test('records that cannot be written stop the install before any legacy copy is deleted', async t => {
  if (process.getuid?.() === 0) return t.skip('permissions do not bind root');
  const machine = await fixture(t);
  const { base, env, workspace, agents } = machine;
  const legacy = await legacyCodexInstall(machine, join(base, 'codex'));
  const file = join(workspace, '.state/agents.json');
  const before = await readFile(file, 'utf8');
  await chmod(file, 0o444);
  const refused = await agents('install', '--agent', 'codex');
  await chmod(file, 0o644);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.error.code, 'RECORDS_UNWRITABLE');
  assert.match(refused.error.message, /nothing was changed/);
  assert.deepEqual((await readdir(legacy)).sort(), BUNDLED);
  assert.equal(await exists(join(env.HOME, '.agents/skills')), false);
  assert.equal(await readFile(file, 'utf8'), before);
  const upgraded = await agents('install', '--agent', 'codex');
  assert.ok(upgraded.json.results.filter(item => item.kind === 'skill' && item.path.startsWith(legacy)).every(item => item.action === 'moved'));
  assert.deepEqual(await readdir(legacy), []);
});

test('records are replaced by rename, never rewritten in place', async t => {
  const { workspace, agents } = await fixture(t);
  assert.equal((await agents('install', '--agent', 'claude')).code, 0);
  const file = join(workspace, '.state/agents.json');
  // A hard link keeps the old file: a rename leaves it whole, an in-place write would change it.
  const probe = join(workspace, '.state/probe.json');
  await link(file, probe);
  const before = await readFile(probe, 'utf8');
  await workspaceAddon(workspace);
  assert.equal((await agents('install', '--agent', 'claude')).code, 0);
  assert.equal(await readFile(probe, 'utf8'), before);
  assert.notEqual(await readFile(file, 'utf8'), before);
  assert.ok(JSON.parse(await readFile(file, 'utf8')).items.some(item => item.name === 'house-style'));
  assert.deepEqual((await readdir(join(workspace, '.state'))).filter(name => name.startsWith('agents.json.')), []);
});

// spec: agent-installation / Existing hooks are kept
test('a hook that cannot be read is reported and never replaced', async t => {
  if (process.getuid?.() === 0) return t.skip('permissions do not bind root');
  const { base, workspace, agents } = await fixture(t);
  await gitWorkspace(base, workspace);
  const hook = join(workspace, '.git/hooks/post-merge');
  await writeFile(hook, '#!/bin/sh\necho mine\n');
  await chmod(hook, 0o000);
  const installed = await agents('install', '--agent', 'claude');
  await chmod(hook, 0o755);
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const hooks = Object.fromEntries(installed.json.results.filter(item => item.kind === 'hook').map(item => [item.name, item]));
  assert.deepEqual([hooks['post-merge'].action, hooks['post-merge'].code], ['failed', 'NOT_READABLE']);
  assert.equal(hooks['post-rewrite'].action, 'installed');
  assert.equal(await readFile(hook, 'utf8'), '#!/bin/sh\necho mine\n');
});

test('an invalid server name fails before anything is written', async t => {
  const { base, env, workspace, agents } = await fixture(t);
  const result = await agents('install', '--name', 'Not Kebab');
  assert.equal(result.error.code, 'INVALID_INPUT');
  assert.equal(await exists(join(base, 'claude/skills')), false);
  assert.equal(await exists(join(env.HOME, '.agents')), false);
  assert.equal(await exists(join(workspace, '.state/agents.json')), false);
});

// Runs the CLI with a preload that SIGKILLs it at the first skill swap into a directory under
// `inside`, just before or just after the rename: before its records are saved, as a power cut
// would. The workspace defaults to the fixture's.
async function killedAtFirstSwap(machine, args, { inside = '/.agents/skills/', when = 'after', root = machine.workspace } = {}) {
  const preload = join(machine.base, 'kill-at-swap.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const rename = fs.rename;
fs.rename = async (from, to) => {
  const swap = String(to).includes(process.env.KILL_INSIDE) && !basename(String(to)).startsWith('.');
  if (swap && process.env.KILL_WHEN === 'before') process.kill(process.pid, 'SIGKILL');
  const result = await rename(from, to);
  if (swap && process.env.KILL_WHEN === 'after') process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
`);
  return promisify(execFile)(process.execPath, ['--import', preload, join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env: { ...machine.env, KILL_INSIDE: inside, KILL_WHEN: when } })
    .then(() => 'finished', error => error.signal);
}
const killedAfterFirstSwap = (machine, args) => killedAtFirstSwap(machine, args);

// spec: agent-installation / Upgrade an existing Codex install
test('an install killed right after a swap is completed by the next, without --force', async t => {
  const machine = await fixture(t);
  const { base, env, workspace, agents } = machine;
  const legacy = await legacyCodexInstall(machine, join(base, 'codex'));
  assert.equal(await killedAfterFirstSwap(machine, ['agents', 'install', '--agent', 'codex']), 'SIGKILL');
  const shared = join(env.HOME, '.agents/skills');
  const placed = (await readdir(shared)).filter(name => !name.startsWith('.'));
  assert.equal(placed.length, 1);
  assert.equal((await agents('status')).json.items.find(item => item.path === join(shared, placed[0])).state, 'installed');
  const recovered = await agents('install', '--agent', 'codex');
  assert.equal(recovered.code, 0, JSON.stringify(recovered.error));
  const first = recovered.json.results.find(item => item.path === join(shared, placed[0]));
  assert.deepEqual([first.action, first.recovered], ['unchanged', true]);
  assert.ok(recovered.json.results.filter(item => item.kind === 'skill').every(item => !item.code), JSON.stringify(recovered.json.results));
  assert.deepEqual(await readdir(legacy), []);
  assert.deepEqual((await records(workspace)).map(item => item.path).sort(), BUNDLED.map(name => join(shared, name)));
  assert.ok((await agents('status')).json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
});

// spec: agent-installation / Foreign and edited skills are preserved
test('an identical copy Context Kit never placed is not claimed, and survives install and uninstall', async t => {
  const { env, agents } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  await mkdir(shared, { recursive: true });
  await promisify(execFile)('cp', ['-R', join(kit, 'skills/independent-review'), join(shared, 'independent-review')]);
  const installed = await agents('install', '--agent', 'codex');
  const mine = skillResults(installed.json.results, 'independent-review')[0];
  assert.deepEqual([mine.action, mine.code], ['conflict', 'SKILL_FOREIGN']);
  const removed = await agents('uninstall');
  assert.equal(skillResults(removed.json.results, 'independent-review').length, 0);
  assert.deepEqual(await readdir(shared), ['independent-review']);
});

// spec: agent-installation / Foreign and edited skills are preserved
test('a second workspace does not claim the first one\'s shared copies', async t => {
  const machine = await fixture(t);
  const { base, env, run, agents } = machine;
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  const second = join(base, 'second');
  await run(['init', second]);
  // Its own launcher directory: the one-workspace rule is about the launcher, not these copies.
  const own = { XDG_BIN_HOME: join(base, 'bin-second') };
  const theirs = await run(['--root', second, 'agents', 'install', '--agent', 'codex'], own);
  assert.ok(theirs.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'conflict' && item.code === 'SKILL_FOREIGN'));
  await run(['--root', second, 'agents', 'uninstall'], own);
  assert.deepEqual((await readdir(join(env.HOME, '.agents/skills'))).sort(), BUNDLED);
  assert.ok((await agents('status')).json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
});

// spec: agent-installation / Iterate on a linked skill
test('a kill right after a swap between --link and copy is completed by the next install, both ways', async t => {
  for (const [from, to] of [[[], ['--link']], [['--link'], []]]) {
    const machine = await fixture(t);
    const { base, agents } = machine;
    const skills = join(base, 'claude/skills');
    assert.equal((await agents('install', '--agent', 'claude', ...from)).code, 0);
    assert.equal(await killedAtFirstSwap(machine, ['agents', 'install', '--agent', 'claude', ...to], { inside: '/claude/skills/' }), 'SIGKILL', `${from} -> ${to}`);
    const status = await agents('status');
    assert.ok(status.json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'), JSON.stringify(status.json.items));
    const recovered = await agents('install', '--agent', 'claude', ...to);
    const skillsOut = recovered.json.results.filter(item => item.kind === 'skill');
    assert.ok(skillsOut.every(item => !item.code), JSON.stringify(skillsOut));
    assert.equal(skillsOut.filter(item => item.recovered).length, 1, `${from} -> ${to}`);
    const linked = to.includes('--link');
    for (const name of BUNDLED) assert.equal((await lstat(join(skills, name))).isSymbolicLink(), linked, `${name} ${from} -> ${to}`);
    const removed = await agents('uninstall');
    assert.ok(removed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'removed'));
    assert.deepEqual((await readdir(skills)).filter(name => !name.startsWith('.')), []);
  }
});

// spec: agent-installation / Foreign and edited skills are preserved
test('a workspace killed before its swap does not claim the copy another workspace put there', async t => {
  const machine = await fixture(t);
  const { base, env, run, workspace } = machine;
  const shared = join(env.HOME, '.agents/skills');
  assert.equal(await killedAtFirstSwap(machine, ['agents', 'install', '--agent', 'codex'], { when: 'before' }), 'SIGKILL');
  const pending = JSON.parse(await readFile(join(workspace, '.state/agents.json'), 'utf8')).items.find(item => item.pending);
  assert.ok(pending, 'a pending record was saved before the swap');
  const second = join(base, 'second');
  await run(['init', second]);
  // Its own launcher directory: the one-workspace rule is about the launcher, not these copies.
  const own = { XDG_BIN_HOME: join(base, 'bin-second') };
  assert.equal((await run(['--root', second, 'agents', 'install', '--agent', 'codex'], own)).code, 0);
  // Same version, so the same bytes: only the inode tells the copies apart.
  const again = await run(['--root', workspace, 'agents', 'install', '--agent', 'codex']);
  const theirs = again.json.results.find(item => item.path === pending.path);
  assert.deepEqual([theirs.action, theirs.code], ['conflict', 'SKILL_FOREIGN']);
  await run(['--root', workspace, 'agents', 'uninstall']);
  assert.ok(await exists(pending.path));
  const status = await run(['--root', second, 'agents', 'status'], own);
  assert.ok(status.json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
  assert.deepEqual((await readdir(shared)).filter(name => !name.startsWith('.')).sort(), BUNDLED);
});

// Runs a file the way an agent's shell would, from a directory unrelated to the workspace.
async function launch(file, args, env, cwd) {
  try { return { code: 0, json: JSON.parse((await exec(file, args, { env, cwd })).stdout) }; }
  catch (error) { return { code: error.code, error: error.stderr ? JSON.parse(error.stderr).error : error.message }; }
}
const launcherItem = items => items.find(item => item.kind === 'launcher');
const routingBody = async path => (await readFile(join(path, 'SKILL.md'), 'utf8')).split('\n---\n').slice(1).join('\n---\n');

// spec: agent-installation / Run from anywhere
test('the launcher runs the workspace from any directory, with or without its directory on PATH', async t => {
  const { base, env, workspace, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const elsewhere = join(base, 'elsewhere');
  await mkdir(elsewhere);
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const launcher = join(env.HOME, '.local/bin/context-kit');
  assert.deepEqual([launcherItem(installed.json.results).path, launcherItem(installed.json.results).action, launcherItem(installed.json.results).onPath], [launcher, 'installed', false]);
  assert.equal((await lstat(launcher)).mode & 0o777, 0o755);
  // No node on this PATH: the launcher names this machine's Node itself.
  const listed = await launch(launcher, ['repos'], { HOME: env.HOME, PATH: '/usr/bin:/bin' }, elsewhere);
  assert.equal(listed.code, 0, JSON.stringify(listed.error));
  assert.deepEqual([listed.json.root, listed.json.repositories.map(item => item.id)], [workspace, ['personal/main/room']]);
  let status = launcherItem((await agents('status')).json.items);
  assert.deepEqual([status.state, status.onPath], ['installed', false]);
  assert.match(status.reason, /is not on PATH; add export PATH=/);
  // Off PATH, the skill names the launcher by its absolute path.
  assert.ok((await routingBody(join(base, 'claude/skills/my-repos'))).includes(`\`${launcher} repos\``));

  // With its directory on PATH, `context-kit` alone works at a shell, but the skill keeps the
  // absolute path: agent apps started outside a shell may not have that PATH.
  const onPath = { PATH: `${dirname(launcher)}:${env.PATH}` };
  const again = await run(['--root', workspace, 'agents', 'install'], onPath);
  assert.equal(launcherItem(again.json.results).action, 'unchanged');
  assert.equal(launcherItem(again.json.results).onPath, true);
  status = launcherItem((await run(['--root', workspace, 'agents', 'status'], onPath)).json.items);
  assert.deepEqual([status.state, status.onPath], ['installed', true]);
  const body = await routingBody(join(env.HOME, '.agents/skills/my-repos'));
  assert.ok(body.includes(`\`${launcher} repos\`. Both work from any directory. At a terminal,\n\`context-kit\` is the same launcher`), body);
  const bare = await launch('/bin/sh', ['-c', 'context-kit repos'], { HOME: env.HOME, PATH: `${dirname(launcher)}:/usr/bin:/bin` }, elsewhere);
  assert.deepEqual(bare.json.repositories.map(item => item.id), ['personal/main/room']);

  const removed = await agents('uninstall');
  assert.equal(launcherItem(removed.json.results).action, 'removed');
  assert.equal(await exists(launcher), false);
  async function run(args, extra) {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env: { ...env, ...extra }, cwd: base })).stdout) }; }
    catch (error) { return { code: error.code, error: error.stderr }; }
  }
});

// spec: agent-installation / Foreign launcher
test('install never overwrites a context-kit it did not write, nor writes through a symlinked directory', async t => {
  const { base, env, workspace, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const launcher = join(env.HOME, '.local/bin/context-kit');
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, '#!/bin/sh\necho mine\n', { mode: 0o755 });
  const installed = await agents('install');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const conflict = launcherItem(installed.json.results);
  assert.equal(conflict.action, 'conflict');
  assert.match(conflict.reason, new RegExp(`${launcher} exists and was not written by Context Kit; remove it or pass --force`));
  assert.equal(await readFile(launcher, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.deepEqual(await readdir(dirname(launcher)), ['context-kit'], 'no temporary files left');
  // The skill must not send agents to someone else's context-kit; it names the core directly.
  const body = await routingBody(join(base, 'claude/skills/my-repos'));
  assert.ok(!body.includes(`${launcher} `) && !body.includes('`context-kit '), body);
  assert.ok(body.includes(`${process.execPath} ${join(kit, 'bin/hub.mjs')} --root ${workspace} repos`), body);
  assert.doesNotMatch(body, /\bcd\s/);
  assert.equal(launcherItem((await agents('status')).json.items), undefined);
  await agents('uninstall');
  assert.equal(await readFile(launcher, 'utf8'), '#!/bin/sh\necho mine\n');

  const forced = await agents('install', '--force');
  assert.equal(launcherItem(forced.json.results).action, 'updated');
  assert.match(await readFile(launcher, 'utf8'), /Managed by Context Kit/);
  await agents('uninstall');
  assert.equal(await exists(launcher), false);

  // A symlink among the launcher directory's components below HOME: nothing is written through it.
  const target = join(base, 'elsewhere-local');
  await mkdir(target);
  await rm(join(env.HOME, '.local'), { recursive: true });
  await symlink(target, join(env.HOME, '.local'));
  const refused = launcherItem((await agents('install')).json.results);
  assert.equal(refused.action, 'refused');
  assert.match(refused.reason, /\.local is a symbolic link/);
  assert.deepEqual(await readdir(target), []);
});

// spec: agent-installation / Second workspace
test('a second workspace is refused with WORKSPACE_CONFLICT before writing, and --force takes over', async t => {
  const { base, env, workspace, run, calls, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  assert.equal((await agents('install')).code, 0);
  const second = join(base, 'second');
  assert.equal((await run(['init', second])).code, 0);
  await repository(second, 'garden', { title: 'the garden', resource: 'https://github.com/me/garden' });
  const launcher = join(env.HOME, '.local/bin/context-kit');
  const snapshot = async () => [await readFile(launcher, 'utf8'), await readFile(join(base, 'claude/skills/my-repos/SKILL.md'), 'utf8'),
    await readFile(join(env.HOME, '.agents/skills/my-repos/SKILL.md'), 'utf8'), (await readdir(join(base, 'claude/skills'))).sort(), (await calls()).length];
  const before = await snapshot();
  const refused = await run(['--root', second, 'agents', 'install']);
  assert.equal(refused.code, 1);
  assert.equal(refused.error.code, 'WORKSPACE_CONFLICT');
  assert.ok(refused.error.message.includes(`belongs to the workspace at ${workspace}`), refused.error.message);
  assert.match(refused.error.message, /--force/);
  assert.deepEqual(await snapshot(), before, 'nothing written');
  assert.equal(await exists(join(second, '.state/agents.json')), false);

  const forced = await run(['--root', second, 'agents', 'install', '--force']);
  assert.equal(forced.code, 0, JSON.stringify(forced.error));
  const listed = await launch(launcher, ['repos'], { HOME: env.HOME, PATH: '/usr/bin:/bin' }, base);
  assert.deepEqual([listed.json.root, listed.json.repositories.map(item => item.id)], [second, ['personal/main/garden']]);
  // Claude Code's copy and the shared one Codex reads.
  for (const agent of [join(base, 'claude/skills'), join(env.HOME, '.agents/skills')]) {
    const text = await readFile(join(agent, 'my-repos/SKILL.md'), 'utf8');
    assert.match(text, /the garden/);
    assert.ok(text.includes(`- Workspace: ${second}\n`), agent);
  }
  // The first workspace's other items are left alone: its MCP server is still registered.
  const servers = JSON.parse(await readFile(join(base, 'claude-servers.json'), 'utf8'));
  assert.deepEqual(Object.keys(servers).sort(), ['context-second', 'context-workspace']);
});

// spec: agent-installation / Move and repair
test('a moved workspace reports moved, its old launcher fails naming it, and one install repairs everything', async t => {
  const { base, env, run } = await fixture(t);
  const before = join(base, 'mon espace ü');
  assert.equal((await run(['init', before])).code, 0);
  await repository(before, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const installed = await run(['--root', before, 'agents', 'install']);
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const launcher = join(env.HOME, '.local/bin/context-kit');
  const after = join(base, 'moved 🌊 dir');
  await exec('mv', [before, after]);

  const status = await run(['--root', after, 'agents', 'status']);
  assert.equal(status.code, 0, JSON.stringify(status.error));
  const state = (kind, name) => status.json.items.filter(item => item.kind === kind && item.name === name).map(item => [item.agent, item.state, item.from]);
  assert.deepEqual(state('mcp', 'context-mon-espace'), [['claude', 'moved', before], ['codex', 'moved', before]]);
  assert.deepEqual(state('launcher', 'context-kit'), [[undefined, 'moved', before]]);
  assert.deepEqual(state('skill', 'my-repos'), [['claude', 'moved', before], ['codex', 'moved', before]]);

  const elsewhere = join(base, 'elsewhere');
  await mkdir(elsewhere);
  const stale = await launch(launcher, ['repos'], { HOME: env.HOME, PATH: '/usr/bin:/bin' }, elsewhere);
  assert.equal(stale.code, 1);
  assert.equal(stale.error.code, 'WORKSPACE_MOVED');
  assert.ok(stale.error.message.includes(before), stale.error.message);

  const repaired = await run(['--root', after, 'agents', 'install']);
  assert.equal(repaired.code, 0, JSON.stringify(repaired.error));
  assert.deepEqual(repaired.json.results.filter(item => item.action === 'removed').map(item => [item.agent, item.kind, item.name]),
    [['claude', 'mcp', 'context-mon-espace'], ['codex', 'mcp', 'context-mon-espace']]);
  const listed = await launch(launcher, ['repos'], { HOME: env.HOME, PATH: '/usr/bin:/bin' }, elsewhere);
  assert.equal(listed.code, 0, JSON.stringify(listed.error));
  assert.deepEqual([listed.json.root, listed.json.repositories.map(item => item.id)], [after, ['personal/main/room']]);
  const fixed = await run(['--root', after, 'agents', 'status']);
  assert.ok(fixed.json.items.every(item => item.state === 'installed'), JSON.stringify(fixed.json.items.filter(item => item.state !== 'installed')));
  assert.deepEqual(fixed.json.items.filter(item => item.kind === 'mcp').map(item => [item.agent, item.name]), [['claude', 'context-moved-dir'], ['codex', 'context-moved-dir']]);
  for (const agent of ['claude', 'codex']) {
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(base, `${agent}-servers.json`), 'utf8'))), ['context-moved-dir'], agent);
    const copy = agent === 'claude' ? join(base, 'claude/skills') : join(env.HOME, '.agents/skills');
    assert.ok((await readFile(join(copy, 'my-repos/SKILL.md'), 'utf8')).includes(`- Workspace: ${after}\n`));
  }
});

// spec: agent-installation / Move and repair
test('records written before roots were recorded, with the core inside the workspace, are repaired after a move', async t => {
  const { base, env } = await fixture(t);
  const before = join(base, "legacy it's ws");
  const core = ws => join(ws, 'node_modules/context-kit');
  const hub = async (ws, ...args) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(core(ws), 'bin/hub.mjs'), ...args], { env, cwd: base })).stdout) }; }
    catch (error) { return { code: error.code, error: error.stderr }; }
  };
  assert.equal((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', before], { env })).stderr, '');
  // The workspace's own pinned core, as npm install puts it, and a git checkout for the hooks.
  for (const name of ['bin', 'lib', 'skills', 'addons', 'package.json']) await cp(join(kit, name), join(core(before), name), { recursive: true });
  await symlink(join(kit, 'node_modules'), join(core(before), 'node_modules'));
  await exec('git', ['init', '-q'], { cwd: before });
  await repository(before, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  const installed = await hub(before, '--root', before, 'agents', 'install');
  assert.equal(installed.code, 0, installed.error);
  const recordsFile = join(before, '.state/agents.json');
  const records = JSON.parse(await readFile(recordsFile, 'utf8'));
  await writeFile(recordsFile, JSON.stringify({ ...records, items: records.items.map(({ root, ...item }) => item) }));

  const after = join(base, 'moved legacy');
  await exec('mv', [before, after]);
  const status = await hub(after, '--root', after, 'agents', 'status');
  const states = kind => status.json.items.filter(item => item.kind === kind).map(item => item.state);
  assert.deepEqual(states('guard'), ['moved']);
  assert.deepEqual(states('hook'), ['moved', 'moved']);
  assert.deepEqual(states('mcp'), ['moved', 'moved']);

  const repaired = await hub(after, '--root', after, 'agents', 'install');
  assert.equal(repaired.code, 0, repaired.error);
  const settings = join(base, 'claude/settings.json');
  const entries = JSON.parse(await readFile(settings, 'utf8')).hooks.PreToolUse;
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.ok(entries[0].hooks[0].command.includes(join(core(after), 'bin/merge-guard.mjs')));
  const fixed = await hub(after, '--root', after, 'agents', 'status');
  assert.ok(fixed.json.items.every(item => item.state === 'installed'), JSON.stringify(fixed.json.items.filter(item => item.state !== 'installed')));

  const removed = await hub(after, '--root', after, 'agents', 'uninstall');
  assert.equal(removed.code, 0, removed.error);
  assert.deepEqual(JSON.parse(await readFile(join(after, '.state/agents.json'), 'utf8')).items, []);
  assert.equal(await exists(settings), false, 'the settings file the install created is gone');
  assert.equal(await exists(join(env.HOME, '.local/bin/context-kit')), false);
  assert.deepEqual(await readdir(join(base, 'claude/skills')), []);
  for (const agent of ['claude', 'codex']) assert.deepEqual(JSON.parse(await readFile(join(base, `${agent}-servers.json`), 'utf8')), {}, agent);
  assert.deepEqual((await readdir(join(after, '.git/hooks'))).filter(name => ['post-merge', 'post-rewrite'].includes(name)), []);
});

// spec: repository-registry / Remedies use the launcher
// spec: agent-installation / Second workspace
test('a workspace path with a backtick and a newline keeps the skill\'s commands runnable and its owner readable', async t => {
  const { base, env, run, agents } = await fixture(t);
  const odd = join(base, 'odd `tick`\nline');
  assert.equal((await run(['init', odd])).code, 0);
  await repository(odd, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  // Without its launcher (a foreign file is in the way), the skill names the core and the root by path.
  const launcher = join(env.HOME, '.local/bin/context-kit');
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, 'mine\n');
  assert.equal((await run(['--root', odd, 'agents', 'install', '--agent', 'claude'])).code, 0);
  const text = await readFile(join(base, 'claude/skills/my-repos/SKILL.md'), 'utf8');
  const read = text.match(/- the room: `` (.+? read personal\/main room) ``/s)?.[1];
  assert.ok(read, text);
  const { stdout } = await exec('/bin/sh', ['-c', read], { cwd: base, env: { HOME: env.HOME, PATH: '/usr/bin:/bin' } });
  assert.equal(JSON.parse(stdout).okf.title, 'the room');
  assert.ok(text.includes(`- Workspace: ${JSON.stringify(odd)}\n`));
  // Another workspace reads that skill's owner exactly.
  const refused = await agents('install', '--agent', 'claude');
  assert.equal(refused.error.code, 'WORKSPACE_CONFLICT');
  assert.ok(refused.error.message.includes(`belongs to the workspace at ${odd};`), refused.error.message);
});

// spec: agent-installation / Second workspace
test('a routing skill in the shared ~/.agents/skills location alone also makes a second workspace conflict', async t => {
  const { base, env, workspace, run, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  await rm(join(env.HOME, '.local/bin/context-kit'));
  const second = join(base, 'second');
  assert.equal((await run(['init', second])).code, 0);
  const refused = await run(['--root', second, 'agents', 'install', '--agent', 'claude']);
  assert.equal(refused.error.code, 'WORKSPACE_CONFLICT');
  assert.ok(refused.error.message.startsWith(`${join(env.HOME, '.agents/skills/my-repos')} belongs to the workspace at ${workspace};`), refused.error.message);
  assert.equal(await exists(join(base, 'claude/skills')), false, 'nothing written');});

const recordsFile = workspace => join(workspace, '.state/agents.json');
async function editRecords(workspace, edit) {
  const state = JSON.parse(await readFile(recordsFile(workspace), 'utf8'));
  state.items = state.items.map(item => item.kind === 'skill' ? edit(item) ?? item : item);
  await writeFile(recordsFile(workspace), JSON.stringify(state));
}

// spec: agent-installation / Foreign and edited skills are preserved
test('copies put back after the installed ones were deleted are not this install\'s, even when identical', async t => {
  const { base, env, workspace, agents } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  // The user deletes the installed copies and puts identical ones of their own in their place.
  const theirs = join(base, 'theirs');
  await promisify(execFile)('cp', ['-R', shared, theirs]);
  await rm(shared, { recursive: true });
  await promisify(execFile)('cp', ['-R', theirs, shared]);
  const status = await agents('status');
  assert.ok(status.json.items.filter(item => item.kind === 'skill').every(item => item.state === 'replaced'), JSON.stringify(status.json.items));
  const removed = await agents('uninstall', '--force');
  const skills = removed.json.results.filter(item => item.kind === 'skill');
  assert.ok(skills.length && skills.every(item => item.action === 'skipped' && item.code === 'SKILL_FOREIGN'), JSON.stringify(skills));
  assert.deepEqual((await readdir(shared)).sort(), BUNDLED);
  assert.deepEqual((await readFile(recordsFile(workspace), 'utf8')).includes('"kind": "skill"'), false, 'their records are dropped');
  const installed = await agents('install', '--agent', 'codex');
  assert.ok(installed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'conflict' && item.code === 'SKILL_FOREIGN'));
});

// spec: agent-installation / Foreign and edited skills are preserved
test('a workspace whose copies were deleted does not remove the identical ones another workspace installed', async t => {
  const machine = await fixture(t);
  const { base, env, run, agents } = machine;
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  await rm(shared, { recursive: true });
  const second = join(base, 'second');
  await run(['init', second]);
  assert.equal((await run(['--root', second, 'agents', 'install', '--agent', 'codex'])).code, 0);
  const removed = await agents('uninstall');
  assert.ok(removed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'skipped' && item.code === 'SKILL_FOREIGN'));
  assert.deepEqual((await readdir(shared)).sort(), BUNDLED);
  const status = await run(['--root', second, 'agents', 'status']);
  assert.ok(status.json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
});

// Linux's ext4 can give a new file the inode of a deleted one; only the birth time tells them
// apart. A subprocess can't make the kernel reuse an inode on demand, so the records are given a
// birth time the copy doesn't have, which is what such a reused inode would present.
// spec: agent-installation / Foreign and edited skills are preserved
test('a copy whose birth time differs from the recorded one is not this install\'s', async t => {
  const machine = await fixture(t);
  const { env, workspace, agents } = machine;
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  const recorded = JSON.parse(await readFile(recordsFile(workspace), 'utf8')).items.find(item => item.name === 'reflect');
  if (recorded.identity.birth === undefined) return t.skip('this file system reports no birth time');
  await editRecords(workspace, item => item.name === 'reflect' ? { ...item, identity: { ...item.identity, birth: '1' } } : null);
  assert.equal((await agents('status')).json.items.find(item => item.name === 'reflect').state, 'replaced');
  const removed = await agents('uninstall');
  assert.deepEqual(skillResults(removed.json.results, 'reflect').map(item => [item.action, item.code]), [['skipped', 'SKILL_FOREIGN']]);
  assert.ok(await exists(join(shared, 'reflect')));
  assert.equal(await exists(join(shared, 'context-kit')), false);

  // The same for an install interrupted after its swap: the pending record's birth time decides.
  const next = await fixture(t);
  assert.equal(await killedAtFirstSwap(next, ['agents', 'install', '--agent', 'codex']), 'SIGKILL');
  await editRecords(next.workspace, item => item.pending ? { ...item, pending: { ...item.pending, identity: { ...item.pending.identity, birth: '1' } } } : null);
  const pending = JSON.parse(await readFile(recordsFile(next.workspace), 'utf8')).items.find(item => item.pending);
  const again = await next.agents('install', '--agent', 'codex');
  const result = again.json.results.find(item => item.path === pending.path);
  assert.deepEqual([result.action, result.code], ['conflict', 'SKILL_FOREIGN']);
});

// spec: agent-installation / Foreign and edited skills are preserved
test('records from before identities are judged by content until the next install refreshes them', async t => {
  const { env, workspace, agents } = await fixture(t);
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  await editRecords(workspace, ({ identity: _, ...item }) => item);
  assert.ok((await agents('status')).json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
  const refreshed = await agents('install', '--agent', 'codex');
  assert.ok(refreshed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'unchanged'));
  const items = JSON.parse(await readFile(recordsFile(workspace), 'utf8')).items.filter(item => item.kind === 'skill');
  assert.ok(items.every(item => item.identity?.ino), 'every record has an identity again');
  const removed = await agents('uninstall');
  assert.ok(removed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'removed'));
  assert.deepEqual(await readdir(join(env.HOME, '.agents/skills')), []);
});

// Every configuration install reads is read before its first write, so a broken one refuses
// with INVALID_CONFIG and nothing is written: no launcher, records, skills or agent CLI calls.
test('install refuses a corrupt configuration with INVALID_CONFIG before writing anything', async t => {
  const broken = {
    'checkouts file': [async workspace => {
      await mkdir(join(workspace, '.state'), { recursive: true });
      await writeFile(join(workspace, '.state/checkouts.json'), '{ not json');
    }, /checkouts\.json/],
    'context-kit.json': [workspace => writeFile(join(workspace, 'context-kit.json'), '{ "version": 1, "addons": ['), /context-kit\.json/],
    'unknown enabled addon': [workspace => writeFile(join(workspace, 'context-kit.json'), JSON.stringify({ version: 1, addons: ['reflect', 'nonesuch'] })), /nonesuch/],
    'addon manifest': [async workspace => {
      await workspaceAddon(workspace);
      await writeFile(join(workspace, 'addons/drafting/addon.json'), '{ "name": "drafting", ');
    }, /drafting/],
  };
  for (const [label, [breakIt, message]] of Object.entries(broken)) {
    const { base, env, workspace, agents, calls } = await fixture(t);
    await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
    await breakIt(workspace);
    const refused = await agents('install');
    assert.equal(refused.code, 1, label);
    assert.equal(refused.error.code, 'INVALID_CONFIG', `${label}: ${JSON.stringify(refused.error)}`);
    assert.match(refused.error.message, message, label);
    assert.equal(await exists(join(env.HOME, '.local/bin')), false, `${label}: no launcher directory`);
    assert.equal(await exists(join(workspace, '.state/agents.json')), false, `${label}: no records`);
    assert.equal(await exists(join(base, 'claude/skills')), false, `${label}: no Claude Code skills`);
    assert.equal(await exists(join(env.HOME, '.agents')), false, `${label}: no shared skills`);
    assert.deepEqual(await calls(), [], `${label}: no agent CLI calls`);
  }
});

// spec: agent-installation / Foreign launcher
test('install sweeps launcher temporaries over an hour old by their exact name, and nothing else', async t => {
  const { env, agents } = await fixture(t);
  const directory = join(env.HOME, '.local/bin');
  await mkdir(directory, { recursive: true });
  const stale = `.context-kit.context-kit-123-${Date.now() - 2 * 3600000}`;
  const fresh = `.context-kit.context-kit-124-${Date.now() - 60000}`;
  const others = [`${stale}-x`, `.context-kit.context-kit-${Date.now() - 2 * 3600000}`, `.other.context-kit-1-${Date.now() - 2 * 3600000}`];
  for (const name of [stale, fresh, ...others]) await writeFile(join(directory, name), 'temporary\n');
  assert.equal((await agents('install')).code, 0);
  assert.deepEqual((await readdir(directory)).sort(), ['context-kit', fresh, ...others].sort());
});
