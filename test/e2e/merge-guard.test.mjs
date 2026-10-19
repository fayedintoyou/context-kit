import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const exists = path => lstat(path).then(() => true, () => false);

const DENY = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: 'Raw pull request merges are blocked by the Context Kit merge tripwire. ' +
    'Land it with: context-kit pr land <number> --sha <tested head SHA>. It checks the repository\'s expected checks ' +
    'and, for substantial work, the review record, then merges pinned to that SHA.' } };

// Runs the hook as Claude Code does: the PreToolUse payload on stdin.
function hook(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(kit, 'bin/merge-guard.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(input);
  });
}
// A real Claude Code PreToolUse payload for the Bash tool.
const payload = command => JSON.stringify({ session_id: '5f1c7a52-0d1b-4c2e-9a35-2f8d1c0e6b7a', transcript_path: '/Users/me/.claude/projects/-Users-me-src/5f1c7a52.jsonl',
  cwd: '/Users/me/src/widgets', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command, description: 'Run a command' }, tool_use_id: 'toolu_01AbCdEf' });

// spec: pull-request-landing / A raw merge is caught
test('the tripwire denies raw merges in any segment, flag order or ordinary quoting', async () => {
  const denied = [
    'gh pr merge 5',
    'gh pr merge 5 --squash --delete-branch',
    'gh -R acme/widgets pr merge 5',
    'gh pr merge --repo acme/widgets --auto 5',
    'gh api -X PUT repos/o/r/pulls/5/merge',
    'gh api repos/o/r/pulls/5/merge -XPUT -f sha=abc',
    'gh api --method PUT /repos/o/r/pulls/5/merge',
    "gh api -X put 'repos/o/r/pulls/5/merge'",
    'GH_DEBUG=1 gh api --method=put "/repos/o/r/pulls/5/merge"',
    'context-kit pr land 5 --sha abc && GH_DEBUG=1 gh api --method=put "/repos/o/r/pulls/5/merge"',
    'npm test && gh pr merge 5',
    'git push; gh pr merge 5',
    'npm test || gh pr merge 5',
    'echo yes | gh pr merge 5',
    'sleep 1 & gh pr merge 5',
    'npm test\ngh pr merge 5',
    'echo "merged: $(gh pr merge 5)"',
    'x=`gh api -XPUT repos/o/r/pulls/1/merge`',
    'env GH_HOST=github.com gh pr merge 5',
    'time command gh pr merge 5',
    '/opt/homebrew/bin/gh pr merge 5',
    'g\\h pr merge 5',
    // Wrapper options are read past.
    'env -i gh pr merge 5',
    'env - gh pr merge 5',
    'env -u GH_REPO gh pr merge 5',
    'env --unset=GH_REPO gh pr merge 5',
    'env -C /tmp gh pr merge 5',
    'env --chdir=/tmp gh pr merge 5',
    'env -i -u GH_REPO A=1 B=2 gh api -X PUT repos/o/r/pulls/5/merge',
    'time -p gh pr merge 5',
    'time -a -o /tmp/t gh pr merge 5',
    'time -v gh pr merge 5',
    'time -o /tmp/t gh pr merge 5',
    'time -f "%e" gh pr merge 5',
    'time --output=/tmp/t gh pr merge 5',
    'time --format=%e gh pr merge 5',
    'command -p gh pr merge 5',
    'env -u GH_REPO time -p command -p gh pr merge 5',
  ];
  for (const command of denied) {
    const result = await hook(payload(command));
    assert.equal(result.code, 0, command);
    assert.deepEqual(JSON.parse(result.stdout), DENY, command);
  }
});

// spec: pull-request-landing / Other commands run
test('other commands produce no decision, and an unreadable payload fails open', async () => {
  const allowed = [
    'gh pr view 5',
    'gh api repos/o/r/pulls/5',
    'gh api repos/o/r/pulls/5/merge',
    'gh api -X GET repos/o/r/pulls/5/merge',
    'echo "gh pr merge"',
    "echo 'gh api -X PUT repos/o/r/pulls/5/merge'",
    'context-kit pr land 5 --sha abc',
    'git merge main',
    'gh pr list --search merge',
    'gh api -X PUT repos/o/r/pulls/5/requested_reviewers',
    'command -v gh',
    // Out of the contract, as documented: env -S strings.
    'env -S "gh pr merge 5"',
  ];
  for (const command of allowed) {
    const result = await hook(payload(command));
    assert.deepEqual([result.code, result.stdout], [0, ''], command);
  }
  const other = await hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/gh pr merge 5' } }));
  assert.deepEqual([other.code, other.stdout], [0, '']);
  const unreadable = await hook('not json');
  assert.deepEqual([unreadable.code, unreadable.stdout], [0, '']);
  assert.match(unreadable.stderr, /could not read the hook payload, allowing/);
});

