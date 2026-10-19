// Installs a workspace's enabled skills and its MCP server into Claude Code and Codex.
// Installing is a reconciling sync recorded in <workspace>/.state/agents.json, so status
// and uninstall are exact and nothing the installer did not create is overwritten.
import { access, chmod, constants, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { KIT_ROOT } from './hubs.mjs';
import { loadAddons } from './addons.mjs';
import { initWorkspace, pinnedCoreSpec } from './workspace.mjs';
import { fail } from './files.mjs';
import { splitFrontmatter } from './okf.mjs';
import { generatedSkills } from './repos.mjs';

const exec = promisify(execFile);
const CODEX_KEYS = ['name', 'description', 'license', 'allowed-tools', 'metadata'];
const home = env => env.HOME || process.env.HOME;
const AGENTS = {
  claude: { cli: 'claude', keys: null,
    skills: (scope, env, project) => scope === 'user' ? join(env.CLAUDE_CONFIG_DIR || join(home(env), '.claude'), 'skills') : join(project, '.claude', 'skills') },
  codex: { cli: 'codex', keys: CODEX_KEYS,
    skills: (scope, env, project) => scope === 'user' ? join(env.CODEX_HOME || join(home(env), '.codex'), 'skills') : join(project, '.agents', 'skills') },
};

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}
async function which(command, env) {
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    try { await access(join(directory, command), constants.X_OK); return join(directory, command); } catch { /* Next. */ }
  }
  return null;
}
async function hashTree(root) {
  const hash = createHash('sha256');
  const entries = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name)).sort();
  for (const file of entries) hash.update(relative(root, file)).update('\0').update(await readFile(file)).update('\0');
  return hash.digest('hex');
}
// Drop frontmatter keys an agent does not accept; null when nothing changes.
async function adapted(source, keys) {
  if (!keys) return null;
  const text = await readFile(join(source, 'SKILL.md'), 'utf8');
  const front = splitFrontmatter(text);
  if (!front || front.error || Object.keys(front.data).every(key => keys.includes(key))) return null;
  const kept = Object.fromEntries(Object.entries(front.data).filter(([key]) => keys.includes(key)));
  return `---\n${stringify(kept)}---\n${front.body}`;
}
async function linkTarget(path) {
  try { return (await lstat(path)).isSymbolicLink() ? await readlink(path) : null; } catch { return null; }
}
// installed | changed | missing, from the record.
async function skillState(record) {
  if (!await exists(record.path)) return 'missing';
  if (record.mode === 'link') return await linkTarget(record.path) === record.source ? 'installed' : 'changed';
  if (await linkTarget(record.path) !== null) return 'changed';
  return await hashTree(record.path) === record.installedHash ? 'installed' : 'changed';
}

const recordsPath = root => join(root, '.state', 'agents.json');
async function loadRecords(root) {
  try { return JSON.parse(await readFile(recordsPath(root), 'utf8')).items; }
  catch (error) { if (error.code === 'ENOENT') return []; fail('INVALID_CONFIG', `${recordsPath(root)}: ${error.message}`); }
}
async function saveRecords(root, items) {
  await mkdir(join(root, '.state'), { recursive: true });
  await writeFile(recordsPath(root), JSON.stringify({ version: 1, items }, null, 2) + '\n');
}

// Named after the workspace, always including "context": agents reserve generic names
// (Claude Code rejects "workspace").
export function serverName(root, override) {
  if (override !== undefined) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(override)) fail('INVALID_INPUT', `Server names are kebab-case: ${override}`);
    return override;
  }
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return !name ? 'context-kit' : name.includes('context') ? name : `context-${name}`;
}
function parseOptions(options) {
  const agents = options.agents ?? ['claude', 'codex'];
  if (!agents.length || agents.some(agent => !AGENTS[agent])) fail('INVALID_INPUT', `Agents are claude and codex: ${agents.join(',')}`);
  const scope = options.scope ?? 'user';
  if (!['user', 'project'].includes(scope)) fail('INVALID_INPUT', 'Scope is user or project');
  return { agents, scope, project: resolve(options.project ?? process.cwd()), env: options.env ?? process.env };
}
async function run(cli, args, env, cwd) {
  return exec(cli, args, { env, cwd, timeout: 60000, maxBuffer: 1024 * 1024 });
}

