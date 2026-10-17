// Installs a workspace's enabled skills and its MCP server into Claude Code and Codex.
// Installing is a reconciling sync recorded in <workspace>/.state/agents.json, so status
// and uninstall are exact and nothing the installer did not create is overwritten.
import { access, constants, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, delimiter, join, relative, resolve } from 'node:path';
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
  }
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
  for (const record of await loadRecords(root)) {
    if (!agents.includes(record.agent)) { remaining.push(record); continue; }
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
