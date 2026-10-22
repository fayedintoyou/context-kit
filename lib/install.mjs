// Installs a workspace's enabled skills and its MCP server into agent harnesses, and a
// `context-kit` launcher into the user's bin directory. Skills go to the fewest locations that
// cover the selection: Claude Code's directory and the shared ~/.agents/skills.
// Installing is a reconciling sync recorded in <workspace>/.state/agents.json, so status
// and uninstall are exact and nothing the installer did not create is overwritten.
import { access, chmod, constants, cp, link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { KIT_ROOT } from './hubs.mjs';
import { loadAddons } from './addons.mjs';
import { initWorkspace, pinnedCoreSpec } from './workspace.mjs';
import { fail } from './files.mjs';
import { splitFrontmatter } from './okf.mjs';
import { generatedSkills, isRoutingName, listRepositories, routingSkillNames, skippedNames } from './repos.mjs';

const exec = promisify(execFile);
// The Agent Skills standard keys, kept in the shared ~/.agents/skills copies.
const STANDARD_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
// What Codex copies under $CODEX_HOME/skills kept; only for refreshing legacy copies until they move.
const CODEX_KEYS = ['name', 'description', 'license', 'allowed-tools', 'metadata'];
const home = env => env.HOME || process.env.HOME;
const claudeSkills = env => join(env.CLAUDE_CONFIG_DIR || join(home(env), '.claude'), 'skills');
// Skill locations. A copy in one location serves every selected harness that reads it.
const LOCATIONS = {
  claude: { keys: null, directory: (scope, env, project) => scope === 'user' ? claudeSkills(env) : join(project, '.claude', 'skills') },
  agents: { keys: STANDARD_KEYS, guarded: true,
    directory: (scope, env, project) => join(scope === 'user' ? home(env) : project, '.agents', 'skills') },
};
// Harnesses and the locations each reads, from vendor documentation (2026-10-22). Cursor reads
// ~/.claude/skills literally, so a CLAUDE_CONFIG_DIR elsewhere is not one of its locations.
const AGENTS = {
  claude: { label: 'Claude Code', cli: 'claude', reads: () => ['claude'] },
  codex: { label: 'Codex', cli: 'codex', reads: () => ['agents'] },
  gemini: { label: 'Gemini CLI', cli: null, reads: () => ['agents'] },
  cursor: { label: 'Cursor', cli: null,
    reads: (scope, env) => scope === 'user' && claudeSkills(env) === join(home(env), '.claude', 'skills') ? ['agents', 'claude'] : ['agents'] },
};
const supported = () => Object.keys(AGENTS).join(', ');
function parseAgents(list, fallback = ['claude', 'codex']) {
  const agents = list ?? fallback;
  if (!agents.length || agents.some(agent => !AGENTS[agent])) fail('INVALID_INPUT', `Agents are ${supported()}: ${agents.join(',')}`);
  return agents;
}
// The fewest locations covering the selection: every location some harness reads alone, then,
// for a harness still uncovered, the first location it reads. Each maps to the harnesses it serves.
function skillLocations(agents, scope, env) {
  const chosen = new Set(agents.map(agent => AGENTS[agent].reads(scope, env)).filter(reads => reads.length === 1).map(([only]) => only));
  for (const agent of agents) {
    const reads = AGENTS[agent].reads(scope, env);
    if (!reads.some(location => chosen.has(location))) chosen.add(reads[0]);
  }
  return Object.keys(LOCATIONS).filter(location => chosen.has(location))
    .map(location => ({ location, agents: agents.filter(agent => AGENTS[agent].reads(scope, env).includes(location)) }));
}
const union = (...lists) => [...new Set(lists.flat())];
// Records written before shared locations name one agent; every record now lists the harnesses it serves.
const servedBy = record => record.agents ?? [record.agent];
const keysFor = record => record.location ? LOCATIONS[record.location].keys : servedBy(record).includes('codex') ? CODEX_KEYS : null;
// A Codex copy recorded under $CODEX_HOME/skills before the shared location existed.
const legacyCodex = record => record.kind === 'skill' && !record.location && servedBy(record).includes('codex') &&
  basename(dirname(dirname(record.path))) !== '.agents';
const writeCodes = new Set(['EACCES', 'EPERM', 'EROFS']);
const writeFailure = (error, path) => writeCodes.has(error.code)
  ? { code: 'NOT_WRITABLE', reason: `${path} is not writable` } : { code: 'WRITE_FAILED', reason: `could not write ${path} (${error.code ?? 'error'})` };

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}
async function which(command, env) {
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    try { await access(join(directory, command), constants.X_OK); return join(directory, command); } catch { /* Next. */ }
  }
  return null;
}
// With `skillText`, the hash the tree would have with that SKILL.md: what a copy must match.
async function hashTree(root, skillText = null) {
  const hash = createHash('sha256');
  const entries = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name)).sort();
  for (const file of entries) {
    const name = relative(root, file);
    hash.update(name).update('\0').update(skillText !== null && name === 'SKILL.md' ? skillText : await readFile(file)).update('\0');
  }
  return hash.digest('hex');
}
// The first symbolic link among the directories from below `anchor` down to `path`, or null.
// A shared location is written and deleted only through real directories, never through a link
// that points somewhere the user did not choose.
async function symlinkedBelow(anchor, path) {
  const steps = relative(anchor, path);
  if (!steps || steps.startsWith('..')) return null;
  let current = anchor;
  for (const step of steps.split(sep)) {
    current = join(current, step);
    try { if ((await lstat(current)).isSymbolicLink()) return current; } catch { return null; }
  }
  return null;
}
const anchorFor = (path, env) => relative(home(env), path).startsWith('..') ? dirname(dirname(path)) : home(env);
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
// `pending` is saved just before a swap: the new mode, source and content hash, and the device
// and inode of the built copy, which the rename keeps. Settling it after an interruption: if the
// path holds that very file with that content, the swap happened and the record takes the
// pending values; otherwise the record is what it was before (null for a first install, whose
// path then holds nothing of this installer's). An equal hash alone is never ownership.
async function settle(record) {
  if (!record.pending) return record;
  const { pending, ...prior } = record;
  const info = await lstat(record.path, { bigint: true }).catch(() => null);
  const same = info && String(info.dev) === pending.dev && String(info.ino) === pending.ino &&
    (pending.mode === 'link' ? await linkTarget(record.path) === pending.source : !info.isSymbolicLink() && await hashTree(record.path) === pending.hash);
  if (same) {
    const { installedHash: _, ...rest } = prior;
    return { ...rest, mode: pending.mode, source: pending.source, sourceHash: pending.sourceHash, ...(pending.mode === 'copy' ? { installedHash: pending.hash } : {}), recovered: true };
  }
  return pending.first ? null : prior;
}
// The copy an interrupted install built but never swapped in: the temporary beside the target
// with the recorded inode, provably this installer's, so it needn't wait for the hourly sweep.
async function discardBuilt(record) {
  const directory = dirname(record.path);
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.startsWith(`.context-kit-${record.name}-`) || name.endsWith('-old')) continue;
    const info = await lstat(join(directory, name), { bigint: true }).catch(() => null);
    if (info && String(info.dev) === record.pending.dev && String(info.ino) === record.pending.ino) await rm(join(directory, name), { recursive: true, force: true }).catch(() => {});
  }
}

