import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, cp, lstat, mkdtemp, mkdir, writeFile, readFile, readdir, link, rename, rm, realpath, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
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

// A fake Gemini CLI: logs every call and, as the real one does, keeps servers in the user
// settings file, `~/.gemini/settings.json`, which it reads with `-s user` only.
const fakeGemini = base => `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(base, 'calls.jsonl'))}, JSON.stringify({ agent: 'gemini', cwd: process.cwd(), args }) + '\\n');
const file = path.join(process.env.GEMINI_CLI_HOME || process.env.HOME, '.gemini', 'settings.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const dash = args.indexOf('--');
const head = dash < 0 ? args : args.slice(0, dash);
const scope = head[head.indexOf('-s') + 1];
const [, verb, name, command] = head.filter((arg, i) => arg !== '-s' && head[i - 1] !== '-s');
if (args[0] !== 'mcp' || head.indexOf('-s') < 0 || scope !== 'user') process.exit(2);
// A failure that prints something private, which must never reach the result.
if (process.env.FAKE_GEMINI_FAIL === verb) { process.stderr.write('PRIVATE_TOKEN=raw-error-sentinel\\n'); process.exit(17); }
settings.mcpServers ??= {};
if (verb === 'remove') delete settings.mcpServers[name];
else if (verb === 'add') settings.mcpServers[name] = { command, args: dash < 0 ? [] : args.slice(dash + 1) };
else process.exit(2);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2));
`;