async function installSkill(agent, skill, directory, records, results, { link, force }) {
  const target = join(directory, skill.name);
  const record = records.find(item => item.kind === 'skill' && item.agent === agent && item.path === target);
  const content = await adapted(skill.path, AGENTS[agent].keys);
  const report = (action, extra = {}) => results.push({ agent, kind: 'skill', name: skill.name, path: target, action, ...extra });
  // Generated skills are always copied, so the installed file is exactly what was rendered.
  if (link && content && !skill.generated) return report('conflict', { reason: `${agent} needs adapted frontmatter; install this skill without --link` });
  const mode = link && !skill.generated ? 'link' : 'copy';
  const sourceHash = await hashTree(skill.path);
  if (await exists(target)) {
    if (!record) {
      if (!force) return report('conflict', { reason: `${target} exists and was not installed by Context Kit; remove it or pass --force` });
    } else {
      const state = await skillState(record);
      if (state === 'changed' && !force) return report('conflict', { reason: `${target} was edited since install; pass --force to replace it` });
      if (state === 'installed' && record.mode === mode && record.source === skill.path && (mode === 'link' || record.sourceHash === sourceHash)) {
        return report('unchanged');
      }
    }
    await rm(target, { recursive: true, force: true });
  }
  if (mode === 'link') {
    await symlink(skill.path, target, 'dir');
  } else {
    // Copy beside the target, then rename, so a failure never leaves a partial skill.
    const temporary = await mkdtemp(join(directory, `.context-kit-${skill.name}-`));
    try {
      await cp(skill.path, temporary, { recursive: true });
      if (content) await writeFile(join(temporary, 'SKILL.md'), content);
      await rename(temporary, target);
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  const entry = { agent, kind: 'skill', name: skill.name, path: target, source: skill.path, mode, sourceHash, ...(skill.generated ? { generated: true } : {}),
    ...(mode === 'copy' ? { installedHash: await hashTree(target) } : {}) };
  records.splice(0, records.length, ...records.filter(item => item !== record), entry);
  report(record ? 'updated' : 'installed');
}

// Pull hooks: when the workspace is a git checkout, post-merge and post-rewrite run
// `repos sync` so generated skills follow pulled hub changes. They name this machine's
// Node and core, so they live in the checkout's hooks directory, never in the workspace.
const HOOKS = ['post-merge', 'post-rewrite'];
const HOOK_MARK = '# Managed by Context Kit (agents install).';
const sha = text => createHash('sha256').update(text).digest('hex');
function hookScript(root) {
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh\n${HOOK_MARK} Rebuilds generated skills after a pull; never fails it.\n` +
    `${quote(process.execPath)} ${quote(join(KIT_ROOT, 'bin', 'hub.mjs'))} --root ${quote(root)} repos sync >/dev/null 2>&1 ||\n` +
    `  echo 'context-kit: repos sync failed; run it in the workspace: npm run hub -- repos sync' >&2\nexit 0\n`;
}
async function hooksDirectory(root) {
  try {
    const top = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root, timeout: 10000 })).stdout.trim();
    if (await realpath(top) !== await realpath(root)) return null;
    return resolve(root, (await exec('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: root, timeout: 10000 })).stdout.trim());
  } catch { return null; }
}
async function hookState(record) {
  const text = await readFile(record.path, 'utf8').catch(() => null);
  return text === null ? 'missing' : sha(text) === record.installedHash ? 'installed' : 'changed';
}
async function installHooks(root, records, { force = false }) {
  const directory = await hooksDirectory(root);
  if (!directory) return HOOKS.map(name => ({ kind: 'hook', name, action: 'skipped', reason: 'the workspace is not the top of a git checkout; run git init, then agents install' }));
  await mkdir(directory, { recursive: true });
  const script = hookScript(root);
  const results = [];
  for (const name of HOOKS) {
    const path = join(directory, name);
    const record = records.find(item => item.kind === 'hook' && item.path === path);
    const report = (action, extra = {}) => results.push({ kind: 'hook', name, path, action, ...extra });
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current !== null && !force) {
      if (!record && !current.includes(HOOK_MARK)) { report('conflict', { reason: `${path} exists and was not installed by Context Kit; add a repos sync line to it, or pass --force` }); continue; }
      if (record && await hookState(record) === 'changed') { report('conflict', { reason: `${path} was edited since install; pass --force to replace it` }); continue; }
      if (current === script) { if (!record) records.push({ kind: 'hook', name, path, installedHash: sha(script) }); report('unchanged'); continue; }
    }
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
    records.splice(0, records.length, ...records.filter(item => item !== record), { kind: 'hook', name, path, installedHash: sha(script) });
    report(record || current !== null ? 'updated' : 'installed');
  }
  return results;
}

// The merge tripwire: one Claude Code PreToolUse entry running this workspace's
// bin/merge-guard.mjs, written to the install scope's settings file. An entry belongs to
// this workspace when one of its command hooks contains that absolute path; nothing else
// (position, matcher) selects it, so other hooks and other workspaces' guards are left alone.
const GUARD_NAME = 'merge-guard';
const guardScript = () => join(KIT_ROOT, 'bin', 'merge-guard.mjs');
const guardEntry = () => ({ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${guardScript()}"` }] });
const settingsFile = (scope, env, project) => scope === 'user'
  ? join(env.CLAUDE_CONFIG_DIR || join(home(env), '.claude'), 'settings.json') : join(project, '.claude', 'settings.local.json');