const recordsPath = root => join(root, '.state', 'agents.json');
async function loadRecords(root) {
  try { return JSON.parse(await readFile(recordsPath(root), 'utf8')).items; }
  catch (error) { if (error.code === 'ENOENT') return []; fail('INVALID_CONFIG', `${recordsPath(root)}: ${error.message}`); }
}
// Temporary file beside the records, then rename: a crash mid-write never truncates them.
async function saveRecords(root, items) {
  await mkdir(join(root, '.state'), { recursive: true });
  const path = recordsPath(root);
  const temporary = `${path}.${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, items }, null, 2) + '\n');
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}
// Before changing anything: the records must be writable, or nothing installed or deleted could
// be recorded. A records file without write permission is refused as the user's choice.
async function ensureRecordsWritable(root, items) {
  const path = recordsPath(root);
  try {
    if (await exists(path)) await access(path, constants.W_OK);
    await saveRecords(root, items);
  } catch (error) {
    fail('RECORDS_UNWRITABLE', `${path} can't be written (${error.code ?? 'error'}), so nothing was changed; make it and ${dirname(path)} writable, then run this again`);
  }
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
  const agents = parseAgents(options.agents);
  const scope = options.scope ?? 'user';
  if (!['user', 'project'].includes(scope)) fail('INVALID_INPUT', 'Scope is user or project');
  if (options.name !== undefined) serverName('', options.name);
  return { agents, scope, project: resolve(options.project ?? process.cwd()), env: options.env ?? process.env };
}
async function run(cli, args, env, cwd) {
  return exec(cli, args, { env, cwd, timeout: 60000, maxBuffer: 1024 * 1024 });
}

// Puts one skill into one location's directory, for the harnesses that location serves there.
async function installSkill(place, skill, records, results, { link, force, root }) {
  const { location = null, agents, directory, keys, scope } = place;
  const target = join(directory, skill.name);
  let record = records.find(item => item.kind === 'skill' && item.path === target);
  let recovered = false;
  if (record?.pending) {
    const settled = await settle(record);
    if (!settled?.recovered) await discardBuilt(record);
    records.splice(records.indexOf(record), 1, ...(settled ? [settled] : []));
    recovered = Boolean(settled?.recovered);
    if (settled) delete settled.recovered;
    record = settled ?? undefined;
  }
  const served = union(record ? servedBy(record) : [], agents);
  const content = await adapted(skill.path, keys);
  const report = (action, extra = {}) => results.push({ agent: served[0], agents: served, kind: 'skill', name: skill.name, path: target, action, ...extra });
  // Generated skills are always copied, so the installed file is exactly what was rendered.
  if (link && content && !skill.generated) return report('conflict', { code: 'LINK_NEEDS_COPY', reason: `${target} needs adapted frontmatter; install this skill without --link` });
  const mode = link && !skill.generated ? 'link' : 'copy';
  const sourceHash = await hashTree(skill.path);
  const entry = extra => ({ agents: served, kind: 'skill', name: skill.name, path: target, source: skill.path, mode, sourceHash,
    ...(location ? { location, scope } : {}), ...(skill.generated ? { generated: true } : {}), ...(root ? { root } : {}), ...extra });
  let current = record;
  const keep = next => { records.splice(0, records.length, ...records.filter(item => item !== current), ...(next ? [next] : [])); current = next; };
  if (await exists(target)) {
    if (!record) {
      if (!force) return report('conflict', { code: 'SKILL_FOREIGN', reason: `${target} exists and was not installed by Context Kit; remove it or pass --force` });
    } else {
      const state = await skillState(record);
      if (state === 'changed' && !force) return report('conflict', { code: 'SKILL_EDITED', reason: `${target} was edited since install; pass --force to replace it` });
      if (state === 'installed' && record.mode === mode && record.source === skill.path && (mode === 'link' || record.sourceHash === sourceHash)) {
        const { agent: _, ...rest } = record;
        keep({ ...rest, ...entry({}), ...(mode === 'copy' ? { installedHash: record.installedHash } : {}) });
        return report('unchanged', recovered ? { recovered: true } : {});
      }
    }
  }
  // Built beside the target, then swapped in by rename; a failure never leaves a partial skill,
  // and the copy it would have replaced is put back.
  const temporary = join(directory, `.context-kit-${skill.name}-${process.pid}-${Date.now()}`);
  const aside = `${temporary}-old`;
  let moved = false;
  const { agent: _, ...prior } = record ?? {};
  try {
    if (mode === 'link') await symlink(skill.path, temporary, 'dir');
    else {
      await cp(skill.path, temporary, { recursive: true });
      if (content) await writeFile(join(temporary, 'SKILL.md'), content);
    }
    // Evidence before the swap: what is about to be put there, down to the built copy's inode,
    // so an install interrupted after the swap is completed by the next, and nothing else is.
    const built = await lstat(temporary, { bigint: true });
    const pending = { mode, source: skill.path, sourceHash, ...(mode === 'copy' ? { hash: await hashTree(temporary) } : {}),
      dev: String(built.dev), ino: String(built.ino), ...(record ? {} : { first: true }) };
    const { mode: _m, source: _s, sourceHash: _h, installedHash: _i, ...bare } = entry({});
    keep(record ? { ...prior, agents: served, pending } : { ...bare, pending });
    await place.save?.();
    if (await exists(target)) { await rename(target, aside); moved = true; }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (moved) await rename(aside, target).catch(() => {});
    keep(record ?? null);
    return report('failed', writeFailure(error, directory));
  }
  if (moved) await rm(aside, { recursive: true, force: true }).catch(() => {});
  keep(entry(mode === 'copy' ? { installedHash: await hashTree(target) } : {}));
  report(record ? 'updated' : 'installed');
}