// An isolated machine without agent CLIs (MCP registration is skipped), and workspaces.
async function machine(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-guard-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'),
    XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'), PATH: '/usr/bin:/bin' };
  await mkdir(env.HOME);
  const run = async (core, args, extra = {}) => {
    try { return { code: 0, json: JSON.parse((await exec(process.execPath, [join(core, 'bin/hub.mjs'), ...args], { env: { ...env, ...extra }, cwd: base })).stdout) }; }
    catch (error) { return { code: error.code, error: error.stderr }; }
  };
  const workspace = async (name, core = kit) => {
    const path = join(base, name);
    assert.equal((await run(core, ['init', path])).code, 0);
    return { path, core, agents: (...args) => run(core, ['--root', path, 'agents', ...args]) };
  };
  return { base, env, run, workspace, user: join(env.CLAUDE_CONFIG_DIR, 'settings.json') };
}
const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
const entryFor = core => ({ matcher: 'Bash', hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(join(core, 'bin/merge-guard.mjs'))}` }] });
const guards = results => results.filter(item => item.kind === 'guard').map(item => [item.agent, item.action]);
const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('user scope writes Claude Code\'s user settings, under CLAUDE_CONFIG_DIR or ~/.claude', async t => {
  const { env, workspace, user } = await machine(t);
  const one = await workspace('one');
  const installed = await one.agents('install', '--agent', 'claude');
  assert.deepEqual(guards(installed.json.results), [['claude', 'installed']]);
  assert.deepEqual(await json(user), { hooks: { PreToolUse: [entryFor(kit)] } });
  const status = await one.agents('status');
  assert.deepEqual(status.json.items.filter(item => item.kind === 'guard').map(item => [item.scope, item.path, item.state]), [['user', user, 'installed']]);
  const two = await workspace('two');
  const result = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', two.path, 'agents', 'install', '--agent', 'claude'],
    { env: { ...env, CLAUDE_CONFIG_DIR: '' } });
  assert.deepEqual(guards(JSON.parse(result.stdout).results), [['claude', 'installed']]);
  assert.deepEqual(await json(join(env.HOME, '.claude/settings.json')), { hooks: { PreToolUse: [entryFor(kit)] } });
});

// spec: agent-installation / Scoped to the project
test('project scope writes the project\'s settings.local.json and leaves user settings alone', async t => {
  const { base, workspace, user } = await machine(t);
  const one = await workspace('one');
  const project = join(base, 'project');
  await mkdir(project);
  const installed = await one.agents('install', '--agent', 'claude', '--scope', 'project', '--project', project);
  assert.deepEqual(guards(installed.json.results), [['claude', 'installed']]);
  assert.deepEqual(await json(join(project, '.claude/settings.local.json')), { hooks: { PreToolUse: [entryFor(kit)] } });
  assert.equal(await exists(user), false);
  const removed = await one.agents('uninstall', '--agent', 'claude');
  assert.deepEqual(guards(removed.json.results), [['claude', 'removed']]);
  assert.equal(await exists(join(project, '.claude/settings.local.json')), false, 'a file the install created goes when empty');
});

// spec: agent-installation / Other hooks are kept
test('a repeated install is unchanged, and uninstall leaves the settings exactly as before', async t => {
  const { workspace, user } = await machine(t);
  const one = await workspace('one');
  const original = JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit-bash' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] } }, null, 2) + '\n';
  await mkdir(join(user, '..'), { recursive: true });
  await writeFile(user, original);
  assert.deepEqual(guards((await one.agents('install', '--agent', 'claude')).json.results), [['claude', 'installed']]);
  const settings = await json(user);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.PreToolUse, [JSON.parse(original).hooks.PreToolUse[0], entryFor(kit)]);
  assert.deepEqual(settings.hooks.PostToolUse, JSON.parse(original).hooks.PostToolUse);
  const again = await one.agents('install', '--agent', 'claude');
  assert.deepEqual(guards(again.json.results), [['claude', 'unchanged']]);
  assert.equal((await json(user)).hooks.PreToolUse.length, 2);
  assert.deepEqual(guards((await one.agents('uninstall', '--agent', 'claude')).json.results), [['claude', 'removed']]);
  assert.equal(await readFile(user, 'utf8'), original);
});

// spec: agent-installation / Malformed or edited settings
test('malformed settings are refused untouched, and an edited entry is kept and reported', async t => {
  const { workspace, user } = await machine(t);
  const one = await workspace('one');
  await mkdir(join(user, '..'), { recursive: true });
  await writeFile(user, '{ "model": "opus", ');
  const refused = (await one.agents('install', '--agent', 'claude')).json.results.find(item => item.kind === 'guard');
  assert.deepEqual([refused.action, refused.code], ['refused', 'SETTINGS_MALFORMED']);
  assert.equal(await readFile(user, 'utf8'), '{ "model": "opus", ');

  await writeFile(user, '{}\n');
  await one.agents('install', '--agent', 'claude');
  const settings = await json(user);
  settings.hooks.PreToolUse[0].hooks[0].command += ' --verbose';
  settings.hooks.PreToolUse[0].hooks[0].timeout = 5;
  await writeFile(user, JSON.stringify(settings, null, 2) + '\n');
  const edited = JSON.stringify(settings, null, 2) + '\n';
  assert.deepEqual(guards((await one.agents('install', '--agent', 'claude')).json.results), [['claude', 'edited']]);
  assert.deepEqual((await one.agents('status')).json.items.filter(item => item.kind === 'guard').map(item => item.state), ['edited']);
  const kept = (await one.agents('uninstall', '--agent', 'claude')).json.results.find(item => item.kind === 'guard');
  assert.deepEqual([kept.action, kept.state], ['kept', 'edited']);
  assert.equal(await readFile(user, 'utf8'), edited);
  // An edit that drops the path can't be told from a foreign hook: missing, and left alone.
  settings.hooks.PreToolUse[0].hooks[0].command = 'node /somewhere/else.mjs';
  await writeFile(user, JSON.stringify(settings, null, 2) + '\n');
  assert.deepEqual((await one.agents('status')).json.items.filter(item => item.kind === 'guard').map(item => item.state), ['missing']);
  assert.deepEqual(guards((await one.agents('install', '--agent', 'claude')).json.results), [['claude', 'installed']]);
  assert.deepEqual((await json(user)).hooks.PreToolUse, [settings.hooks.PreToolUse[0], entryFor(kit)]);
});

// A second core, as a second workspace pinned to its own copy of Context Kit would have.
async function secondCore(base) {
  const core = join(base, 'kit-two');
  for (const name of ['bin', 'lib', 'skills', 'addons', 'package.json']) await cp(join(kit, name), join(core, name), { recursive: true });
  await symlink(join(kit, 'node_modules'), join(core, 'node_modules'));
  return core;
}

// spec: agent-installation / Forcing past an edit
test('--force replaces only this workspace\'s edited entry among reordered and foreign hooks', async t => {
  const { base, workspace, user } = await machine(t);
  const other = await workspace('other', await secondCore(base));
  const one = await workspace('one');
  await other.agents('install', '--agent', 'claude');
  await one.agents('install', '--agent', 'claude');
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit-bash' }] };
  const settings = await json(user);
  const [theirs, mine] = settings.hooks.PreToolUse;
  assert.deepEqual([theirs, mine], [entryFor(other.core), entryFor(kit)]);
  const editedMine = { ...mine, hooks: [{ ...mine.hooks[0], command: `${mine.hooks[0].command} --edited` }] };
  settings.hooks.PreToolUse = [editedMine, foreign, theirs];
  await writeFile(user, JSON.stringify(settings, null, 2) + '\n');
  assert.deepEqual(guards((await one.agents('install', '--agent', 'claude')).json.results), [['claude', 'edited']]);
  assert.deepEqual(guards((await one.agents('install', '--agent', 'claude', '--force')).json.results), [['claude', 'updated']]);
  assert.deepEqual((await json(user)).hooks.PreToolUse, [entryFor(kit), foreign, theirs]);
  // Each workspace owns its own entry: uninstalling one leaves the other's installed.
  assert.deepEqual(guards((await one.agents('uninstall', '--agent', 'claude')).json.results), [['claude', 'removed']]);
  assert.deepEqual((await json(user)).hooks.PreToolUse, [foreign, theirs]);
  assert.deepEqual((await other.agents('status')).json.items.filter(item => item.kind === 'guard').map(item => item.state), ['installed']);
});

// spec: agent-installation / Codex
test('Codex is reported unsupported for the tripwire', async t => {
  const { workspace } = await machine(t);
  const one = await workspace('one');
  const result = (await one.agents('install', '--agent', 'codex')).json.results.find(item => item.kind === 'guard');
  assert.equal(result.action, 'unsupported');
  assert.match(result.reason, /Codex has no pre-command hook/);
  assert.deepEqual((await one.agents('status')).json.items.filter(item => item.kind === 'guard'), []);
});

test('the installed hook command runs with a PATH that has no node', async t => {
  const { workspace, user } = await machine(t);
  const one = await workspace('one');
  await one.agents('install', '--agent', 'claude');
  const [command] = (await json(user)).hooks.PreToolUse[0].hooks.map(item => item.command);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env: { PATH: '/nonexistent' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(payload('gh pr merge 5'));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), DENY);
});

test('settings keep their mode through install and uninstall, a new file is 0600, and a failed write leaves the file intact', async t => {
  const { base, workspace, user } = await machine(t);
  const one = await workspace('one');
  await mkdir(join(user, '..'), { recursive: true });
  await writeFile(user, '{\n  "model": "opus"\n}\n', { mode: 0o600 });
  await chmod(user, 0o600);
  await one.agents('install', '--agent', 'claude');
  assert.equal((await stat(user)).mode & 0o777, 0o600);
  await one.agents('uninstall', '--agent', 'claude');
  assert.equal((await stat(user)).mode & 0o777, 0o600);
  await chmod(user, 0o640);
  await one.agents('install', '--agent', 'claude');
  assert.equal((await stat(user)).mode & 0o777, 0o640);
  const project = join(base, 'project');
  await mkdir(project);
  await one.agents('install', '--agent', 'claude', '--scope', 'project', '--project', project);
  assert.equal((await stat(join(project, '.claude/settings.local.json'))).mode & 0o777, 0o600);
  // A directory that can't take the temporary file: the install fails for the guard alone.
  const locked = join(base, 'locked');
  await mkdir(join(locked, '.claude/skills'), { recursive: true });
  const before = '{\n  "model": "opus"\n}\n';
  await writeFile(join(locked, '.claude/settings.local.json'), before);
  await chmod(join(locked, '.claude'), 0o555);
  let failed;
  try { failed = (await one.agents('install', '--agent', 'claude', '--scope', 'project', '--project', locked)).json.results.find(item => item.kind === 'guard'); }
  finally { await chmod(join(locked, '.claude'), 0o755); }
  assert.equal(failed.action, 'failed');
  assert.match(failed.reason, /could not write/);
  assert.equal(await readFile(join(locked, '.claude/settings.local.json'), 'utf8'), before);
});

test('uninstall restores hook containers that existed before, even empty ones', async t => {
  const { workspace, user } = await machine(t);
  const one = await workspace('one');
  await mkdir(join(user, '..'), { recursive: true });
  for (const original of [{ hooks: {} }, { hooks: { PreToolUse: [] } }, { model: 'opus', hooks: { PreToolUse: [] } }]) {
    const text = JSON.stringify(original, null, 2) + '\n';
    await writeFile(user, text);
    assert.deepEqual(guards((await one.agents('install', '--agent', 'claude')).json.results), [['claude', 'installed']]);
    assert.deepEqual((await json(user)).hooks.PreToolUse, [entryFor(kit)]);
    assert.deepEqual(guards((await one.agents('uninstall', '--agent', 'claude')).json.results), [['claude', 'removed']]);
    assert.equal(await readFile(user, 'utf8'), text, JSON.stringify(original));
  }
});

test('workspaces run from the same core share one guard entry', async t => {
  const { workspace, user } = await machine(t);
  const one = await workspace('one');
  const two = await workspace('two');
  assert.deepEqual(guards((await one.agents('install', '--agent', 'claude')).json.results), [['claude', 'installed']]);
  assert.deepEqual(guards((await two.agents('install', '--agent', 'claude')).json.results), [['claude', 'unchanged']]);
  assert.deepEqual((await json(user)).hooks.PreToolUse, [entryFor(kit)]);
  assert.deepEqual(guards((await one.agents('uninstall', '--agent', 'claude')).json.results), [['claude', 'removed']]);
  assert.equal(await exists(user), false, 'the shared entry is gone with the file the install created');
  assert.deepEqual((await two.agents('status')).json.items.filter(item => item.kind === 'guard').map(item => item.state), ['missing']);
});