const ownsEntry = entry => Array.isArray(entry?.hooks) && entry.hooks.some(hook => typeof hook?.command === 'string' && hook.command.includes(guardScript()));
// { settings, text, indent } or { missing: true }; malformed JSON or hooks refuse.
async function readSettings(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { settings: {}, missing: true }; throw error; }
  let settings;
  try { settings = JSON.parse(text); } catch (error) { fail('SETTINGS_MALFORMED', `${path} is not valid JSON (${error.message}); fix it, then agents install`); }
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!plain(settings) || (settings.hooks !== undefined && !plain(settings.hooks)) || (settings.hooks?.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse))) {
    fail('SETTINGS_MALFORMED', `${path} does not hold settings with a hooks.PreToolUse list; fix it, then agents install`);
  }
  return { settings, indent: text.match(/^[ \t]+(?=")/m)?.[0] ?? '  ', newline: text.endsWith('\n') };
}
// Temporary file beside the target, then rename: a reader never sees half a file.
async function writeSettings(path, settings, { indent = '  ', newline = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.context-kit-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary, JSON.stringify(settings, null, indent) + (newline ? '\n' : ''));
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
function guardState(settings, entry) {
  const entries = settings.hooks?.PreToolUse ?? [];
  if (entries.some(item => isDeepStrictEqual(item, entry))) return 'installed';
  return entries.some(ownsEntry) ? 'edited' : 'missing';
}
async function installGuard(agent, scope, env, project, records, { force = false }) {
  const base = { agent, kind: 'guard', name: GUARD_NAME };
  if (agent === 'codex') return { ...base, action: 'unsupported', reason: 'Codex has no pre-command hook, so raw merges are not intercepted there; use context-kit pr land' };
  const path = settingsFile(scope, env, project);
  const result = { ...base, path };
  let current;
  try { current = await readSettings(path); }
  catch (error) { if (error.code === 'SETTINGS_MALFORMED') return { ...result, action: 'refused', code: error.code, reason: error.message }; throw error; }
  const entry = guardEntry();
  const record = records.find(item => item.kind === 'guard' && item.path === path);
  const remember = (extra = {}) => {
    const kept = { kind: 'guard', agent, name: GUARD_NAME, scope, path, ...(scope === 'project' ? { project } : {}), entry,
      createdFile: record?.createdFile ?? Boolean(current.missing), ...extra };
    records.splice(0, records.length, ...records.filter(item => item !== record), kept);
  };
  const { settings } = current;
  const state = guardState(settings, entry);
  if (state === 'installed') { remember(); return { ...result, action: 'unchanged' }; }
  if (state === 'edited' && !force) {
    remember();
    return { ...result, action: 'edited', reason: `${path} holds an edited merge-guard entry; it is kept. Pass --force to replace it` };
  }
  const entries = settings.hooks?.PreToolUse ?? [];
  const first = entries.findIndex(ownsEntry);
  const next = entries.filter(item => !ownsEntry(item));
  next.splice(first < 0 ? next.length : entries.slice(0, first).filter(item => !ownsEntry(item)).length, 0, entry);
  settings.hooks = { ...(settings.hooks ?? {}), PreToolUse: next };
  await writeSettings(path, settings, current);
  remember();
  return { ...result, action: state === 'edited' ? 'updated' : 'installed' };
}
async function guardStatus(record) {
  try { return guardState((await readSettings(record.path)).settings, record.entry); }
  catch (error) { if (error.code === 'SETTINGS_MALFORMED') return 'malformed'; throw error; }
}
// Removes exactly the recorded entry if it is still as written; an edited one is kept.
async function uninstallGuard(record, { force = false }) {
  const result = { agent: record.agent, kind: 'guard', name: record.name, path: record.path };
  let current;
  try { current = await readSettings(record.path); }
  catch (error) { if (error.code === 'SETTINGS_MALFORMED') return { ...result, action: 'kept', code: error.code, reason: error.message }; throw error; }
  const { settings } = current;
  const state = guardState(settings, record.entry);
  if (state === 'missing') return { ...result, action: 'removed', reason: 'already absent' };
  if (state === 'edited' && !force) return { ...result, action: 'kept', state: 'edited', reason: 'edited since install; pass --force to remove it' };
  const entries = settings.hooks.PreToolUse;
  const at = entries.findIndex(item => isDeepStrictEqual(item, record.entry));
  const next = state === 'installed' ? entries.filter((_, index) => index !== at) : entries.filter(item => !ownsEntry(item));
  if (next.length) settings.hooks.PreToolUse = next;
  else delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (record.createdFile && !Object.keys(settings).length) await rm(record.path, { force: true });
  else await writeSettings(record.path, settings, current);
  return { ...result, action: 'removed' };
}

async function mcpExists(agent, cli, name, env, cwd) {
  try { await run(cli, ['mcp', 'get', name], env, cwd); return true; } catch { return false; }
}

export async function installAgents(root, options = {}) {
  const { agents, scope, project, env } = parseOptions(options);
  const skills = [...(await loadAddons(root)).filter(addon => addon.enabled).flatMap(addon => addon.skills), ...await generatedSkills(root)];
  const records = await loadRecords(root);
  const results = [];
  for (const agent of agents) {
    const directory = AGENTS[agent].skills(scope, env, project);
    await mkdir(directory, { recursive: true });
    for (const skill of skills) await installSkill(agent, skill, directory, records, results, options);
    // Remove unchanged skills this installer placed here that no enabled addon provides now.
    for (const record of records.filter(item => item.kind === 'skill' && item.agent === agent && resolve(item.path, '..') === directory &&
        !skills.some(skill => skill.name === item.name))) {
      if (await skillState(record) === 'changed') { results.push({ agent, kind: 'skill', name: record.name, path: record.path, action: 'kept', reason: 'edited since install' }); continue; }
      await rm(record.path, { recursive: true, force: true });
      records.splice(records.indexOf(record), 1);
      results.push({ agent, kind: 'skill', name: record.name, path: record.path, action: 'removed' });
    }
    results.push(await registerServer(root, agent, scope, project, env, records, options));
    results.push(await installGuard(agent, scope, env, project, records, options));
  }
  results.push(...await installHooks(root, records, options));
  await saveRecords(root, records);
  return { root, scope, results };
}

async function registerServer(root, agent, scope, project, env, records, { allowWrite = false, globalMcp = false, force = false, name: override }) {
  const name = serverName(root, override);
  const base = { agent, kind: 'mcp', name };
  if (agent === 'codex' && scope === 'project' && !globalMcp) {
    return { ...base, action: 'skipped', reason: 'Codex has no project-scoped MCP; pass --global-mcp to register it for the user' };
  }
  const cli = await which(AGENTS[agent].cli, env);
  if (!cli) return { ...base, action: 'skipped', reason: `${AGENTS[agent].cli} CLI not found on PATH` };
  const agentScope = agent === 'claude' ? (scope === 'user' ? 'user' : 'local') : 'user';
  const cwd = scope === 'project' ? project : root;
  const record = records.find(item => item.kind === 'mcp' && item.agent === agent && item.name === name && item.scope === agentScope && (agentScope !== 'local' || item.project === project));
  if (!record && await mcpExists(agent, cli, name, env, cwd) && !force) {
    return { ...base, action: 'conflict', reason: `${agent} already has an MCP server named ${name}; remove it or pass --force` };
  }
  // Absolute paths: MCP clients started outside a shell may not see nvm's PATH.
  const command = [process.execPath, join(KIT_ROOT, 'bin', 'mcp.mjs'), '--root', root, '--no-skill-prompts', ...(allowWrite ? ['--allow-write'] : [])];
  const scopeArgs = agent === 'claude' ? ['-s', agentScope] : [];
  await run(cli, ['mcp', 'remove', ...scopeArgs, name], env, cwd).catch(() => {});
  try { await run(cli, ['mcp', 'add', ...scopeArgs, name, '--', ...command], env, cwd); }
  catch (error) { return { ...base, action: 'failed', reason: (error.stderr || error.message).trim().split('\n')[0] }; }
  if (record) records.splice(records.indexOf(record), 1);
  records.push({ ...base, scope: agentScope, ...(agentScope === 'local' ? { project } : {}), command });
  return { ...base, scope: agentScope, action: record ? 'updated' : 'installed' };
}

export async function agentStatus(root, options = {}) {
  const env = options.env ?? process.env;
  const items = [];
  await generatedSkills(root);
  for (const record of await loadRecords(root)) {
    if (record.kind === 'hook') { items.push({ kind: 'hook', name: record.name, path: record.path, state: await hookState(record) }); continue; }
    if (record.kind === 'guard') { items.push({ agent: record.agent, kind: 'guard', name: record.name, scope: record.scope, path: record.path, state: await guardStatus(record) }); continue; }
    if (record.kind === 'skill') {
      let state = await skillState(record);
      if (state === 'installed' && record.mode === 'copy' && (!await exists(record.source) || await hashTree(record.source) !== record.sourceHash)) state = 'stale';
      items.push({ agent: record.agent, kind: 'skill', name: record.name, path: record.path, mode: record.mode, state });
    } else {
      const cli = await which(AGENTS[record.agent].cli, env);
      const cwd = record.project ?? root;
      let state = cli ? (await mcpExists(record.agent, cli, record.name, env, cwd) ? 'installed' : 'missing') : 'unknown';
      if (state === 'installed' && !await exists(record.command[0])) state = 'broken';
      items.push({ agent: record.agent, kind: 'mcp', name: record.name, scope: record.scope, state,
        ...(state === 'broken' ? { reason: `${record.command[0]} no longer exists; run agents install again` } : {}) });
    }
  }
  return { root, items };
}

export async function uninstallAgents(root, options = {}) {
  const env = options.env ?? process.env;
  const agents = options.agents ?? ['claude', 'codex'];
  const remaining = [];
  const results = [];
  const all = await loadRecords(root);
  // Hooks serve every agent, so they go only when no agent's items remain installed.
  const hooks = all.filter(record => record.kind === 'hook');
  for (const record of all.filter(item => item.kind !== 'hook')) {
    if (!agents.includes(record.agent)) { remaining.push(record); continue; }
    if (record.kind === 'guard') {
      const result = await uninstallGuard(record, options);
      if (result.action === 'kept') remaining.push(record);
      results.push(result);
      continue;
    }
    const base = { agent: record.agent, kind: record.kind, name: record.name };
    if (record.kind === 'skill') {
      const state = await skillState(record);
      if (state === 'changed' && !options.force) { remaining.push(record); results.push({ ...base, path: record.path, action: 'kept', reason: 'edited since install' }); continue; }
      await rm(record.path, { recursive: true, force: true });
      results.push({ ...base, path: record.path, action: 'removed' });
    } else {
      const cli = await which(AGENTS[record.agent].cli, env);
      if (!cli) { remaining.push(record); results.push({ ...base, action: 'kept', reason: `${AGENTS[record.agent].cli} CLI not found on PATH` }); continue; }
      const scopeArgs = record.agent === 'claude' ? ['-s', record.scope] : [];
      await run(cli, ['mcp', 'remove', ...scopeArgs, record.name], env, record.project ?? root).catch(() => {});
      results.push({ ...base, action: 'removed' });
    }
  }
  for (const record of hooks) {
    if (remaining.length) { remaining.push(record); continue; }
    const state = await hookState(record);
    if (state === 'changed' && !options.force) { remaining.push(record); results.push({ kind: 'hook', name: record.name, path: record.path, action: 'kept', reason: 'edited since install' }); continue; }
    await rm(record.path, { force: true });
    results.push({ kind: 'hook', name: record.name, path: record.path, action: 'removed' });
  }
  await saveRecords(root, remaining);
  return { root, results };
}

// After repositories change: re-render generated skills and update every installed,
// unchanged copy in place, without touching MCP registrations.
export async function refreshGeneratedSkills(root) {
  const skills = await generatedSkills(root);
  const records = await loadRecords(root);
  const results = [];
  for (const record of records.filter(item => item.kind === 'skill' && item.generated)) {
    const skill = skills.find(item => item.name === record.name);
    if (!skill) continue;
    if (await skillState(record) === 'missing') { results.push({ agent: record.agent, kind: 'skill', name: record.name, path: record.path, action: 'skipped', reason: 'not installed there any more; run agents install' }); continue; }
    await installSkill(record.agent, skill, resolve(record.path, '..'), records, results, { link: false, force: false });
  }
  await saveRecords(root, records);
  return results;
}

// One command: a pinned instance, its dependencies, and its agents install, run by the
// instance's own pinned core.
export async function setupWorkspace(path, { kit, addons, installArgs = [], env = process.env } = {}) {
  const core = kit === undefined ? await pinnedCoreSpec() : { spec: kit, pinned: true };
  const created = await initWorkspace(path, { kit: core.spec, addons });
  await exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: created.root, env, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const { stdout } = await exec(process.execPath, [join(created.root, 'node_modules', 'context-kit', 'bin', 'hub.mjs'),
    '--root', created.root, 'agents', 'install', ...installArgs], { env, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  return { root: created.root, core, addons: created.addons, agents: JSON.parse(stdout) };
}