// Prepares a location's directory; a coded reason when it cannot be written safely. The shared
// location is <home or project>/.agents/skills, so its anchor is two levels up.
async function prepareDirectory(place) {
  if (LOCATIONS[place.location]?.guarded) {
    const link = await symlinkedBelow(dirname(dirname(place.directory)), place.directory);
    if (link) return { code: 'SYMLINKED_PATH', reason: `${link} is a symbolic link; Context Kit writes ${place.directory} only through real directories` };
  }
  try { await mkdir(place.directory, { recursive: true }); }
  catch (error) { return writeFailure(error, place.directory); }
  await sweepTemporaries(place.directory);
  return null;
}
// Copies an interrupted install left beside their destination (`.context-kit-<skill>-<pid>-<ms>`,
// `-old` for a set-aside copy). Their age is the creation time in the name, which a rename keeps
// (mtime doesn't say when a copy was set aside); only ones over an hour old go, so a concurrent
// install's are kept.
const TEMPORARY = /^\.context-kit-.+-\d+-(\d+)(?:-old)?$/;
async function sweepTemporaries(directory) {
  for (const name of await readdir(directory).catch(() => [])) {
    const created = Number(name.match(TEMPORARY)?.[1]);
    if (created && Date.now() - created > 3600000) await rm(join(directory, name), { recursive: true, force: true }).catch(() => {});
  }
}

// Moves Codex's copies from the recorded legacy directory (not today's $CODEX_HOME) to the
// shared location: a legacy copy goes only once its replacement is installed and matches its
// source, and an edited one, or one whose replacement failed, stays with its record.
async function moveLegacyCodex(place, skills, records, results, env, save, { force }) {
  for (const legacy of records.filter(legacyCodex)) {
    const skill = skills.find(item => item.name === legacy.name);
    const target = join(place.directory, legacy.name);
    const report = (action, extra = {}) => results.push({ agent: 'codex', agents: servedBy(legacy), kind: 'skill', name: legacy.name, path: legacy.path, action, ...extra });
    const outcome = results.find(item => item.kind === 'skill' && item.path === target);
    if (skill && !['installed', 'updated', 'unchanged'].includes(outcome?.action)) {
      report('kept', { code: outcome?.code ?? 'NOT_MOVED', replacement: target,
        reason: `kept for Codex: its replacement at ${target} was not installed (${outcome?.reason ?? 'not attempted'})` });
      continue;
    }
    if (skill) {
      const replacement = records.find(item => item.kind === 'skill' && item.path === target);
      const content = await adapted(skill.path, place.keys);
      const matches = replacement?.mode === 'link' ? await linkTarget(target) === skill.path
        : await exists(target) && await hashTree(target) === await hashTree(skill.path, content);
      if (!matches) { report('kept', { code: 'VERIFY_FAILED', replacement: target, reason: `kept for Codex: ${target} does not match its source` }); continue; }
    }
    const state = await skillState(legacy);
    if (state === 'changed' && !force) {
      report('kept', { code: 'SKILL_EDITED', ...(skill ? { replacement: target } : {}),
        reason: `${legacy.path} was edited since install, so it is kept${skill ? ` beside ${target}` : ''}; merge your edits, then remove it or pass --force` });
      continue;
    }
    if (state !== 'missing') {
      const link = await symlinkedBelow(anchorFor(legacy.path, env), dirname(legacy.path));
      if (link) { report('kept', { code: 'SYMLINKED_PATH', reason: `${link} is a symbolic link; remove ${legacy.path} yourself` }); continue; }
    }
    // The copy goes first, then its record: an interruption leaves a record of a missing copy,
    // which the next install drops, never an unrecorded copy nothing would remove.
    if (state !== 'missing') {
      try { await rm(legacy.path, { recursive: true, force: true }); }
      catch (error) { report('kept', writeFailure(error, dirname(legacy.path))); continue; }
    }
    records.splice(records.indexOf(legacy), 1);
    await save();
    report(skill ? 'moved' : 'removed', skill ? { to: target } : {});
  }
}