// A run an hour later, when previous versions of config files Context Kit replaced or deleted
// (kept for a harness that still holds one open) may go.
const anHourLater = { CONTEXT_KIT_KEEP_PREVIOUS_MS: '0' };

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
    await writeFile(join(bin, agent), agent === 'gemini' ? fakeGemini(base) : fake(base, agent));
    await chmod(join(bin, agent), 0o755);
  }
  const env = { HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'), COPILOT_HOME: join(base, 'copilot'),
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
  return { base, env, workspace, run, calls, agents: (...args) => run(['--root', workspace, 'agents', ...args]),
    later: (...args) => run(['--root', workspace, 'agents', ...args], anHourLater) };
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
  assert.deepEqual(gemini.map(item => [item.kind, item.action, item.reason?.split(' ')[0]]), [['mcp', 'skipped', 'gemini'], ['guard', 'unsupported', 'Context']]);
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

// A restore from a backup, a migration or `cp -R` recreates every skill directory: new
// inodes, the installed content.
async function restoreCopies(base, directory) {
  const backup = join(base, `backup-${Date.now()}`);
  await promisify(execFile)('cp', ['-R', directory, backup]);
  await rm(directory, { recursive: true });
  await promisify(execFile)('cp', ['-R', backup, directory]);
}

// spec: agent-installation / Foreign and edited skills are preserved
test('restored copies with the installed content are taken back by the workspace that owns the launcher', async t => {
  const { base, env, workspace, run, agents } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room' });
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  await restoreCopies(base, shared);
  const status = await agents('status');
  const skills = status.json.items.filter(item => item.kind === 'skill');
  assert.ok(skills.every(item => item.state === 'replaced' && /agents install takes it back/.test(item.reason)), JSON.stringify(skills));
  const before = await records(workspace);
  const again = await agents('install', '--agent', 'codex');
  const results = again.json.results.filter(item => item.kind === 'skill');
  assert.ok(results.every(item => item.action === 'unchanged' && item.readopted), JSON.stringify(results));
  // The records are kept, now naming the restored copies.
  const after = await records(workspace);
  assert.deepEqual(after.map(item => item.path).sort(), before.map(item => item.path).sort());
  assert.ok((await agents('status')).json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
  // And they keep updating.
  await repository(workspace, 'garden', { title: 'the garden', resource: 'https://github.com/me/garden' });
  const synced = await run(['--root', workspace, 'repos', 'sync']);
  assert.equal(byAction(synced.json.results)['codex:skill:my-repos'], 'updated');
  assert.match(await readFile(join(shared, 'my-repos/SKILL.md'), 'utf8'), /the garden/);
});

// spec: agent-installation / Foreign and edited skills are preserved
test('a replaced copy with other content stays foreign, named on every install, and --adopt does not take it', async t => {
  const { base, env, workspace, agents } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  await restoreCopies(base, shared);
  await writeFile(join(shared, 'reflect/SKILL.md'), 'mine');
  for (const flags of [[], ['--adopt']]) {
    const result = await agents('install', '--agent', 'codex', ...flags);
    const reflect = skillResults(result.json.results, 'reflect')[0];
    assert.deepEqual([reflect.action, reflect.code, reflect.state], ['conflict', 'SKILL_REPLACED', 'replaced'], flags.join(' '));
    assert.match(reflect.reason, /different copy .* remove it and run agents install, or pass --force/);
    assert.ok(skillResults(result.json.results, 'context-kit').every(item => item.action === 'unchanged'));
  }
  assert.equal(await readFile(join(shared, 'reflect/SKILL.md'), 'utf8'), 'mine');
  assert.ok((await records(workspace)).some(item => item.name === 'reflect'), 'the record is kept');
  const removed = await agents('uninstall', '--force');
  assert.deepEqual(skillResults(removed.json.results, 'reflect').map(item => [item.action, item.code]), [['skipped', 'SKILL_REPLACED']]);
  assert.deepEqual(await readdir(shared), ['reflect']);
});

// spec: agent-installation / Foreign and edited skills are preserved
test('without the launcher, restored copies are named with --adopt, which takes back only the installed content', async t => {
  const { base, env, agents } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  // The launcher now is someone else's file, so ownership can't be shown.
  await writeFile(join(env.HOME, '.local/bin/context-kit'), '#!/bin/sh\necho mine\n');
  await restoreCopies(base, shared);
  await writeFile(join(shared, 'reflect/SKILL.md'), 'mine');
  const named = await agents('install', '--agent', 'codex');
  const kit = skillResults(named.json.results, 'context-kit')[0];
  assert.deepEqual([kit.action, kit.code], ['conflict', 'SKILL_REPLACED']);
  assert.match(kit.reason, /pass --adopt to take it back/);
  const adopted = await agents('install', '--agent', 'codex', '--adopt');
  for (const name of BUNDLED) {
    const result = skillResults(adopted.json.results, name)[0];
    if (name === 'reflect') assert.deepEqual([result.action, result.code], ['conflict', 'SKILL_REPLACED']);
    else assert.deepEqual([result.action, result.readopted], ['unchanged', true], name);
  }
  assert.equal(adopted.json.results.find(item => item.kind === 'launcher').action, 'conflict', 'the launcher is not taken over');
  assert.equal(await readFile(join(env.HOME, '.local/bin/context-kit'), 'utf8'), '#!/bin/sh\necho mine\n');
});

// spec: agent-installation / Foreign and edited skills are preserved
test('skill directories a dotfile manager replaced with symlinks to the installed content are taken back', async t => {
  const { base, env, agents } = await fixture(t);
  const shared = join(env.HOME, '.agents/skills');
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  const dotfiles = join(base, 'dotfiles/skills');
  await mkdir(dirname(dotfiles), { recursive: true });
  await rename(shared, dotfiles);
  await mkdir(shared);
  for (const name of BUNDLED) await symlink(join(dotfiles, name), join(shared, name));
  const again = await agents('install', '--agent', 'codex');
  assert.ok(again.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'unchanged' && item.readopted), JSON.stringify(again.json.results));
  assert.ok((await agents('status')).json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
  const removed = await agents('uninstall');
  assert.ok(removed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'removed'));
  assert.deepEqual(await readdir(shared), []);
  assert.deepEqual((await readdir(dotfiles)).sort(), BUNDLED, 'the dotfiles are untouched');
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
  // One workspace per user: the second takes over with --force, launcher included.
  assert.equal((await run(['--root', second, 'agents', 'install', '--agent', 'codex', '--force'])).code, 0);
  const removed = await agents('uninstall');
  assert.ok(removed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'skipped' && item.code === 'SKILL_REPLACED'), JSON.stringify(removed.json.results));
  assert.deepEqual((await readdir(shared)).sort(), BUNDLED);
  const status = await run(['--root', second, 'agents', 'status']);
  assert.ok(status.json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
});

// spec: agent-installation / Upgrade an existing Codex install
test('a legacy Codex copy replaced since install is left in place and its record dropped', async t => {
  const machine = await fixture(t);
  const { base, env, workspace, agents } = machine;
  const legacy = await legacyCodexInstall(machine, join(base, 'codex'));
  // Its records keep the identities the move kept; one copy is recreated, as a restore would.
  const backup = join(base, 'reflect-backup');
  await promisify(execFile)('cp', ['-R', join(legacy, 'reflect'), backup]);
  await rm(join(legacy, 'reflect'), { recursive: true });
  await promisify(execFile)('cp', ['-R', backup, join(legacy, 'reflect')]);
  for (const flags of [[], ['--force']]) {
    const result = await agents('install', '--agent', 'codex', ...flags);
    const reflect = result.json.results.find(item => item.path === join(legacy, 'reflect'));
    if (!flags.length) assert.deepEqual([reflect.action, reflect.code], ['skipped', 'SKILL_FOREIGN']);
    assert.ok(await exists(join(legacy, 'reflect/SKILL.md')), flags.join(' '));
  }
  assert.deepEqual(await readdir(legacy), ['reflect']);
  assert.equal((await records(workspace)).some(item => item.path === join(legacy, 'reflect')), false);
  assert.deepEqual((await readdir(join(env.HOME, '.agents/skills'))).sort(), BUNDLED);
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
  // Without the launcher's evidence, a copy that is merely the same content isn't taken back.
  await writeFile(join(env.HOME, '.local/bin/context-kit'), '#!/bin/sh\necho mine\n');
  const removed = await agents('uninstall');
  assert.deepEqual(skillResults(removed.json.results, 'reflect').map(item => [item.action, item.code]), [['skipped', 'SKILL_REPLACED']]);
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

// Device numbers aren't stable on btrfs subvolumes, NFS or in containers; with a birth time,
// inode and birth time decide. The record is given another device number, as such a remount
// would present it.
// spec: agent-installation / Foreign and edited skills are preserved
test('a changed device number alone does not make a copy replaced when birth times are kept', async t => {
  const { env, workspace, agents } = await fixture(t);
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  const recorded = JSON.parse(await readFile(recordsFile(workspace), 'utf8')).items.find(item => item.name === 'reflect');
  if (recorded.identity.birth === undefined) return t.skip('this file system reports no birth time');
  await editRecords(workspace, item => item.identity ? { ...item, identity: { ...item.identity, dev: '424242' } } : null);
  assert.ok((await agents('status')).json.items.filter(item => item.kind === 'skill').every(item => item.state === 'installed'));
  const removed = await agents('uninstall');
  assert.ok(removed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'removed'));
  assert.deepEqual(await readdir(join(env.HOME, '.agents/skills')), []);
});

// The optional global rule: Claude Code's user rules directory, $CLAUDE_CONFIG_DIR/rules.
const ruleOf = base => join(base, 'claude/rules/context-kit.md');
const ruleResults = results => results.filter(item => item.kind === 'rule');
const claudeRule = results => ruleResults(results).find(item => item.agent === 'claude');

// spec: agent-installation / Opt in
test('--global-rule writes a small Claude Code user rule naming the resolve operation, not the repositories', async t => {
  const { base, workspace, agents } = await fixture(t);
  await repository(workspace, 'room', { title: 'the room', resource: 'https://github.com/me/room', aliases: ['fayelore.com'] });
  const installed = await agents('install', '--global-rule');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  assert.deepEqual(ruleResults(installed.json.results).map(item => [item.agent, item.action]), [['codex', 'unsupported'], ['claude', 'installed']]);
  assert.match(ruleResults(installed.json.results)[0].reason, /no user rules directory/);
  const text = await readFile(ruleOf(base), 'utf8');
  assert.ok(points(text) < 600, `${points(text)} characters`);
  assert.match(text, /`list_repos` tool of the `context-workspace` MCP server/);
  assert.ok(text.includes(`${join(base, 'home/.local/bin/context-kit')} repos`), text);
  assert.doesNotMatch(text, /the room|fayelore|github\.com\/me\/room/);
  assert.doesNotMatch(text, /^---/, 'no paths frontmatter: it loads in every project');
  const status = (await agents('status')).json.items.find(item => item.kind === 'rule');
  assert.deepEqual(status, { agent: 'claude', kind: 'rule', name: 'context-kit.md', path: ruleOf(base), enabled: true, state: 'installed' });
});

// spec: agent-installation / Opt in
test('harnesses without a rules directory report the rule unsupported, and project scope writes none', async t => {
  const { base, workspace, agents } = await fixture(t);
  const others = await agents('install', '--agent', 'codex,gemini,cursor', '--global-rule');
  assert.equal(others.code, 0, JSON.stringify(others.error));
  assert.deepEqual(ruleResults(others.json.results).map(item => [item.agent, item.action]), [['codex', 'unsupported'], ['gemini', 'unsupported'], ['cursor', 'unsupported']]);
  const project = join(base, 'project');
  await mkdir(project);
  const scoped = await agents('install', '--agent', 'claude', '--scope', 'project', '--project', project, '--global-rule');
  assert.equal(claudeRule(scoped.json.results).action, 'skipped');
  assert.equal(await exists(join(base, 'claude/rules')), false);
  assert.equal(await exists(join(project, '.claude/rules')), false);
  assert.equal(JSON.parse(await readFile(recordsFile(workspace), 'utf8')).items.some(item => item.kind === 'rule'), false);
  const both = await agents('install', '--global-rule', '--no-global-rule');
  assert.equal(both.error.code, 'INVALID_INPUT');
});

// spec: agent-installation / Off unless asked
test('the rule is off unless asked, kept by plain reinstalls, and removed by --no-global-rule', async t => {
  const { base, workspace, agents } = await fixture(t);
  const plain = await agents('install');
  assert.deepEqual(ruleResults(plain.json.results), []);
  assert.equal(await exists(ruleOf(base)), false);
  assert.equal(claudeRule((await agents('install', '--global-rule')).json.results).action, 'installed');
  const again = await agents('install');
  assert.equal(claudeRule(again.json.results).action, 'unchanged');
  assert.equal(ruleResults(again.json.results).find(item => item.agent === 'codex').action, 'unsupported');
  assert.ok(await exists(ruleOf(base)));
  // A launcher that moves changes the rule's text: a plain install updates it in place.
  const moved = await agents('install', '--name', 'my-context');
  assert.equal(claudeRule(moved.json.results).action, 'updated');
  assert.match(await readFile(ruleOf(base), 'utf8'), /`my-context` MCP server/);
  const off = await agents('install', '--no-global-rule');
  assert.equal(claudeRule(off.json.results).action, 'removed');
  assert.equal(await exists(ruleOf(base)), false);
  assert.equal(JSON.parse(await readFile(recordsFile(workspace), 'utf8')).items.some(item => item.kind === 'rule'), false);
  assert.deepEqual(ruleResults((await agents('install')).json.results), []);
  assert.equal(await exists(ruleOf(base)), false);
});

// spec: agent-installation / Edited rule
test('an edited rule is kept and reported edited by --no-global-rule and by uninstall', async t => {
  const { base, agents } = await fixture(t);
  await agents('install', '--global-rule');
  const edited = (await readFile(ruleOf(base), 'utf8')) + 'Also prefer worktrees.\n';
  await writeFile(ruleOf(base), edited);
  assert.equal((await agents('status')).json.items.find(item => item.kind === 'rule').state, 'edited');
  const off = claudeRule((await agents('install', '--no-global-rule')).json.results);
  assert.deepEqual([off.action, off.state, off.code], ['kept', 'edited', 'RULE_EDITED']);
  assert.equal(await readFile(ruleOf(base), 'utf8'), edited);
  const plain = claudeRule((await agents('install')).json.results);
  assert.deepEqual([plain.action, plain.state], ['kept', 'edited'], 'opted out: a plain install does not restore it');
  const removed = claudeRule((await agents('uninstall')).json.results);
  assert.deepEqual([removed.action, removed.state, removed.code], ['kept', 'edited', 'RULE_EDITED']);
  assert.equal(await readFile(ruleOf(base), 'utf8'), edited);
  const forced = claudeRule((await agents('uninstall', '--force')).json.results);
  assert.equal(forced.action, 'removed');
  assert.equal(await exists(ruleOf(base)), false);
});

// spec: agent-installation / Edited rule
test('an opted-in edited rule is kept unless forced, and uninstall removes only the rule it wrote', async t => {
  const { base, agents } = await fixture(t);
  await agents('install', '--global-rule');
  await writeFile(ruleOf(base), 'mine\n');
  const kept = claudeRule((await agents('install')).json.results);
  assert.deepEqual([kept.action, kept.code], ['edited', 'RULE_EDITED']);
  assert.equal(await readFile(ruleOf(base), 'utf8'), 'mine\n');
  assert.equal(claudeRule((await agents('install', '--force')).json.results).action, 'updated');
  assert.match(await readFile(ruleOf(base), 'utf8'), /list_repos/);
  await writeFile(join(base, 'claude/rules/mine.md'), 'my own rule\n');
  const removed = await agents('uninstall');
  assert.equal(claudeRule(removed.json.results).action, 'removed');
  assert.deepEqual(await readdir(join(base, 'claude/rules')), ['mine.md']);
});

// spec: agent-installation / Opt in
test('a rule file Context Kit did not write is never replaced or removed, even with --force', async t => {
  const { base, workspace, agents } = await fixture(t);
  await mkdir(join(base, 'claude/rules'), { recursive: true });
  await writeFile(ruleOf(base), 'a rule of my own\n');
  for (const args of [['--global-rule'], ['--global-rule', '--force']]) {
    const result = claudeRule((await agents('install', ...args)).json.results);
    assert.deepEqual([result.action, result.code], ['conflict', 'RULE_FOREIGN'], args.join(' '));
  }
  assert.equal(await readFile(ruleOf(base), 'utf8'), 'a rule of my own\n');
  assert.equal(JSON.parse(await readFile(recordsFile(workspace), 'utf8')).items.some(item => item.kind === 'rule'), false);
  await agents('uninstall', '--force');
  assert.equal(await readFile(ruleOf(base), 'utf8'), 'a rule of my own\n');

  // Installed, then deleted and another file put in its place: that file isn't Context Kit's.
  await rm(ruleOf(base));
  await agents('install', '--global-rule');
  const text = await readFile(ruleOf(base), 'utf8');
  await rm(ruleOf(base));
  await writeFile(ruleOf(base), 'someone else\n');
  for (const args of [[], ['--force']]) {
    const result = claudeRule((await agents('install', ...args)).json.results);
    assert.deepEqual([result.action, result.code], ['conflict', 'RULE_REPLACED']);
  }
  assert.equal((await agents('status')).json.items.find(item => item.kind === 'rule').state, 'replaced');
  const left = claudeRule((await agents('uninstall', '--force')).json.results);
  assert.deepEqual([left.action, left.code], ['skipped', 'RULE_REPLACED']);
  assert.equal(await readFile(ruleOf(base), 'utf8'), 'someone else\n');

  // A restore with the installed content is taken back by the workspace that owns the launcher.
  await rm(ruleOf(base));
  await agents('install', '--global-rule');
  await rm(ruleOf(base));
  await writeFile(ruleOf(base), text);
  assert.equal(claudeRule((await agents('install')).json.results).action, 'unchanged');
  assert.equal(claudeRule((await agents('uninstall')).json.results).action, 'removed');
  assert.equal(await exists(ruleOf(base)), false);
});

// spec: agent-installation / Opt in
test('the rule is written and removed only through real directories', async t => {
  const { base, agents } = await fixture(t);
  const elsewhere = join(base, 'elsewhere');
  await mkdir(elsewhere);
  await mkdir(join(base, 'claude'), { recursive: true });
  await symlink(elsewhere, join(base, 'claude/rules'));
  const refused = claudeRule((await agents('install', '--global-rule')).json.results);
  assert.deepEqual([refused.action, refused.code], ['refused', 'SYMLINKED_PATH']);
  assert.deepEqual(await readdir(elsewhere), []);
  await rm(join(base, 'claude/rules'));
  assert.equal(claudeRule((await agents('install', '--global-rule')).json.results).action, 'installed');
  await rename(join(base, 'claude/rules'), join(elsewhere, 'rules'));
  await symlink(join(elsewhere, 'rules'), join(base, 'claude/rules'));
  const kept = claudeRule((await agents('install', '--no-global-rule')).json.results);
  assert.deepEqual([kept.action, kept.code], ['kept', 'SYMLINKED_PATH']);
  assert.ok(await exists(join(elsewhere, 'rules/context-kit.md')));
});

// spec: agent-installation / Off unless asked
test('an install killed just after the rule is put in place is completed by the next, without --force', async t => {
  const machine = await fixture(t);
  const { base, env, workspace, agents } = machine;
  const preload = join(base, 'kill-at-rule.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const link = fs.link;
fs.link = async (from, to) => { const result = await link(from, to); if (String(to).endsWith('/rules/context-kit.md')) process.kill(process.pid, 'SIGKILL'); return result; };
syncBuiltinESMExports();
`);
  const killed = await exec(process.execPath, ['--import', preload, join(kit, 'bin/hub.mjs'), '--root', workspace, 'agents', 'install', '--agent', 'claude', '--global-rule'], { env })
    .then(() => 'finished', error => error.signal);
  assert.equal(killed, 'SIGKILL');
  assert.equal((await agents('status')).json.items.find(item => item.kind === 'rule').state, 'pending');
  const next = await agents('install', '--agent', 'claude');
  assert.equal(claudeRule(next.json.results).action, 'unchanged', 'the opt-in survived the kill');
  assert.deepEqual((await readdir(join(base, 'claude/rules'))), ['context-kit.md'], 'the built temporary is gone');
  assert.equal(claudeRule((await agents('uninstall')).json.results).action, 'removed');
  assert.equal(await exists(ruleOf(base)), false);
});

// spec: agent-installation / Off unless asked
test('the opt-in follows CLAUDE_CONFIG_DIR: the old rule goes, the new directory gets it', async t => {
  const { base, workspace, run } = await fixture(t);
  await run(['--root', workspace, 'agents', 'install', '--agent', 'claude', '--global-rule']);
  const moved = await run(['--root', workspace, 'agents', 'install', '--agent', 'claude'], { CLAUDE_CONFIG_DIR: join(base, 'claude2') });
  assert.deepEqual(ruleResults(moved.json.results).map(item => [item.path, item.action]), [[ruleOf(base), 'removed'], [join(base, 'claude2/rules/context-kit.md'), 'installed']]);
  assert.equal(await exists(ruleOf(base)), false);
  assert.match(await readFile(join(base, 'claude2/rules/context-kit.md'), 'utf8'), /list_repos/);
});

// Harnesses beyond Claude Code and Codex. Copilot CLI and Cursor register through their JSON
// config files; Gemini CLI through its CLI (faked above).
const HARNESSES = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];
const copilotConfig = env => join(env.COPILOT_HOME, 'mcp-config.json');
const cursorConfig = env => join(env.HOME, '.cursor/mcp.json');
const serverCommand = workspace => [process.execPath, join(kit, 'bin/mcp.mjs'), '--root', workspace, '--no-skill-prompts'];
// What a directory holds besides previous versions of its config file.
const PREVIOUS = /^\..+\.context-kit-\d+-\d+-[pv][0-9a-f]{16}$/;
const previous = async dir => (await readdir(dir)).filter(name => PREVIOUS.test(name));
// Copies recovery kept, reported by the sweep before the run or by the registration itself.
const displacedOf = json => [...(json.displaced ?? []), ...json.results.flatMap(item => item.displaced ?? [])];
const visible = async dir => (await readdir(dir)).filter(name => !PREVIOUS.test(name)).sort();

// spec: agent-installation / Unknown harness
test('an unknown harness fails naming every supported one, and nothing is written', async t => {
  const { base, env, workspace, calls, agents } = await fixture(t, { agents: ['claude', 'codex', 'gemini'] });
  const result = await agents('install', '--agent', 'claude,windsurf');
  assert.equal(result.error.code, 'INVALID_INPUT');
  for (const name of [...HARNESSES, 'all']) assert.match(result.error.message, new RegExp(`\\b${name}\\b`), name);
  assert.deepEqual(await readdir(env.HOME), []);
  assert.equal(await exists(join(base, 'claude')), false);
  assert.equal(await exists(join(workspace, '.state/agents.json')), false);
  assert.deepEqual(await calls(), []);
});

// spec: agent-installation / Every harness
test('--agent all installs skills and an MCP registration for every harness, and uninstall removes them all', async t => {
  const { env, workspace, agents, later } = await fixture(t, { agents: ['claude', 'codex', 'gemini'] });
  const installed = await agents('install', '--agent', 'all');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  assert.deepEqual(installed.json.results.filter(item => item.kind === 'mcp').map(item => [item.agent, item.action]), HARNESSES.map(agent => [agent, 'installed']));
  const status = (await agents('status')).json.items;
  for (const agent of HARNESSES) {
    const skills = status.filter(item => item.agent === agent && item.kind === 'skill');
    assert.deepEqual(skills.map(item => item.name).sort(), BUNDLED, agent);
    assert.ok(skills.every(item => item.state === 'installed'), agent);
    assert.deepEqual(status.filter(item => item.agent === agent && item.kind === 'mcp').map(item => item.state), ['installed'], agent);
  }
  const gemini = JSON.parse(await readFile(join(env.HOME, '.gemini/settings.json'), 'utf8'));
  assert.deepEqual(gemini.mcpServers['context-workspace'], { command: process.execPath, args: serverCommand(workspace).slice(1) });

  const removed = await agents('uninstall');
  assert.equal(removed.code, 0, JSON.stringify(removed.error));
  assert.ok(removed.json.results.every(item => item.action === 'removed'), JSON.stringify(removed.json.results.filter(item => item.action !== 'removed')));
  assert.deepEqual((await agents('status')).json.items, []);
  assert.deepEqual(JSON.parse(await readFile(join(env.HOME, '.gemini/settings.json'), 'utf8')).mcpServers, {});
  // The config files the install created are deleted, each kept as a previous version for an hour;
  // a later run removes them and the directories the install created.
  assert.deepEqual(await visible(env.COPILOT_HOME), []);
  assert.deepEqual(await visible(join(env.HOME, '.cursor')), []);
  assert.equal((await later('uninstall')).code, 0);
  assert.equal(await exists(env.COPILOT_HOME), false);
  assert.equal(await exists(join(env.HOME, '.cursor')), false);
  assert.deepEqual(await readdir(join(env.HOME, '.agents/skills')), []);
});

// spec: agent-installation / Cursor sees both directories
test('installing for Claude Code, Codex and Cursor warns that Cursor reads my-repos twice, and the copies are identical', async t => {
  const { workspace, env, run } = await fixture(t);
  await repository(workspace, 'studio', { title: 'the studio', resource: 'https://github.com/example/site', aliases: ['example site'] });
  const installed = await run(['--root', workspace, 'agents', 'install', '--agent', 'claude,codex,cursor'], { CLAUDE_CONFIG_DIR: '' });
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const claudeCopy = join(env.HOME, '.claude/skills/my-repos');
  const sharedCopy = join(env.HOME, '.agents/skills/my-repos');
  const warning = installed.json.warnings.find(item => item.name === 'my-repos');
  assert.deepEqual([warning.agent, warning.code, warning.paths.sort()], ['cursor', 'READ_TWICE', [sharedCopy, claudeCopy].sort()]);
  assert.match(warning.reason, /^Cursor reads my-repos from .* no precedence .*identical$/);
  assert.equal(await readFile(join(claudeCopy, 'SKILL.md'), 'utf8'), await readFile(join(sharedCopy, 'SKILL.md'), 'utf8'));
  // A bundled skill with keys only Claude Code reads is named too, as differing.
  assert.match(installed.json.warnings.find(item => item.name === 'reflect').reason, /differ$/);
  // Without Cursor, or with Cursor reading one copy, nothing is reported.
  assert.deepEqual((await run(['--root', workspace, 'agents', 'install', '--agent', 'claude,codex'], { CLAUDE_CONFIG_DIR: '' })).json.warnings, []);
  const alone = await fixture(t);
  assert.deepEqual((await alone.run(['--root', alone.workspace, 'agents', 'install', '--agent', 'claude,cursor'], { CLAUDE_CONFIG_DIR: '' })).json.warnings, []);
});

// spec: agent-installation / Register with Gemini CLI
test('Gemini CLI registers the server through gemini mcp add and remove at user scope', async t => {
  const { env, workspace, calls, agents } = await fixture(t, { agents: ['gemini'] });
  const installed = await agents('install', '--agent', 'gemini');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const [node, ...rest] = serverCommand(workspace);
  assert.deepEqual((await calls()).map(call => call.args), [
    ['mcp', 'remove', '-s', 'user', 'context-workspace'],
    ['mcp', 'add', '-s', 'user', 'context-workspace', node, '--', ...rest]]);
  assert.deepEqual((await agents('status')).json.items.filter(item => item.kind === 'mcp').map(item => [item.agent, item.scope, item.state]), [['gemini', 'user', 'installed']]);
  const removed = await agents('uninstall', '--agent', 'gemini');
  assert.equal(removed.code, 0, JSON.stringify(removed.error));
  assert.deepEqual((await calls()).at(-1).args, ['mcp', 'remove', '-s', 'user', 'context-workspace']);
  assert.equal(JSON.parse(await readFile(join(env.HOME, '.gemini/settings.json'), 'utf8')).mcpServers['context-workspace'], undefined);
  // Without the CLI, as for other agents: skipped, skills still installed.
  const bare = await fixture(t, { agents: [] });
  const skipped = (await bare.agents('install', '--agent', 'gemini')).json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([skipped.action, skipped.reason], ['skipped', 'gemini CLI not found on PATH']);
  assert.ok(await exists(join(bare.env.HOME, '.agents/skills/reflect/SKILL.md')));
});

// spec: agent-installation / Other servers are kept
test('Copilot CLI and Cursor config files gain one entry in their shape, and uninstall restores them byte for byte', async t => {
  const { env, workspace, agents } = await fixture(t, { agents: [] });
  // Formatting of the user's own choosing: four spaces and a trailing key for Copilot, one line for Cursor.
  const copilotBefore = '{\n    "mcpServers": {\n        "notes": {\n            "type": "local",\n            "command": "notes-mcp",\n            "args": [],\n            "tools": ["*"]\n        }\n    },\n    "theme": "dark"\n}\n';
  const cursorBefore = '{"mcpServers": {"notes": {"command": "notes-mcp"}}, "other": [1, 2]}';
  await mkdir(env.COPILOT_HOME, { recursive: true });
  await mkdir(join(env.HOME, '.cursor'));
  await writeFile(copilotConfig(env), copilotBefore, { mode: 0o640 });
  await writeFile(cursorConfig(env), cursorBefore);
  const installed = await agents('install', '--agent', 'copilot,cursor');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  assert.deepEqual(installed.json.results.filter(item => item.kind === 'mcp').map(item => [item.agent, item.action, item.path]),
    [['copilot', 'installed', copilotConfig(env)], ['cursor', 'installed', cursorConfig(env)]]);
  const [node, ...args] = serverCommand(workspace);
  const copilot = JSON.parse(await readFile(copilotConfig(env), 'utf8'));
  assert.deepEqual(copilot, { mcpServers: { notes: JSON.parse(copilotBefore).mcpServers.notes, 'context-workspace': { type: 'local', command: node, args, tools: ['*'] } }, theme: 'dark' });
  const cursor = JSON.parse(await readFile(cursorConfig(env), 'utf8'));
  assert.deepEqual(cursor, { mcpServers: { notes: { command: 'notes-mcp' }, 'context-workspace': { type: 'stdio', command: node, args } }, other: [1, 2] });
  assert.ok((await readFile(copilotConfig(env), 'utf8')).startsWith('{\n    "mcpServers": {\n        "notes": {'), 'the user\'s text is kept, not reformatted');
  assert.equal((await lstat(copilotConfig(env))).mode & 0o777, 0o640);
  assert.deepEqual((await agents('status')).json.items.filter(item => item.kind === 'mcp').map(item => [item.agent, item.state]), [['copilot', 'installed'], ['cursor', 'installed']]);
  assert.deepEqual((await agents('install', '--agent', 'copilot,cursor')).json.results.filter(item => item.kind === 'mcp').map(item => item.action), ['unchanged', 'unchanged']);

  const removed = await agents('uninstall');
  assert.deepEqual(removed.json.results.filter(item => item.kind === 'mcp').map(item => [item.agent, item.action]), [['copilot', 'removed'], ['cursor', 'removed']]);
  assert.equal(await readFile(copilotConfig(env), 'utf8'), copilotBefore);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), cursorBefore);
});

// spec: agent-installation / Other servers are kept
test('a config file without mcpServers gets the key and loses it again; a foreign entry of the same name is kept unless forced', async t => {
  const { env, agents } = await fixture(t, { agents: [] });
  await mkdir(join(env.HOME, '.cursor'));
  const before = '{\n  "editor": {\n    "fontSize": 13\n  }\n}\n';
  await writeFile(cursorConfig(env), before);
  assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cursorConfig(env), 'utf8'))), ['editor', 'mcpServers']);
  await agents('uninstall');
  assert.equal(await readFile(cursorConfig(env), 'utf8'), before);

  const foreign = `{\n  "mcpServers": {\n    "context-workspace": {\n      "command": "elsewhere"\n    }\n  }\n}\n`;
  await writeFile(copilotConfig(env), foreign).catch(async () => { await mkdir(env.COPILOT_HOME); await writeFile(copilotConfig(env), foreign); });
  const conflict = (await agents('install', '--agent', 'copilot')).json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([conflict.action, conflict.code], ['conflict', 'MCP_FOREIGN']);
  assert.equal(await readFile(copilotConfig(env), 'utf8'), foreign);
  assert.deepEqual((await agents('uninstall')).json.results.filter(item => item.kind === 'mcp'), []);
  assert.equal(await readFile(copilotConfig(env), 'utf8'), foreign);
  assert.equal((await agents('install', '--agent', 'copilot', '--force')).json.results.find(item => item.kind === 'mcp').action, 'installed');
  assert.equal(JSON.parse(await readFile(copilotConfig(env), 'utf8')).mcpServers['context-workspace'].type, 'local');
});

// spec: agent-installation / Unreadable config
test('a commented Copilot config and an invalid Cursor config are refused untouched, and the skills still install', async t => {
  const { env, agents } = await fixture(t, { agents: [] });
  const copilotBefore = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  const cursorBefore = '{ "mcpServers": { "notes": ';
  await mkdir(env.COPILOT_HOME, { recursive: true });
  await mkdir(join(env.HOME, '.cursor'));
  await writeFile(copilotConfig(env), copilotBefore);
  await writeFile(cursorConfig(env), cursorBefore);
  const installed = await agents('install', '--agent', 'copilot,cursor');
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  const mcp = installed.json.results.filter(item => item.kind === 'mcp');
  assert.deepEqual(mcp.map(item => [item.agent, item.action, item.code, item.path]),
    [['copilot', 'refused', 'CONFIG_MALFORMED', copilotConfig(env)], ['cursor', 'refused', 'CONFIG_MALFORMED', cursorConfig(env)]]);
  for (const item of mcp) {
    assert.ok(item.reason.startsWith(`${item.path} is not plain JSON`), item.reason);
    assert.equal(item.entry.command, process.execPath, 'the entry to add by hand');
  }
  assert.equal(await readFile(copilotConfig(env), 'utf8'), copilotBefore);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), cursorBefore);
  assert.deepEqual((await readdir(join(env.HOME, '.agents/skills'))).sort(), BUNDLED);
  assert.ok(installed.json.results.filter(item => item.kind === 'skill').every(item => item.action === 'installed'));
  assert.deepEqual((await agents('status')).json.items.filter(item => item.kind === 'mcp'), []);
  // An mcpServers that isn't an object, or a link to nothing, is refused the same way.
  await writeFile(cursorConfig(env), '{"mcpServers": []}');
  await rm(copilotConfig(env));
  await symlink(join(env.HOME, 'nowhere.json'), copilotConfig(env));
  const again = (await agents('install', '--agent', 'copilot,cursor')).json.results.filter(item => item.kind === 'mcp');
  assert.deepEqual(again.map(item => [item.agent, item.action, item.code]), [['copilot', 'refused', 'CONFIG_LINK_BROKEN'], ['cursor', 'refused', 'CONFIG_MALFORMED']]);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), '{"mcpServers": []}');
  assert.equal(await exists(join(env.HOME, 'nowhere.json')), false);
  // A key listed twice anywhere is ambiguous, so it is refused too.
  const twice = '{"mcpServers": {}, "editor": {"font": 1, "font": 2}}';
  await writeFile(cursorConfig(env), twice);
  const duplicate = (await agents('install', '--agent', 'cursor')).json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([duplicate.action, duplicate.code], ['refused', 'CONFIG_MALFORMED']);
  assert.match(duplicate.reason, /"font" more than once/);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), twice);
});

// spec: agent-installation / Edited entry
test('an entry edited since install is kept and reported edited by install and uninstall', async t => {
  const { env, agents, later } = await fixture(t, { agents: [] });
  assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
  const config = JSON.parse(await readFile(cursorConfig(env), 'utf8'));
  config.mcpServers['context-workspace'].env = { DEBUG: '1' };
  const edited = JSON.stringify(config, null, 2);
  await writeFile(cursorConfig(env), edited);
  assert.equal((await agents('status')).json.items.find(item => item.kind === 'mcp').state, 'edited');
  const installed = (await agents('install', '--agent', 'cursor')).json.results.find(item => item.kind === 'mcp');
  assert.equal(installed.action, 'edited');
  assert.equal(await readFile(cursorConfig(env), 'utf8'), edited);
  const removed = (await agents('uninstall')).json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([removed.action, removed.state], ['kept', 'edited']);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), edited);
  // --force replaces it, and then uninstall removes it, with the file the install created.
  assert.equal((await agents('install', '--agent', 'cursor', '--force')).json.results.find(item => item.kind === 'mcp').action, 'updated');
  assert.equal((await agents('uninstall')).json.results.find(item => item.kind === 'mcp').action, 'removed');
  assert.deepEqual(await visible(join(env.HOME, '.cursor')), []);
  await later('status');
  await later('uninstall');
  assert.equal(await exists(join(env.HOME, '.cursor')), false);
});

// spec: agent-installation / Other servers are kept
test('config files reached through symbolic links are edited in place and the links are kept', async t => {
  const { base, env, agents } = await fixture(t, { agents: [] });
  // A dotfile manager's layout: ~/.cursor is a link to a directory, and Copilot's file a link to a file.
  const dotfiles = join(base, 'dotfiles');
  await mkdir(join(dotfiles, 'cursor'), { recursive: true });
  const cursorBefore = '{\n  "mcpServers": {\n    "notes": { "command": "notes-mcp" }\n  }\n}\n';
  const copilotBefore = '{\n  "mcpServers": {}\n}\n';
  await writeFile(join(dotfiles, 'cursor/mcp.json'), cursorBefore);
  await writeFile(join(dotfiles, 'copilot.json'), copilotBefore);
  await symlink(join(dotfiles, 'cursor'), join(env.HOME, '.cursor'));
  await mkdir(env.COPILOT_HOME);
  await symlink(join(dotfiles, 'copilot.json'), copilotConfig(env));
  assert.equal((await agents('install', '--agent', 'copilot,cursor')).code, 0);
  assert.ok((await lstat(join(env.HOME, '.cursor'))).isSymbolicLink());
  assert.ok((await lstat(copilotConfig(env))).isSymbolicLink());
  assert.ok(JSON.parse(await readFile(join(dotfiles, 'cursor/mcp.json'), 'utf8')).mcpServers['context-workspace']);
  assert.ok(JSON.parse(await readFile(join(dotfiles, 'copilot.json'), 'utf8')).mcpServers['context-workspace']);
  assert.deepEqual(await visible(join(dotfiles, 'cursor')), ['mcp.json'], 'no temporary is left');
  await agents('uninstall');
  assert.equal(await readFile(join(dotfiles, 'cursor/mcp.json'), 'utf8'), cursorBefore);
  assert.equal(await readFile(join(dotfiles, 'copilot.json'), 'utf8'), copilotBefore);
  assert.ok((await lstat(copilotConfig(env))).isSymbolicLink());
});

// spec: agent-installation / Project install for Cursor
test('at project scope Cursor, Copilot CLI and Gemini CLI get project skills and no MCP registration', async t => {
  const { base, env, calls, agents } = await fixture(t, { agents: ['gemini'] });
  const project = join(base, 'project');
  await mkdir(project);
  await mkdir(join(env.HOME, '.cursor'));
  const before = '{"mcpServers": {}}';
  await writeFile(cursorConfig(env), before);
  const installed = await agents('install', '--agent', 'cursor,copilot,gemini', '--scope', 'project', '--project', project);
  assert.equal(installed.code, 0, JSON.stringify(installed.error));
  assert.deepEqual((await readdir(join(project, '.agents/skills'))).sort(), BUNDLED);
  assert.equal(await exists(join(env.HOME, '.agents')), false);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), before);
  assert.equal(await exists(env.COPILOT_HOME), false);
  assert.deepEqual(await calls(), []);
  const mcp = installed.json.results.filter(item => item.kind === 'mcp');
  assert.deepEqual(mcp.map(item => [item.agent, item.action]), [['cursor', 'skipped'], ['copilot', 'skipped'], ['gemini', 'skipped']]);
  assert.match(mcp[0].reason, /^Cursor's project MCP config is usually committed, so Context Kit registers it only at user scope/);
});

// Review round 1. A harness (or the user) writing the config file at the worst moments: a
// preload runs the write once, just before the install's capture link (`capture`), between its
// check and its swap, in place (`swap`), or before an uninstall moves a created file aside
// (`aside`). RACE_KEY says what the writer adds: another server, or an unrelated top-level key.
const racePreload = `import fs from 'node:fs/promises';
import sync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { RACE_AT: at, RACE_FLAG: flag, RACE_KEY: key } = process.env;
const log = process.env.RACE_LOG;
const edit = (path, inPlace) => {
  if (!flag || !sync.existsSync(flag)) return;
  if (!process.env.RACE_REPEAT) sync.rmSync(flag);
  let text;
  if (key === 'broken') text = '{ not json';
  else {
    const data = JSON.parse(sync.readFileSync(path, 'utf8'));
    if (key === 'top') data.harness = true;
    else if (key === 'later') data.later = true;
    else if (key === 'ours') (data.mcpServers ??= {})['context-workspace'] = { command: 'theirs' };
    else (data.mcpServers ??= {})['harness-added'] = { command: 'h' };
    if (process.env.RACE_REPEAT) data.writes = (data.writes ?? 0) + 1;
    text = JSON.stringify(data, null, 2) + '\\n';
  }
  if (inPlace) sync.writeFileSync(path, text);
  else { sync.writeFileSync(path + '.harness', text); sync.renameSync(path + '.harness', path); }
  // What the writer left, for the test to compare with (NUL-separated when it writes again).
  if (log) sync.appendFileSync(log, (sync.existsSync(log) && sync.readFileSync(log, 'utf8') ? '\\u0000' : '') + text);
};
const { link, rename } = fs;
fs.link = async (from, to) => { if (at === 'capture' && /-p[0-9a-f]{16}$/.test(String(to))) edit(from, false); return link(from, to); };
fs.rename = async (from, to) => {
  if (at === 'swap' && String(from).includes('.context-kit-') && /mcp(-config)?\\.json$/.test(String(to))) edit(to, true);
  if (at === 'aside' && /-o[0-9a-f]{16}$/.test(String(to)) && /mcp(-config)?\\.json$/.test(String(from))) edit(from, true);
  return rename(from, to);
};
syncBuiltinESMExports();
`;
async function racer(base) {
  const preload = join(base, 'race.mjs');
  await writeFile(preload, racePreload);
  const flag = join(base, 'race.flag');
  racer.fired = async () => !await exists(flag);
  return async (at, key = 'server') => { await writeFile(flag, ''); return { NODE_OPTIONS: `--import=${preload}`, RACE_AT: at, RACE_FLAG: flag, RACE_KEY: key }; };
}

// spec: agent-installation / Other servers are kept
test('a harness writing its config while install or uninstall edits it keeps its change', async t => {
  const { base, env, run, workspace } = await fixture(t, { agents: [] });
  const race = await racer(base);
  const cursor = (...args) => run(['--root', workspace, 'agents', ...args]);
  const servers = async () => Object.keys(JSON.parse(await readFile(cursorConfig(env), 'utf8')).mcpServers).sort();
  await mkdir(join(env.HOME, '.cursor'));
  await writeFile(cursorConfig(env), '{\n  "mcpServers": {\n    "notes": { "command": "notes-mcp" }\n  }\n}\n');
  // Before the capture: nothing is written, and the edit is computed again from the new content.
  const first = await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'], await race('capture'));
  assert.ok(await racer.fired(), 'the racing write ran');
  assert.equal(first.json.results.find(item => item.kind === 'mcp').action, 'installed');
  assert.deepEqual(await servers(), ['context-workspace', 'harness-added', 'notes']);
  // During the swap, in place: the file is put back exactly as the writer left it, and the
  // install says so; the next one applies the entry to it.
  await cursor('uninstall');
  assert.deepEqual(await servers(), ['harness-added', 'notes']);
  const writerLeft = [];
  const second = await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'], { ...await race('swap', 'top'), RACE_LOG: join(base, 'race.log') });
  assert.ok(await racer.fired(), 'the racing write ran');
  writerLeft.push(await readFile(join(base, 'race.log'), 'utf8'));
  const conflicted = second.json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([conflicted.action, conflicted.code], ['failed', 'MCP_CONFLICT']);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), writerLeft[0], 'byte-identical to what the writer left');
  assert.equal((await cursor('install', '--agent', 'cursor')).json.results.find(item => item.kind === 'mcp').action, 'installed');
  const both = JSON.parse(await readFile(cursorConfig(env), 'utf8'));
  assert.deepEqual([Object.keys(both.mcpServers).sort(), both.harness], [['context-workspace', 'harness-added', 'notes'], true]);
  // Uninstall racing a writer the same way: the writer's file stays, and the record with it.
  const removed = await run(['--root', workspace, 'agents', 'uninstall'], { ...await race('swap', 'later'), RACE_LOG: join(base, 'race2.log') });
  assert.ok(await racer.fired(), 'the racing write ran');
  assert.deepEqual(removed.json.results.filter(item => item.kind === 'mcp').map(item => [item.action, item.code]), [['kept', 'MCP_CONFLICT']]);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), await readFile(join(base, 'race2.log'), 'utf8'));
  assert.equal((await cursor('uninstall')).json.results.find(item => item.kind === 'mcp').action, 'removed');
  assert.deepEqual(await servers(), ['harness-added', 'notes']);
  assert.deepEqual((await visible(join(env.HOME, '.cursor'))).sort(), ['mcp.json'], 'no temporary or displaced copy is left');
});

// spec: agent-installation / Other servers are kept
test('a writer racing every attempt, or racing before an early stop, ends with exactly its bytes and MCP_CONFLICT', async t => {
  const { base, env, run, workspace } = await fixture(t, { agents: [] });
  const race = await racer(base);
  await mkdir(join(env.HOME, '.cursor'));
  await writeFile(cursorConfig(env), '{"mcpServers":{},"original":true}');
  // A write before every capture: four attempts, nothing written.
  const exhausted = await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'], { ...await race('capture'), RACE_REPEAT: '1', RACE_LOG: join(base, 'every.log') });
  const result = exhausted.json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([result.action, result.code], ['failed', 'MCP_CONFLICT']);
  assert.match(result.reason, /nothing was written/);
  assert.equal(await readFile(cursorConfig(env), 'utf8'), (await readFile(join(base, 'every.log'), 'utf8')).split('\u0000').at(-1));
  assert.deepEqual(JSON.parse(await readFile(cursorConfig(env), 'utf8')).writes, 4);
  // The writer adds a server of our name before the capture: the next attempt stops early
  // (MCP_FOREIGN) and writes nothing.
  await writeFile(cursorConfig(env), '{"mcpServers":{},"original":true}');
  const foreign = await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'], { ...await race('capture', 'ours'), RACE_LOG: join(base, 'ours.log') });
  assert.equal(foreign.json.results.find(item => item.kind === 'mcp').code, 'MCP_FOREIGN');
  assert.equal(await readFile(cursorConfig(env), 'utf8'), await readFile(join(base, 'ours.log'), 'utf8'));
  // The writer leaves something that isn't JSON: nothing is written.
  await writeFile(cursorConfig(env), '{"mcpServers":{},"original":true}');
  const broken = await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'], { ...await race('capture', 'broken'), RACE_LOG: join(base, 'broken.log') });
  assert.equal(broken.json.results.find(item => item.kind === 'mcp').code, 'MCP_CONFLICT');
  assert.equal(await readFile(cursorConfig(env), 'utf8'), '{ not json');
  assert.deepEqual(await visible(join(env.HOME, '.cursor')), ['mcp.json']);
});

// spec: agent-installation / Other servers are kept
test('a file the install created is deleted on uninstall only while it holds nothing else', async t => {
  const { base, env, run, workspace } = await fixture(t, { agents: [] });
  const race = await racer(base);
  assert.equal((await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'])).code, 0);
  // A key added just before the uninstall moves the file aside: the file stays, with that key.
  const removed = await run(['--root', workspace, 'agents', 'uninstall'], await race('aside', 'top'));
  assert.ok(await racer.fired(), 'the racing write ran');
  assert.equal(removed.json.results.find(item => item.kind === 'mcp').action, 'removed');
  assert.deepEqual(JSON.parse(await readFile(cursorConfig(env), 'utf8')), { harness: true });
  assert.deepEqual(await visible(join(env.HOME, '.cursor')), ['mcp.json']);
});

// spec: agent-installation / Other servers are kept
test('a config link retargeted to another file is not edited or deleted, and a rewritten file is not claimed', async t => {
  const { base, env, agents } = await fixture(t, { agents: [] });
  assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
  // The same bytes in a file outside HOME, and the config replaced by a link to it.
  const foreign = join(base, 'foreign.json');
  const bytes = await readFile(cursorConfig(env), 'utf8');
  await writeFile(foreign, bytes);
  await rm(cursorConfig(env));
  await symlink(foreign, cursorConfig(env));
  assert.equal((await agents('status')).json.items.find(item => item.kind === 'mcp').state, 'replaced');
  const install = (await agents('install', '--agent', 'cursor')).json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([install.action, install.code], ['conflict', 'MCP_REPLACED']);
  const removed = (await agents('uninstall')).json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([removed.action, removed.code], ['skipped', 'MCP_REPLACED']);
  assert.match(removed.reason, new RegExp(`now leads to ${foreign}`));
  assert.equal(await readFile(foreign, 'utf8'), bytes);
  assert.ok((await lstat(cursorConfig(env))).isSymbolicLink());

  // A file rewritten since install (the harness saving it) still loses our entry, but the file
  // and mcpServers the install created are no longer the install's to delete.
  const other = await fixture(t, { agents: [] });
  assert.equal((await other.agents('install', '--agent', 'cursor')).code, 0);
  const path = cursorConfig(other.env);
  await writeFile(`${path}.saved`, await readFile(path, 'utf8'));
  await rename(`${path}.saved`, path);
  assert.equal((await other.agents('uninstall')).json.results.find(item => item.kind === 'mcp').action, 'removed');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { mcpServers: {} });
});

// spec: agent-installation / Other servers are kept
test('empty objects keep their own whitespace through install and uninstall', async t => {
  const { env, agents } = await fixture(t, { agents: [] });
  await mkdir(join(env.HOME, '.cursor'));
  await mkdir(env.COPILOT_HOME);
  for (const [cursorBefore, copilotBefore] of [['{ \n\t }\n', '{\n  "mcpServers": { \n\n  }\n}\n'], ['{}', '{"mcpServers":{}}']]) {
    await writeFile(cursorConfig(env), cursorBefore);
    await writeFile(copilotConfig(env), copilotBefore);
    assert.deepEqual((await agents('install', '--agent', 'cursor,copilot')).json.results.filter(item => item.kind === 'mcp').map(item => item.action), ['installed', 'installed']);
    await agents('uninstall');
    assert.equal(await readFile(cursorConfig(env), 'utf8'), cursorBefore);
    assert.equal(await readFile(copilotConfig(env), 'utf8'), copilotBefore);
  }
});

// spec: agent-installation / Register with Gemini CLI
test('a failing gemini CLI is reported with a fixed code and none of its output, and a failed remove keeps the record', async t => {
  const { env, run, workspace, agents } = await fixture(t, { agents: ['gemini'] });
  const added = await run(['--root', workspace, 'agents', 'install', '--agent', 'gemini'], { FAKE_GEMINI_FAIL: 'add' });
  const failed = added.json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([failed.action, failed.code], ['failed', 'MCP_ADD_FAILED']);
  assert.doesNotMatch(JSON.stringify(added.json), /PRIVATE_TOKEN|sentinel/);
  assert.equal((await agents('install', '--agent', 'gemini')).json.results.find(item => item.kind === 'mcp').action, 'installed');
  const kept = await run(['--root', workspace, 'agents', 'uninstall'], { FAKE_GEMINI_FAIL: 'remove' });
  const result = kept.json.results.find(item => item.kind === 'mcp');
  assert.deepEqual([result.action, result.state, result.code], ['kept', 'failed', 'MCP_REMOVE_FAILED']);
  assert.doesNotMatch(JSON.stringify(kept.json), /PRIVATE_TOKEN|sentinel/);
  assert.equal((await agents('status')).json.items.find(item => item.kind === 'mcp').state, 'installed');
  assert.equal((await agents('uninstall')).json.results.find(item => item.kind === 'mcp').action, 'removed');
  assert.equal(JSON.parse(await readFile(join(env.HOME, '.gemini/settings.json'), 'utf8')).mcpServers['context-workspace'], undefined);
});

// spec: agent-installation / Register with Gemini CLI
test('GEMINI_CLI_HOME away from HOME is refused before anything is written', async t => {
  const { base, env, workspace, run, calls } = await fixture(t, { agents: ['gemini'] });
  const refused = await run(['--root', workspace, 'agents', 'install', '--agent', 'claude,gemini'], { GEMINI_CLI_HOME: join(base, 'gemini-home') });
  assert.equal(refused.error.code, 'GEMINI_HOME_UNSUPPORTED');
  assert.match(refused.error.message, new RegExp(join(base, 'gemini-home', '.agents', 'skills')));
  assert.deepEqual(await readdir(env.HOME), []);
  assert.equal(await exists(join(workspace, '.state/agents.json')), false);
  assert.deepEqual(await calls(), []);
  // Pointing at HOME itself is the default layout.
  assert.equal((await run(['--root', workspace, 'agents', 'install', '--agent', 'gemini'], { GEMINI_CLI_HOME: env.HOME })).code, 0);
});

// spec: agent-installation / Other servers are kept
test('a config file an interrupted uninstall moved aside is put back, or kept as displaced when another took its place', async t => {
  const { env, agents } = await fixture(t, { agents: [] });
  await mkdir(join(env.HOME, '.cursor'));
  // A process that no longer exists (pid 999999) moved the file aside and was killed.
  const before = '{"mcpServers": {"notes": {"command": "notes-mcp"}}}';
  const aside = join(env.HOME, '.cursor/.mcp.json.context-kit-999999-1-o0123456789abcdef');
  await writeFile(aside, before);
  assert.equal((await agents('install', '--agent', 'cursor')).json.results.find(item => item.kind === 'mcp').action, 'installed');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cursorConfig(env), 'utf8')).mcpServers), ['notes', 'context-workspace']);
  assert.deepEqual(await visible(join(env.HOME, '.cursor')), ['mcp.json']);
  await writeFile(aside, before);
  const again = (await agents('install', '--agent', 'cursor')).json;
  const files = (await visible(join(env.HOME, '.cursor'))).sort();
  assert.equal(files.length, 2);
  assert.match(files[1], /^mcp\.json\.context-kit-displaced-\d+-\d+-0$/);
  assert.deepEqual(displacedOf(again), [join(env.HOME, '.cursor', files[1])]);
  assert.equal(await readFile(join(env.HOME, '.cursor', files[1]), 'utf8'), before);
});

// spec: agent-installation / Other servers are kept
test('recovery removes only what holds the bytes Context Kit wrote, and never replaces a displaced copy', async t => {
  const { env, agents, later } = await fixture(t, { agents: [] });
  const directory = join(env.HOME, '.cursor');
  await mkdir(directory);
  await writeFile(cursorConfig(env), '{"mcpServers":{},"live":"keep"}');
  const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
  // A dead process's capture whose bytes diverged (a write landed in it before a kill), its own
  // temporary, an existing displaced copy, and a moved-aside file whose place is taken.
  const diverged = '{"mcpServers":{},"user":"edit made during the swap"}';
  await writeFile(join(directory, `.mcp.json.context-kit-999999-1-p${hash('{"mcpServers":{}}')}`), diverged);
  const temporary = '{"mcpServers":{"context-workspace":{}}}';
  await writeFile(join(directory, `.mcp.json.context-kit-999999-1-t${hash(temporary)}`), temporary);
  // A recent capture that matches: a previous version, kept for an hour.
  const recent = `.mcp.json.context-kit-999999-${Date.now()}-p${hash('same')}`;
  await writeFile(join(directory, recent), 'same');
  await writeFile(join(directory, 'mcp.json.context-kit-displaced-1'), 'USER-BACKUP-MUST-SURVIVE');
  await writeFile(join(directory, '.mcp.json.context-kit-999999-1-o0123456789abcdef'), 'OTHER-USER-BYTES');
  const installed = (await agents('install', '--agent', 'cursor')).json;
  const result = { ...installed.results.find(item => item.kind === 'mcp'), displaced: displacedOf(installed) };
  assert.equal(result.action, 'installed');
  assert.equal(await readFile(join(directory, 'mcp.json.context-kit-displaced-1'), 'utf8'), 'USER-BACKUP-MUST-SURVIVE');
  const kept = await Promise.all(result.displaced.map(path => readFile(path, 'utf8')));
  assert.deepEqual(kept.sort(), ['OTHER-USER-BYTES', diverged].sort());
  // The matching temporary goes; the matching capture is a previous version, kept for an hour.
  const hidden = async () => (await readdir(directory)).filter(name => name.startsWith('.')).sort();
  assert.deepEqual((await hidden()).filter(name => /-t[0-9a-f]{16}$/.test(name)), []);
  assert.ok((await hidden()).includes(recent));
  assert.deepEqual(await visible(directory), ['mcp.json', 'mcp.json.context-kit-displaced-1', ...result.displaced.map(path => basename(path))].sort());
  assert.equal((await later('status')).code, 0);
  assert.equal((await later('install', '--agent', 'cursor')).code, 0);
  assert.deepEqual(await hidden(), [], 'an hour later, the previous versions that still hold what they held are gone');
});
// spec: agent-installation / Other servers are kept
test('a directory the install created goes once empty, even when its file was recreated after an interrupted uninstall', async t => {
  const { env, agents, later } = await fixture(t, { agents: [] });
  assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
  // An uninstall killed after deleting the file, before removing the directory or its record.
  await rm(cursorConfig(env));
  assert.equal((await agents('install', '--agent', 'cursor')).json.results.find(item => item.kind === 'mcp').action, 'installed');
  assert.equal((await agents('uninstall')).json.results.find(item => item.kind === 'mcp').action, 'removed');
  assert.deepEqual(await visible(join(env.HOME, '.cursor')), []);
  await later('uninstall');
  assert.equal(await exists(join(env.HOME, '.cursor')), false);
});

// Review round 3. A harness holding the config file open writes through its descriptor after
// Context Kit replaced (install) or deleted (uninstall) that file.
const latePreload = `import fs from 'node:fs/promises';
import sync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { rename } = fs;
let fd;
const late = () => {
  if (fd === undefined) return;
  const bytes = JSON.stringify({ mcpServers: {}, lateHarnessWrite: 'must survive' });
  sync.ftruncateSync(fd, 0); sync.writeSync(fd, bytes, 0, 'utf8'); sync.closeSync(fd); fd = undefined;
};
fs.rename = async (from, to) => {
  from = String(from); to = String(to);
  // Opened before the swap or the move aside, as a harness that has the file open.
  if (process.env.LATE === 'install' && /-t[0-9a-f]{16}$/.test(from) && to.endsWith('mcp.json')) fd = sync.openSync(to, 'r+');
  if (process.env.LATE === 'uninstall' && from.endsWith('mcp.json') && /-o[0-9a-f]{16}$/.test(to)) fd = sync.openSync(from, 'r+');
  const result = await rename(from, to);
  // Written once Context Kit has set the old file aside as a previous version.
  if (/-[po][0-9a-f]{16}$/.test(from) && /-v[0-9a-f]{16}$/.test(to)) late();
  return result;
};
syncBuiltinESMExports();
`;

// spec: agent-installation / Other servers are kept
test('a late write through a descriptor to the file install replaced or uninstall deleted is kept, then displaced and reported', async t => {
  for (const phase of ['install', 'uninstall']) {
    const { base, env, run, workspace, agents, later } = await fixture(t, { agents: [] });
    const preload = join(base, 'late.mjs');
    await writeFile(preload, latePreload);
    const directory = join(env.HOME, '.cursor');
    if (phase === 'install') { await mkdir(directory); await writeFile(cursorConfig(env), '{"mcpServers":{},"original":true}'); }
    else assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
    const args = phase === 'install' ? ['install', '--agent', 'cursor'] : ['uninstall'];
    const result = await run(['--root', workspace, 'agents', ...args], { NODE_OPTIONS: `--import=${preload}`, LATE: phase });
    assert.equal(result.code, 0, JSON.stringify(result.error));
    const holding = async () => (await Promise.all((await readdir(directory)).map(async name => [name, await readFile(join(directory, name), 'utf8')])))
      .filter(([, text]) => text.includes('lateHarnessWrite')).map(([name]) => name);
    assert.equal((await holding()).length, 1, `${phase}: the late write is on disk`);
    // It no longer holds what it held, so it is someone's: displaced and reported, never deleted.
    const sweep = await later(...(phase === 'install' ? ['install', '--agent', 'cursor'] : ['uninstall']));
    const [kept] = await holding();
    assert.match(kept, /^mcp\.json\.context-kit-displaced-/, phase);
    // Reported by whichever run moved it: the uninstall itself when it cleans up, or the later one.
    assert.deepEqual([...displacedOf(result.json), ...displacedOf(sweep.json)], [join(await realpath(directory), kept)], phase);
  }
});

// spec: agent-installation / Other servers are kept
test('concurrent installs of one workspace take turns, so every registration stays recorded', async t => {
  for (let pair = 0; pair < 3; pair++) {
    const { env, workspace, run, agents } = await fixture(t, { agents: [] });
    await mkdir(join(env.HOME, '.cursor'));
    await writeFile(cursorConfig(env), '{"mcpServers":{"foreign":{"command":"keep"}},"user":"keep"}');
    const both = await Promise.all([1, 2].map(() => run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'])));
    assert.deepEqual(both.map(item => item.code), [0, 0]);
    assert.deepEqual(both.map(item => item.json.results.find(result => result.kind === 'mcp').action).sort(), ['installed', 'unchanged']);
    const records = JSON.parse(await readFile(join(workspace, '.state/agents.json'), 'utf8')).items.filter(item => item.kind === 'mcp');
    assert.equal(records.length, 1);
    assert.equal((await agents('status')).json.items.find(item => item.kind === 'mcp').state, 'installed');
    assert.equal((await agents('uninstall')).json.results.find(item => item.kind === 'mcp').action, 'removed');
    assert.deepEqual(JSON.parse(await readFile(cursorConfig(env), 'utf8')), { mcpServers: { foreign: { command: 'keep' } }, user: 'keep' });
  }
});

// spec: agent-installation / Other servers are kept
test('a held agents lock makes another install wait and then give up with AGENTS_BUSY, and a dead holder\'s lock is taken over', async t => {
  const { workspace, run } = await fixture(t, { agents: [] });
  const lock = join(workspace, '.state/.lock-agents');
  await mkdir(dirname(lock), { recursive: true });
  // Held by a live process (this test runner).
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'held' }));
  const busy = await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'], { CONTEXT_KIT_AGENTS_LOCK_WAIT_MS: '300' });
  assert.equal(busy.error.code, 'AGENTS_BUSY');
  assert.equal(await exists(join(workspace, '.state/agents.json')), false);
  // A holder that is gone.
  await writeFile(lock, JSON.stringify({ pid: 999999, at: Date.now(), token: 'dead' }));
  assert.equal((await run(['--root', workspace, 'agents', 'install', '--agent', 'cursor'])).code, 0);
  assert.equal(await exists(lock), false);
});

// spec: agent-installation / Foreign and edited skills are preserved
test('a lock holder sweeps temporaries killed saves left in .state, by exact name and only when their process is gone', async t => {
  const { workspace, agents } = await fixture(t, { agents: [] });
  const state = join(workspace, '.state');
  await mkdir(state, { recursive: true });
  const now = Date.now();
  const dead = [`agents.json.999999-${now}`, `leftovers.json.999999-${now}`, `agents.json.${process.pid}-1`];
  // A live process's recent one, and names that only look alike.
  const kept = [`agents.json.${process.pid}-${now}`, 'agents.json.bak', 'agents.json.999999-1-x', 'other.json.999999-1'];
  for (const name of [...dead, ...kept]) await writeFile(join(state, name), '{}');
  assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
  const left = await readdir(state);
  for (const name of dead) assert.ok(!left.includes(name), name);
  for (const name of kept) assert.ok(left.includes(name), name);
});

// spec: agent-installation / Selective uninstall of shared copies
test('an uninstall that loses the agents lock stops before removing anything more, and the next one finishes', async t => {
  const { base, env, workspace, run, agents } = await fixture(t, { agents: [] });
  assert.equal((await agents('install', '--agent', 'codex')).code, 0);
  const shared = join(env.HOME, '.agents/skills');
  const before = (await readdir(shared)).length;
  // After the first skill is removed, another command takes the lock over.
  const preload = join(base, 'takeover.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const { rm } = fs;
let done = false;
fs.rm = async (path, options) => {
  const result = await rm(path, options);
  if (!done && String(path).startsWith(${JSON.stringify(shared)})) {
    done = true;
    await fs.writeFile(${JSON.stringify(join(workspace, '.state/.lock-agents'))}, JSON.stringify({ pid: ${process.pid}, at: Date.now(), token: 'taken-over' }));
  }
  return result;
};
syncBuiltinESMExports();
`);
  const lost = await run(['--root', workspace, 'agents', 'uninstall'], { NODE_OPTIONS: `--import=${preload}` });
  assert.equal(lost.error?.code, 'AGENTS_BUSY');
  assert.equal((await readdir(shared)).length, before - 1, 'only the skill removed before the takeover is gone');
  assert.equal(JSON.parse(await readFile(join(workspace, '.state/.lock-agents'), 'utf8')).token, 'taken-over', 'the other holder\'s lock is left');
  await rm(join(workspace, '.state/.lock-agents'));
  const finished = await agents('uninstall');
  assert.equal(finished.code, 0, JSON.stringify(finished.error));
  assert.deepEqual(await readdir(shared), []);
  assert.deepEqual((await agents('status')).json.items, []);
});

// spec: agent-installation / Other servers are kept
test('repos sync sweeps previous versions of config files by the same rules as install and uninstall', async t => {
  const { env, workspace, run, agents } = await fixture(t, { agents: [] });
  const sync = extra => run(['--root', workspace, 'repos', 'sync'], extra);
  assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
  assert.equal((await agents('uninstall')).code, 0);
  const directory = join(env.HOME, '.cursor');
  assert.equal((await previous(directory)).length, 1);
  // Within the hour it stays; once past it, a sync deletes it and the directory the install created.
  assert.equal((await sync()).code, 0);
  assert.equal((await previous(directory)).length, 1);
  assert.equal((await sync(anHourLater)).code, 0);
  assert.equal(await exists(directory), false);

  // One that no longer holds what it held is displaced and reported, never deleted.
  assert.equal((await agents('install', '--agent', 'cursor')).code, 0);
  assert.equal((await agents('uninstall')).code, 0);
  const [name] = await previous(directory);
  await writeFile(join(directory, name), '{"mcpServers":{},"late":"write"}');
  const swept = await sync(anHourLater);
  const leftover = swept.json.results.find(item => item.kind === 'leftover');
  assert.equal(leftover.action, 'displaced');
  assert.equal(await readFile(leftover.path, 'utf8'), '{"mcpServers":{},"late":"write"}');
  assert.deepEqual(await previous(directory), []);
});