// Pull hooks: when the workspace is a git checkout, post-merge and post-rewrite run
// `repos sync` so generated skills follow pulled hub changes. They name this machine's
// Node and core, so they live in the checkout's hooks directory, never in the workspace.
const HOOKS = ['post-merge', 'post-rewrite'];
const HOOK_MARK = '# Managed by Context Kit (agents install).';
const sha = text => createHash('sha256').update(text).digest('hex');
const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
function hookScript(root) {
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
// Only a file that isn't there is missing; one that can't be read is never treated as absent.
const readIfPresent = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
async function hookState(record) {
  let text;
  try { text = await readIfPresent(record.path); } catch { return 'unreadable'; }
  return text === null ? 'missing' : sha(text) === record.installedHash ? 'installed' : 'changed';
}
async function installHooks(root, records, { force = false }) {
  const directory = await hooksDirectory(root);
  if (!directory) return HOOKS.map(name => ({ kind: 'hook', name, action: 'skipped', reason: 'the workspace is not the top of a git checkout; run git init, then agents install' }));
  try { await mkdir(directory, { recursive: true }); }
  catch (error) { return HOOKS.map(name => ({ kind: 'hook', name, path: join(directory, name), action: 'failed', ...writeFailure(error, directory) })); }
  const script = hookScript(root);
  const results = [];
  for (const name of HOOKS) {
    const path = join(directory, name);
    const record = records.find(item => item.kind === 'hook' && item.path === path);
    const report = (action, extra = {}) => results.push({ kind: 'hook', name, path, action, ...extra });
    let current;
    try { current = await readIfPresent(path); }
    catch (error) { report('failed', { code: 'NOT_READABLE', reason: `${path} can't be read (${error.code ?? 'error'}); it is left as it is` }); continue; }
    if (current !== null && !force) {
      if (!record && !current.includes(HOOK_MARK)) { report('conflict', { reason: `${path} exists and was not installed by Context Kit; add a repos sync line to it, or pass --force` }); continue; }
      if (record && await hookState(record) === 'changed') { report('conflict', { reason: `${path} was edited since install; pass --force to replace it` }); continue; }
      if (current === script) { if (!record) records.push({ kind: 'hook', name, path, root, installedHash: sha(script) }); report('unchanged'); continue; }
    }
    // Temporary file beside the hook, then rename, so a failure leaves the old hook whole.
    const temporary = join(directory, `.${name}.context-kit-${process.pid}-${Date.now()}`);
    try {
      await writeFile(temporary, script, { mode: 0o755 });
      await chmod(temporary, 0o755);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      report('failed', writeFailure(error, directory));
      continue;
    }
    records.splice(0, records.length, ...records.filter(item => item !== record), { kind: 'hook', name, path, root, installedHash: sha(script) });
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
// This machine's Node by absolute path, as for the MCP server: a hook's shell may not see nvm's PATH.
const guardEntry = () => ({ matcher: 'Bash', hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(guardScript())}` }] });
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
// Temporary file beside the target, then rename: a reader never sees half a file. The file
// keeps its mode; a new one is private (0600), since settings can hold credentials.
async function writeSettings(path, settings, { indent = '  ', newline = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const mode = await stat(path).then(info => info.mode & 0o7777, () => 0o600);
  const temporary = join(dirname(path), `.${basename(path)}.context-kit-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary, JSON.stringify(settings, null, indent) + (newline ? '\n' : ''), { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
// The words of a command made only of single-quoted words, as quote() writes them, or null.
function quotedWords(command) {
  const words = [];
  const pattern = /'([^']*(?:'\\''[^']*)*)'(?: +|$)/y;
  let match;
  while (pattern.lastIndex < command.length && (match = pattern.exec(command))) words.push(match[1].replaceAll(`'\\''`, "'"));
  return match !== null && pattern.lastIndex === command.length ? words : null;
}
// The merge-guard script a PreToolUse entry runs when it has the shape guardEntry() writes, or null.
function guardScriptOf(entry) {
  if (!Array.isArray(entry?.hooks) || entry.hooks.length !== 1 || entry.hooks[0]?.type !== 'command' || typeof entry.hooks[0].command !== 'string') return null;
  const words = quotedWords(entry.hooks[0].command);
  return words?.length === 2 && words[1].endsWith(`${sep}bin${sep}merge-guard.mjs`) ? words[1] : null;
}
// Entries of that shape whose script is gone (a core that moved or was removed): they fail
// on every Bash call, so an install removes them.
async function deadGuards(entries) {
  const dead = [];
  for (const entry of entries) {
    const script = guardScriptOf(entry);
    if (script && script !== guardScript() && !await exists(script)) dead.push(entry);
  }
  return dead;
}
function guardState(settings, entry) {
  const entries = settings.hooks?.PreToolUse ?? [];
  if (entries.some(item => isDeepStrictEqual(item, entry))) return 'installed';
  return entries.some(ownsEntry) ? 'edited' : 'missing';
}
async function installGuard(root, agent, scope, env, project, records, { force = false }) {
  const base = { agent, kind: 'guard', name: GUARD_NAME };
  if (agent === 'codex') return { ...base, action: 'unsupported', reason: 'Codex has no pre-command hook, so raw merges are not intercepted there; use context-kit pr land' };
  if (agent !== 'claude') return { ...base, action: 'unsupported', reason: `Context Kit installs the merge tripwire only for Claude Code, so raw merges are not intercepted in ${AGENTS[agent].label}; use context-kit pr land` };
  const path = settingsFile(scope, env, project);
  const result = { ...base, path };
  let current;
  try { current = await readSettings(path); }
  catch (error) {
    if (error.code === 'SETTINGS_MALFORMED') return { ...result, action: 'refused', code: error.code, reason: error.message };
    return { ...result, action: 'failed', code: writeCodes.has(error.code) ? 'NOT_READABLE' : 'READ_FAILED', reason: `could not read ${path} (${error.code ?? 'error'})` };
  }
  const entry = guardEntry();
  const record = records.find(item => item.kind === 'guard' && item.path === path);
  const remember = (extra = {}) => {
    // Which containers the install itself created, so uninstall removes only those.
    const kept = { kind: 'guard', agent, name: GUARD_NAME, scope, path, root, ...(scope === 'project' ? { project } : {}), entry,
      createdFile: record?.createdFile ?? Boolean(current.missing), createdHooks: record?.createdHooks ?? created.hooks,
      createdPreToolUse: record?.createdPreToolUse ?? created.preToolUse, ...extra };
    records.splice(0, records.length, ...records.filter(item => item !== record), kept);
  };
  const { settings } = current;
  const created = { hooks: settings.hooks === undefined, preToolUse: settings.hooks?.PreToolUse === undefined };
  const dead = await deadGuards(settings.hooks?.PreToolUse ?? []);
  if (dead.length) settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(item => !dead.includes(item));
  const state = guardState(settings, entry);
  if (state === 'installed' && !dead.length) { remember(); return { ...result, action: 'unchanged' }; }
  if (state === 'installed') {
    try { await writeSettings(path, settings, current); }
    catch (error) { return { ...result, action: 'failed', reason: `could not write ${path}: ${error.message}` }; }
    remember();
    return { ...result, action: 'updated', reason: `removed ${dead.length} merge-guard entr${dead.length > 1 ? 'ies' : 'y'} whose script is gone` };
  }
  if (state === 'edited' && !force) {
    remember();
    return { ...result, action: 'edited', reason: `${path} holds an edited merge-guard entry; it is kept. Pass --force to replace it` };
  }
  const entries = settings.hooks?.PreToolUse ?? [];
  const first = entries.findIndex(ownsEntry);
  const next = entries.filter(item => !ownsEntry(item));
  next.splice(first < 0 ? next.length : entries.slice(0, first).filter(item => !ownsEntry(item)).length, 0, entry);
  settings.hooks = { ...(settings.hooks ?? {}), PreToolUse: next };
  try { await writeSettings(path, settings, current); }
  catch (error) { return { ...result, action: 'failed', reason: `could not write ${path}: ${error.message}` }; }
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
  settings.hooks.PreToolUse = next;
  if (!next.length && record.createdPreToolUse) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length && record.createdHooks) delete settings.hooks;
  try {
    if (record.createdFile && !Object.keys(settings).length) await rm(record.path, { force: true });
    else await writeSettings(record.path, settings, current);
  } catch (error) { return { ...result, action: 'kept', reason: `could not write ${record.path}: ${error.message}` }; }
  return { ...result, action: 'removed' };
}

// The launcher: one managed `context-kit` script per user, in $XDG_BIN_HOME or ~/.local/bin,
// that runs this workspace's pinned core against its root from any directory. Its path is
// home-relative, so the routing skill can name it and keep working when the workspace moves;
// then the launcher fails with WORKSPACE_MOVED until agents install rewrites it.
const LAUNCHER = 'context-kit';
const LAUNCHER_MARK = '# Managed by Context Kit (agents install): the context-kit launcher.';
const LAUNCHER_ROOT = '# Workspace: ';
const shellWord = value => /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(value) ? value : quote(value);
export const launcherDirectory = env => env.XDG_BIN_HOME && isAbsolute(env.XDG_BIN_HOME) ? resolve(env.XDG_BIN_HOME) : join(home(env), '.local', 'bin');
function launcherScript(root) {
  const hub = join(KIT_ROOT, 'bin', 'hub.mjs');
  // printf, not echo: some shells' echo rewrites backslashes in the JSON.
  const error = (code, message) => `printf '%s\\n' ${quote(JSON.stringify({ error: { code, message } }))} >&2`;
  return `#!/bin/sh\n${LAUNCHER_MARK} Runs this workspace's pinned core from any directory.\n` +
    `${LAUNCHER_ROOT}${JSON.stringify(root)}\nroot=${quote(root)}\n` +
    `if [ ! -d "$root" ]; then\n  ${error('WORKSPACE_MOVED', `The workspace ${root} no longer exists. If it moved, run agents install once from its new location`)}\n  exit 1\nfi\n` +
    `if [ ! -x ${quote(process.execPath)} ] || [ ! -f ${quote(hub)} ]; then\n  ${error('LAUNCHER_BROKEN', `The Node or Context Kit core this launcher runs is gone; run npm install and agents install in ${root}`)}\n  exit 1\nfi\n` +
    `exec ${quote(process.execPath)} ${quote(hub)} --root "$root" "$@"\n`;
}
// The workspace a managed launcher or generated routing skill names, or null.
function launcherRoot(text) {
  if (!text?.includes(LAUNCHER_MARK)) return null;
  const line = text.split('\n').find(item => item.startsWith(LAUNCHER_ROOT));
  try { return line ? JSON.parse(line.slice(LAUNCHER_ROOT.length)) : null; } catch { return null; }
}
function skillRoot(text) {
  const value = text?.includes('Generated by Context Kit') ? text.match(/^- Workspace: (.+)$/m)?.[1] : null;
  if (!value) return null;
  if (!value.startsWith('"')) return value;
  try { return JSON.parse(value); } catch { return null; }
}
// The first symbolic link among the directory's components below HOME, or the directory
// itself outside HOME: the launcher is written only into real directories.
async function symlinkedComponent(directory, homeDirectory) {
  if (homeDirectory && directory.startsWith(homeDirectory + sep)) return symlinkedBelow(homeDirectory, directory);
  return await lstat(directory).then(info => info.isSymbolicLink(), () => false) ? directory : null;
}
// Whether `context-kit` on PATH is this launcher, and if not, why.
async function launcherOnPath(path, env) {
  const found = await which(LAUNCHER, env);
  if (found && await realpath(found).catch(() => found) === await realpath(path).catch(() => path)) return { onPath: true };
  if (found) return { onPath: false, reason: `${found} comes first on PATH; put ${dirname(path)} before it` };
  return { onPath: false, reason: `${dirname(path)} is not on PATH; add export PATH=${shellWord(dirname(path))}:"$PATH" to your shell profile` };
}
async function launcherState(record) {
  let info;
  try { info = await lstat(record.path); } catch { return 'missing'; }
  if (!info.isFile()) return 'changed';
  return sha(await readFile(record.path, 'utf8')) === record.installedHash ? 'installed' : 'changed';
}
// Temporaries an interrupted launcher write left (`.context-kit.context-kit-<pid>-<ms>`): by
// the creation time in their exact name, files over an hour old go, as for skill temporaries.
const LAUNCHER_TEMPORARY = new RegExp(`^\\.${LAUNCHER}\\.context-kit-\\d+-(\\d+)$`);
async function sweepLauncherTemporaries(directory) {
  for (const name of await readdir(directory).catch(() => [])) {
    const created = Number(name.match(LAUNCHER_TEMPORARY)?.[1]);
    if (!created || Date.now() - created <= 3600000) continue;
    const path = join(directory, name);
    if ((await lstat(path).catch(() => null))?.isFile()) await rm(path, { force: true }).catch(() => {});
  }
}
async function installLauncher(root, records, env, server, { force = false }) {
  const directory = launcherDirectory(env);
  const path = join(directory, LAUNCHER);
  const result = { kind: 'launcher', name: LAUNCHER, path };
  const linked = await symlinkedComponent(directory, home(env));
  if (linked) return { ...result, action: 'refused', reason: `${linked} is a symbolic link; the launcher is written only into a real directory. Set XDG_BIN_HOME to one, then agents install` };
  await sweepLauncherTemporaries(directory);
  const previous = records.find(item => item.kind === 'launcher');
  const record = previous?.path === path ? previous : null;
  const script = launcherScript(root);
  let info = null;
  try { info = await lstat(path); } catch { /* None yet. */ }
  const current = info?.isFile() ? await readFile(path, 'utf8') : null;
  if (info && !force) {
    if (!record && !launcherRoot(current)) return { ...result, action: 'conflict', reason: `${path} exists and was not written by Context Kit; remove it or pass --force` };
    // Changed by hand, as opposed to rewritten by a workspace that has since moved away.
    const owner = launcherRoot(current);
    if (record && await launcherState(record) === 'changed' && (owner === null || owner === root)) {
      return { ...result, action: 'conflict', reason: `${path} was edited since install; pass --force to replace it` };
    }
  }
  const remember = onPath => {
    const kept = records.filter(item => item.kind !== 'launcher' || (item !== record && item !== previous));
    records.splice(0, records.length, ...kept, { kind: 'launcher', name: LAUNCHER, path, root, server, installedHash: sha(script), onPath });
  };
  if (current !== script) {
    if (info && !info.isFile() && !info.isSymbolicLink()) return { ...result, action: 'conflict', reason: `${path} is not a file; remove it` };
    // Atomic, and never over a file that appeared meanwhile: a new launcher is hard-linked
    // into place (which fails if the name exists), a replacement renamed over the old one.
    const temporary = join(directory, `.${LAUNCHER}.context-kit-${process.pid}-${Date.now()}`);
    let placing = false;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, script, { mode: 0o755, flag: 'wx' });
      await chmod(temporary, 0o755);
      placing = true;
      if (info) await rename(temporary, path);
      else await link(temporary, path);
    } catch (error) {
      if (placing && error.code === 'EEXIST') return { ...result, action: 'conflict', reason: `${path} appeared during install; run agents install again` };
      return { ...result, action: 'failed', reason: `could not write ${path} (${error.code ?? 'error'})` };
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  // A launcher left at an old XDG_BIN_HOME goes when it is still as written.
  if (previous && previous !== record && await launcherState(previous) === 'installed') await rm(previous.path, { force: true });
  const { onPath, reason } = await launcherOnPath(path, env);
  remember(onPath);
  return { ...result, action: current === script ? 'unchanged' : record || info ? 'updated' : 'installed', onPath, ...(reason ? { reason } : {}) };
}

// One workspace per user: the launcher and user-scope routing skills belong to one root. A
// root that no longer exists is a moved workspace, which an install takes over.
async function workspaceConflict(root, env) {
  const other = async owner => owner && owner !== root && await stat(owner).then(info => info.isDirectory(), () => false) ? owner : null;
  const launcher = join(launcherDirectory(env), LAUNCHER);
  const owner = await other(launcherRoot(await readFile(launcher, 'utf8').catch(() => null)));
  if (owner) return { path: launcher, owner };
  // Every user skills location, the shared ~/.agents/skills included, and Codex's legacy one.
  const directories = [...Object.values(LOCATIONS).map(location => location.directory('user', env, null)), join(env.CODEX_HOME || join(home(env), '.codex'), 'skills')];
  for (const directory of directories) {
    for (const name of (await readdir(directory).catch(() => [])).filter(isRoutingName).sort()) {
      const owner = await other(skillRoot(await readFile(join(directory, name, 'SKILL.md'), 'utf8').catch(() => null)));
      if (owner) return { path: join(directory, name), owner };
    }
  }
  return null;
}

// The workspace root a record was installed from: recorded, or for records older than that,
// read from the MCP command or a generated skill's source; null when unknown.
function recordRoot(record) {
  if (record.root) return record.root;
  if (record.kind === 'mcp' && record.command?.includes('--root')) return record.command[record.command.indexOf('--root') + 1];
  if (record.kind === 'skill' && record.generated) return resolve(record.source, '..', '..', '..');
  // A hook in the workspace's own .git/hooks; a guard run by the workspace's installed core.
  if (record.kind === 'hook' && record.path.endsWith(join('.git', 'hooks', record.name))) return resolve(record.path, '..', '..', '..');
  const core = `${sep}${join('node_modules', 'context-kit', 'bin', 'merge-guard.mjs')}`;
  const script = record.kind === 'guard' ? guardScriptOf(record.entry) : null;
  if (script?.endsWith(core)) return script.slice(0, -core.length);
  return null;
}
const movedFrom = (record, root) => { const from = recordRoot(record); return from && from !== root ? from : null; };

// Before reinstalling: records naming another root. When that root is gone (the workspace
// moved), its MCP registrations under another name and its merge-guard entry are removed;
// when it still exists, they are another workspace's and only the records are dropped.
// Skills and the launcher are replaced in place by the install itself.
async function releaseMoved(root, agents, env, records, serverNameNow) {
  const results = [];
  for (const record of [...records]) {
    const from = movedFrom(record, root);
    if (!from || record.kind === 'skill' || record.kind === 'launcher' || (record.agent && !agents.includes(record.agent))) continue;
    const gone = !await stat(from).then(info => info.isDirectory(), () => false);
    const drop = () => records.splice(records.indexOf(record), 1);
    if (!gone) { drop(); continue; }
    if (record.kind === 'mcp' && record.name !== serverNameNow) {
      const cli = await which(AGENTS[record.agent].cli, env);
      if (!cli) continue;
      const scopeArgs = record.agent === 'claude' ? ['-s', record.scope] : [];
      await run(cli, ['mcp', 'remove', ...scopeArgs, record.name], env, record.project ?? root).catch(() => {});
      drop();
      results.push({ agent: record.agent, kind: 'mcp', name: record.name, action: 'removed', reason: `registered for ${from}, which moved` });
    } else if (record.kind === 'guard') {
      const removed = await uninstallGuard(record, {});
      if (removed.action === 'kept') continue;
      drop();
    } else if (record.kind === 'hook') drop();
  }
  return results;
}
async function routingEntry(root, records, server) {
  const { resolveOperation } = await import('./operations.mjs');
  // This workspace's launcher, only while it is in place as written.
  let launcher = records.find(item => item.kind === 'launcher' && item.root === root);
  if (launcher && await launcherState(launcher) !== 'installed') launcher = null;
  const mcp = records.find(item => item.kind === 'mcp' && recordRoot(item) === root);
  // Without this workspace's launcher, the core by absolute path: still no change of directory.
  const direct = `${shellWord(process.execPath)} ${shellWord(join(KIT_ROOT, 'bin', 'hub.mjs'))} --root ${shellWord(root)}`;
  // The server name the last install used, even where no agent CLI could register it.
  const recorded = records.find(item => item.kind === 'launcher' && item.root === root);
  return { server: server ?? recorded?.server ?? mcp?.name ?? serverName(root), resolve: resolveOperation(),
    // Always the absolute path: agent apps started outside a shell often lack its directory on PATH.
    launcher: launcher ? shellWord(launcher.path) : direct, ...(launcher ? { named: LAUNCHER } : {}) };
}
// The generated skills rendered for this workspace's recorded entry points.
export async function renderGeneratedSkills(root) {
  return generatedSkills(root, await routingEntry(root, await loadRecords(root)));
}

async function mcpExists(agent, cli, name, env, cwd) {
  try { await run(cli, ['mcp', 'get', name], env, cwd); return true; } catch { return false; }
}

export async function installAgents(root, options = {}) {
  const { agents, scope, project, env } = parseOptions(options);
  // Checked before anything is written: what rendering the routing skill reads (the registry
  // and .state/checkouts.json, which refuses with INVALID_CONFIG), then the workspace rule.
  try { routingSkillNames((await listRepositories(root)).repositories); }
  catch (error) { if (error.code !== 'NO_HUBS') throw error; }
  const conflict = await workspaceConflict(root, env);
  if (conflict && !options.force) {
    fail('WORKSPACE_CONFLICT', `${conflict.path} belongs to the workspace at ${conflict.owner}; a user has one Context Kit workspace per machine. ` +
      'Install from that workspace, or pass --force to take over the launcher and routing skills');
  }
  const records = (await loadRecords(root)).map(item => item.kind === 'skill' ? { ...item, agents: servedBy(item) } : item);
  for (const item of records) if (item.kind === 'skill') delete item.agent;
  await ensureRecordsWritable(root, records);
  const server = serverName(root, options.name);
  const results = await releaseMoved(root, agents, env, records, server);
  results.push(await installLauncher(root, records, env, server, options));
  await saveRecords(root, records);
  const generated = await generatedSkills(root, await routingEntry(root, records, server));
  const skills = [...(await loadAddons(root)).filter(addon => addon.enabled).flatMap(addon => addon.skills), ...generated];
  for (const { location, agents: served } of skillLocations(agents, scope, env)) {
    const place = { location, agents: served, scope, keys: LOCATIONS[location].keys, directory: LOCATIONS[location].directory(scope, env, project), save: () => saveRecords(root, records) };
    const blocked = await prepareDirectory(place);
    if (blocked) {
      for (const skill of skills) results.push({ agent: served[0], agents: served, kind: 'skill', name: skill.name, path: join(place.directory, skill.name), action: 'failed', ...blocked });
    } else {
      for (const skill of skills) await installSkill(place, skill, records, results, { ...options, root });
      // Remove unchanged skills this installer placed here that no enabled addon provides now.
      for (const record of records.filter(item => item.kind === 'skill' && resolve(item.path, '..') === place.directory && !skills.some(skill => skill.name === item.name))) {
        const report = (action, extra = {}) => results.push({ agent: record.agents[0], agents: record.agents, kind: 'skill', name: record.name, path: record.path, action, ...extra });
        if (await skillState(record) === 'changed') { report('kept', { code: 'SKILL_EDITED', reason: 'edited since install' }); continue; }
        try { await rm(record.path, { recursive: true, force: true }); } catch (error) { report('kept', writeFailure(error, place.directory)); continue; }
        records.splice(records.indexOf(record), 1);
        report('removed');
      }
    }
    // The shared copies are recorded before any legacy copy is deleted.
    await saveRecords(root, records);
    if (location === 'agents' && scope === 'user' && served.includes('codex')) await moveLegacyCodex(place, skills, records, results, env, () => saveRecords(root, records), options);
  }
  // Skills were written and legacy copies deleted: record that before anything else can fail.
  await saveRecords(root, records);
  try {
    for (const agent of agents) {
      results.push(await registerServer(root, agent, scope, project, env, records, options));
      results.push(await installGuard(root, agent, scope, env, project, records, options));
    }
    results.push(...await installHooks(root, records, options));
  } finally { await saveRecords(root, records); }
  return { root, scope, results, skipped: skippedNames(generated) };
}

async function registerServer(root, agent, scope, project, env, records, { allowWrite = false, globalMcp = false, force = false, name: override }) {
  const name = serverName(root, override);
  const base = { agent, kind: 'mcp', name };
  if (agent === 'codex' && scope === 'project' && !globalMcp) {
    return { ...base, action: 'skipped', reason: 'Codex has no project-scoped MCP; pass --global-mcp to register it for the user' };
  }
  if (!AGENTS[agent].cli) return { ...base, action: 'unsupported', reason: `Context Kit does not register MCP servers for ${AGENTS[agent].label} yet; its skills are installed` };
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
  records.push({ ...base, scope: agentScope, ...(agentScope === 'local' ? { project } : {}), root, command });
  return { ...base, scope: agentScope, action: record ? 'updated' : 'installed' };
}

// Items installed from another root report `moved`, naming it, unless missing or edited.
export async function agentStatus(root, options = {}) {
  const env = options.env ?? process.env;
  const items = [];
  const records = await loadRecords(root);
  await generatedSkills(root, await routingEntry(root, records));
  const moved = (record, state, healthy) => {
    const from = healthy.includes(state) && movedFrom(record, root);
    return from ? { state: 'moved', from, reason: `installed from ${from}; run agents install` } : { state };
  };
  for (let record of records) {
    if (record.kind === 'hook') { items.push({ kind: 'hook', name: record.name, path: record.path, ...moved(record, await hookState(record), ['installed', 'missing']) }); continue; }
    if (record.kind === 'guard') { items.push({ agent: record.agent, kind: 'guard', name: record.name, scope: record.scope, path: record.path, ...moved(record, await guardStatus(record), ['installed']) }); continue; }
    if (record.kind === 'launcher') {
      const state = moved(record, await launcherState(record), ['installed']);
      items.push({ kind: 'launcher', name: record.name, path: record.path, ...state, ...(state.state === 'moved' ? {} : await launcherOnPath(record.path, env)) });
      continue;
    }
    if (record.kind === 'skill') {
      const settled = await settle(record);
      if (!settled) { for (const agent of servedBy(record)) items.push({ agent, kind: 'skill', name: record.name, path: record.path, state: 'pending' }); continue; }
      record = settled;
      let state = await skillState(record);
      if (state === 'installed' && record.mode === 'copy' && (!await exists(record.source) || await hashTree(record.source) !== record.sourceHash)) state = 'stale';
      // One item per harness the copy serves, so a shared copy shows under each.
      const shown = moved(record, state, ['installed', 'stale']);
      for (const agent of servedBy(record)) items.push({ agent, kind: 'skill', name: record.name, path: record.path, mode: record.mode, ...shown });
    } else {
      const cli = await which(AGENTS[record.agent].cli, env);
      const cwd = record.project ?? root;
      let state = cli ? (await mcpExists(record.agent, cli, record.name, env, cwd) ? 'installed' : 'missing') : 'unknown';
      const from = state === 'installed' && movedFrom(record, root);
      if (state === 'installed' && !from && !await exists(record.command[0])) state = 'broken';
      items.push({ agent: record.agent, kind: 'mcp', name: record.name, scope: record.scope, ...(from ? moved(record, state, ['installed']) : { state }),
        ...(state === 'broken' ? { reason: `${record.command[0]} no longer exists; run agents install again` } : {}) });
    }
  }
  return { root, items };
}

export async function uninstallAgents(root, options = {}) {
  const env = options.env ?? process.env;
  const agents = parseAgents(options.agents, Object.keys(AGENTS));
  const remaining = [];
  const results = [];
  const all = await loadRecords(root);
  await ensureRecordsWritable(root, all);
  // Hooks and the launcher serve every agent, so they go only when no agent's items remain installed.
  const hooks = all.filter(record => record.kind === 'hook' || record.kind === 'launcher');
  for (let record of all.filter(item => item.kind !== 'hook' && item.kind !== 'launcher')) {
    if (record.kind === 'skill') {
      const settled = await settle(record);
      const served = servedBy(record);
      const leaving = served.filter(agent => agents.includes(agent));
      if (!leaving.length) { remaining.push(record); continue; }
      const base = { agent: leaving[0], agents: leaving, kind: 'skill', name: record.name, path: record.path };
      // An install that never got to swap this copy in: whatever is there isn't this installer's.
      if (!settled) { results.push({ ...base, action: 'skipped', reason: 'its install never finished, so what is there is left as it is' }); continue; }
      const { recovered: __, agent: _, ...rest } = settled;
      record = rest;
      // A shared copy stays while another installed harness still reads it.
      const staying = served.filter(agent => !agents.includes(agent));
      if (staying.length) {
        remaining.push({ ...rest, agents: staying });
        results.push({ ...base, action: 'kept', code: 'STILL_USED', reason: `still used by ${staying.map(agent => AGENTS[agent]?.label ?? agent).join(', ')}` });
        continue;
      }
      const state = await skillState(record);
      if (state === 'changed' && !options.force) { remaining.push(record); results.push({ ...base, action: 'kept', code: 'SKILL_EDITED', reason: 'edited since install' }); continue; }
      const link = (record.location === 'agents' || legacyCodex(record)) && await symlinkedBelow(anchorFor(record.path, env), dirname(record.path));
      if (link) { remaining.push(record); results.push({ ...base, action: 'kept', code: 'SYMLINKED_PATH', reason: `${link} is a symbolic link; remove ${record.path} yourself` }); continue; }
      try { await rm(record.path, { recursive: true, force: true }); }
      catch (error) { remaining.push(record); results.push({ ...base, action: 'kept', ...writeFailure(error, dirname(record.path)) }); continue; }
      results.push({ ...base, action: 'removed' });
      continue;
    }
    if (!agents.includes(record.agent)) { remaining.push(record); continue; }
    if (record.kind === 'guard') {
      const result = await uninstallGuard(record, options);
      if (result.action === 'kept') remaining.push(record);
      results.push(result);
      continue;
    }
    const base = { agent: record.agent, kind: record.kind, name: record.name };
    const cli = await which(AGENTS[record.agent].cli, env);
    if (!cli) { remaining.push(record); results.push({ ...base, action: 'kept', reason: `${AGENTS[record.agent].cli} CLI not found on PATH` }); continue; }
    const scopeArgs = record.agent === 'claude' ? ['-s', record.scope] : [];
    await run(cli, ['mcp', 'remove', ...scopeArgs, record.name], env, record.project ?? root).catch(() => {});
    results.push({ ...base, action: 'removed' });
  }
  for (const record of hooks) {
    if (remaining.length) { remaining.push(record); continue; }
    const state = record.kind === 'launcher' ? await launcherState(record) : await hookState(record);
    const base = { kind: record.kind, name: record.name, path: record.path };
    if (state === 'unreadable') { remaining.push(record); results.push({ ...base, action: 'kept', code: 'NOT_READABLE', reason: `${record.path} can't be read; it is left as it is` }); continue; }
    if (state === 'changed' && !options.force) { remaining.push(record); results.push({ ...base, action: 'kept', reason: 'edited since install' }); continue; }
    await rm(record.path, { force: true });
    results.push({ ...base, action: 'removed' });
  }
  await saveRecords(root, remaining);
  return { root, results };
}

// After repositories change: re-render generated skills and update every installed,
// unchanged copy in place, without touching MCP registrations. Wherever a generated skill
// is installed, routing shards that appear are installed beside it and ones that are no
// longer generated are removed, unless edited.
export async function refreshGeneratedSkills(root, { report } = {}) {
  const records = await loadRecords(root);
  const skills = await generatedSkills(root, await routingEntry(root, records));
  if (records.length) await ensureRecordsWritable(root, records);
  const results = [];
  const places = new Map();
  for (const record of records.filter(item => item.kind === 'skill' && item.generated)) {
    const directory = resolve(record.path, '..');
    if (!places.has(directory)) places.set(directory, { location: record.location ?? null, scope: record.scope, keys: keysFor(record), directory, agents: [], records: [], save: () => saveRecords(root, records) });
    const place = places.get(directory);
    place.agents = union(place.agents, servedBy(record));
    place.records.push(record);
  }
  for (const place of places.values()) {
    const { directory, records: here } = place;
    const result = (record, action, extra = {}) => ({ agent: servedBy(record)[0], agents: servedBy(record), kind: 'skill', name: record.name, path: record.path, action, ...extra });
    const present = [];
    for (const record of here) {
      if (await skillState(record) === 'missing') {
        if (skills.some(skill => skill.name === record.name)) results.push(result(record, 'skipped', { reason: 'not installed there any more; run agents install' }));
        continue;
      }
      present.push(record);
    }
    if (!present.length) continue;
    const blocked = await prepareDirectory(place);
    if (blocked) { results.push(...present.map(record => result(record, 'skipped', blocked))); continue; }
    for (const skill of skills) {
      if (here.some(record => record.name === skill.name && !present.includes(record))) continue;
      await installSkill(place, skill, records, results, { link: false, force: false, root });
    }
    for (const record of present.filter(item => !skills.some(skill => skill.name === item.name))) {
      if (await skillState(record) === 'changed') { results.push(result(record, 'kept', { code: 'SKILL_EDITED', reason: 'edited since install' })); continue; }
      await rm(record.path, { recursive: true, force: true });
      records.splice(records.indexOf(record), 1);
      results.push(result(record, 'removed'));
    }
  }
  await saveRecords(root, records);
  return report ? { results, skipped: skippedNames(skills), skills } : results;
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
