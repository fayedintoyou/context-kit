// Installs a workspace's enabled skills and its MCP server into agent harnesses, and a
// `context-kit` launcher into the user's bin directory. Skills go to the fewest locations that
// cover the selection: Claude Code's directory and the shared ~/.agents/skills.
// Installing is a reconciling sync recorded in <workspace>/.state/agents.json, so status
// and uninstall are exact and nothing the installer did not create is overwritten.
import { access, chmod, constants, cp, link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { KIT_ROOT } from './hubs.mjs';
import { loadAddons } from './addons.mjs';
import { initWorkspace, pinnedCoreSpec } from './workspace.mjs';
import { fail } from './files.mjs';
import { splitFrontmatter } from './okf.mjs';
import { generatedSkills, isRoutingName, listRepositories, routingSkillNames, skippedNames } from './repos.mjs';
import { git, gitEnvironment } from './git-env.mjs';

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
// Harnesses, the locations each reads and how its MCP server is registered, from vendor
// documentation (2026-10-22; sources in the addons-and-install help topic). Cursor reads
// ~/.claude/skills literally, so a CLAUDE_CONFIG_DIR elsewhere is not one of its locations.
// MCP: `cli` registers through the harness's own CLI with `scope` arguments (null: none at
// that scope); `json` merges one entry into the harness's `mcpServers` config file.
const geminiSettings = env => join(env.GEMINI_CLI_HOME || home(env), '.gemini', 'settings.json');
const AGENTS = {
  claude: { label: 'Claude Code', cli: 'claude', reads: () => ['claude'],
    mcp: { kind: 'cli', scope: scope => ['-s', scope] } },
  codex: { label: 'Codex', cli: 'codex', reads: () => ['agents'], mcp: { kind: 'cli', scope: () => [] } },
  // `gemini mcp add -s user <name> <command> -- <args>`: after `--` the server's own flags
  // are not read as Gemini's. There is no `mcp get`, so presence is read from its settings file.
  gemini: { label: 'Gemini CLI', cli: 'gemini', reads: () => ['agents'], projectMcp: false,
    mcp: { kind: 'cli', scope: () => ['-s', 'user'], add: (name, command) => [name, command[0], '--', ...command.slice(1)],
      has: async (name, env) => Boolean((await readLoose(geminiSettings(env)))?.mcpServers?.[name]) } },
  copilot: { label: 'GitHub Copilot CLI', cli: null, reads: () => ['agents'], projectMcp: false,
    mcp: { kind: 'json', file: env => join(env.COPILOT_HOME && isAbsolute(env.COPILOT_HOME) ? env.COPILOT_HOME : join(home(env), '.copilot'), 'mcp-config.json'),
      entry: command => ({ type: 'local', command: command[0], args: command.slice(1), tools: ['*'] }) } },
  cursor: { label: 'Cursor', cli: null, projectMcp: false,
    reads: (scope, env) => scope === 'user' && claudeSkills(env) === join(home(env), '.claude', 'skills') ? ['agents', 'claude'] : ['agents'],
    mcp: { kind: 'json', file: env => join(home(env), '.cursor', 'mcp.json'), entry: command => ({ type: 'stdio', command: command[0], args: command.slice(1) }) } },
};
const supported = () => `${Object.keys(AGENTS).join(', ')} or all`;
function parseAgents(list, fallback = ['claude', 'codex']) {
  const agents = list ?? fallback;
  if (!agents.length || agents.some(agent => agent !== 'all' && !AGENTS[agent])) fail('INVALID_INPUT', `Agents are ${supported()}: ${agents.join(',')}`);
  return agents.includes('all') ? Object.keys(AGENTS) : [...new Set(agents)];
}
const cliScope = (agent, scope) => AGENTS[agent].mcp.scope(scope);
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
// Which file a path holds: its device, inode and, where the platform reports one, its birth time
// (macOS and Windows; Linux through statx, on file systems that keep it, such as ext4). Device and
// inode alone can repeat: ext4 reuses a deleted copy's inode for the next new file. Where no
// birth time is reported (an older kernel, a file system without one), the identity is device
// and inode only, and that reuse can't be told apart.
async function fileIdentity(path) {
  const info = await lstat(path, { bigint: true }).catch(() => null);
  return info && { dev: String(info.dev), ino: String(info.ino), ...(info.birthtimeNs > 0n ? { birth: String(info.birthtimeNs) } : {}) };
}
// With a birth time on both sides, inode and birth time decide and the device number is ignored:
// it isn't stable on btrfs subvolumes, NFS or in containers. Without one, device and inode.
const sameFile = (found, recorded) => Boolean(found && recorded && found.ino === recorded.ino &&
  (found.birth !== undefined && recorded.birth !== undefined ? found.birth === recorded.birth : found.dev === recorded.dev));
// installed | changed | missing | replaced, from the record. `replaced`: the path holds another
// file than the one installed (deleted, then something else put there), even with equal content,
// so it isn't this installer's. Records from before identities were kept are judged by content
// until an install refreshes them.
async function skillState(record) {
  if (!await exists(record.path)) return 'missing';
  if (record.identity && !sameFile(await fileIdentity(record.path), record.identity)) return 'replaced';
  if (record.mode === 'link') return await linkTarget(record.path) === record.source ? 'installed' : 'changed';
  // A symbolic link where a copy was installed is an edit, unless it is the very link the record
  // took back (a dotfile manager's, say); then its target's content decides.
  if (!record.identity && await linkTarget(record.path) !== null) return 'changed';
  return await hashTree(record.path) === record.installedHash ? 'installed' : 'changed';
}
// Whether a replaced copy holds exactly what was installed, as a restore from a backup, a
// migration or a dotfile manager's symlink leaves it.
const sameContent = async record => record.mode === 'link' ? await linkTarget(record.path) === record.source
  : await hashTree(record.path).catch(() => null) === record.installedHash;
// The workspace that owns this user's launcher. One workspace per user (WORKSPACE_CONFLICT), so
// its replaced copies with the installed content are its own, restored.
const ownsLauncher = async (root, env) => Boolean(root) && launcherRoot(await readFile(join(launcherDirectory(env), LAUNCHER), 'utf8').catch(() => null)) === root;
// Whether a replaced copy may be taken back: the installed content, and this workspace owns the
// launcher or the caller passed --adopt. Never an edited copy.
const mayReadopt = async (record, root, env, adopt) => await sameContent(record) && (adopt || await ownsLauncher(root, env));
function replacedReason(path, same) {
  return same
    ? `${path} was replaced since install by a copy with the installed content, as a restore or a dotfile manager leaves it; pass --adopt to take it back`
    : `${path} was replaced since install by a different copy that Context Kit didn't put there; remove it and run agents install, or pass --force to replace it`;
}
// `pending` is saved just before a swap: the new mode, source and content hash, and the identity
// of the built copy, which the rename keeps. Settling it after an interruption: if the
// path holds that very file with that content, the swap happened and the record takes the
// pending values; otherwise the record is what it was before (null for a first install, whose
// path then holds nothing of this installer's). An equal hash alone is never ownership.
async function settle(record) {
  if (!record.pending) return record;
  const { pending, ...prior } = record;
  const found = await fileIdentity(record.path);
  const same = sameFile(found, pendingIdentity(pending)) &&
    (pending.mode === 'link' ? await linkTarget(record.path) === pending.source : await linkTarget(record.path) === null && await hashTree(record.path) === pending.hash);
  if (same) {
    const { installedHash: _, ...rest } = prior;
    return { ...rest, mode: pending.mode, source: pending.source, sourceHash: pending.sourceHash, ...(pending.mode === 'copy' ? { installedHash: pending.hash } : {}),
      identity: pendingIdentity(pending), recovered: true };
  }
  return pending.first ? null : prior;
}
// Pending records written before birth times were kept carry `dev` and `ino` directly.
const pendingIdentity = pending => pending.identity ?? { dev: pending.dev, ino: pending.ino };
// The copy an interrupted install built but never swapped in: the temporary beside the target
// with the recorded inode, provably this installer's, so it needn't wait for the hourly sweep.
async function discardBuilt(record) {
  const directory = dirname(record.path);
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.startsWith(`.context-kit-${record.name}-`) || name.endsWith('-old')) continue;
    if (sameFile(await fileIdentity(join(directory, name)), pendingIdentity(record.pending))) await rm(join(directory, name), { recursive: true, force: true }).catch(() => {});
  }
}

const recordsPath = root => join(root, '.state', 'agents.json');
async function loadRecords(root) {
  try { return JSON.parse(await readFile(recordsPath(root), 'utf8')).items; }
  catch (error) { if (error.code === 'ENOENT') return []; fail('INVALID_CONFIG', `${recordsPath(root)}: ${error.message}`); }
}
// The directories skills are installed into, from the records: where a skill refresh may report
// a path, including a project's (remote-access / Serving machine paths labels them over HTTP).
export async function installedSkillDirectories(root) {
  const items = await loadRecords(root).catch(() => []);
  return [...new Set(items.filter(item => item.kind === 'skill' && typeof item.path === 'string').map(item => dirname(item.path)))];
}
// Temporary file beside the records, then rename: a crash mid-write never truncates them.
// Read back after the rename: what was saved is what the next command reads.
async function saveRecords(root, items) {
  await mkdir(join(root, '.state'), { recursive: true });
  await lockHeld(root);
  const path = recordsPath(root);
  const text = JSON.stringify({ version: 1, items }, null, 2) + '\n';
  const temporary = `${path}.${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  if (await readFile(path, 'utf8').catch(() => null) !== text) fail('RECORDS_CHANGED', `${path} changed as it was saved, so this command's records may be lost; run agents status, then this command again`);
}

// One installer at a time per workspace: install, uninstall and repos sync each read, change
// and save .state/agents.json, so two at once would lose each other's records. The lock is a
// file created exclusively in .state, holding the owner's pid and a token, and touched while
// held, as for mounts (lib/mounts.mjs). A lock whose owner is gone, or untouched for an hour,
// is stale; breakers take turns through a second exclusive file and delete a stale lock only if
// it is still the one they judged stale. A waiter gives up after five minutes (AGENTS_BUSY).
const lockWait = () => Number(process.env.CONTEXT_KIT_AGENTS_LOCK_WAIT_MS ?? 5 * 60 * 1000);
const LOCK_STALE = 60 * 60 * 1000;
const LOCK_TOUCH = 5 * 60 * 1000;
const BREAK_STALE = 10000;
const lockPath = root => join(root, '.state', '.lock-agents');
async function readLock(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  let data = {};
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch { /* Being written, or damaged. */ }
  return { ...data, mtime: info.mtimeMs, ino: info.ino };
}
const lockStale = holder => {
  const age = Date.now() - Math.max(holder.at ?? 0, holder.mtime);
  return holder.token ? !alive(holder.pid) || age > LOCK_STALE : age > BREAK_STALE;
};
const sameLock = (a, b) => a && b && a.token === b.token && a.ino === b.ino && a.mtime === b.mtime;
async function breakStale(path, observed) {
  const breaker = `${path}.break`;
  const token = randomUUID();
  try { await writeFile(breaker, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const other = await readLock(breaker);
    if (other && Date.now() - other.mtime > BREAK_STALE && sameLock(await readLock(breaker), other)) await rm(breaker, { force: true });
    return false;
  }
  try {
    const current = await readLock(path);
    if (!current) return true;
    if (sameLock(current, observed) && lockStale(current)) await rm(path, { force: true });
    return true;
  } finally {
    if ((await readLock(breaker).catch(() => null))?.token === token) await rm(breaker, { force: true });
  }
}
const locks = new Map();
// Temporaries a killed save left in .state (`agents.json.<pid>-<ms>`, `leftovers.json.<pid>-<ms>`),
// by exact name, once their process is gone or an hour has passed. Only lock holders save, so a
// live holder's are never taken.
const STATE_TEMPORARY = /^(?:agents|leftovers)\.json\.(\d+)-(\d+)$/;
async function sweepStateTemporaries(root) {
  const directory = join(root, '.state');
  for (const name of await readdir(directory).catch(() => [])) {
    const match = name.match(STATE_TEMPORARY);
    if (!match || (alive(Number(match[1])) && Date.now() - Number(match[2]) <= 3600000)) continue;
    const path = join(directory, name);
    if ((await lstat(path).catch(() => null))?.isFile()) await rm(path, { force: true }).catch(() => {});
  }
}
// Before a write that matters: the lock still holds this command's token.
async function lockHeld(root) {
  const token = locks.get(root);
  if (token && (await readLock(lockPath(root)).catch(() => null))?.token !== token) {
    fail('AGENTS_BUSY', 'Another Context Kit command took over the agents lock; nothing more was changed, run agents status, then try again');
  }
}
async function withAgentsLock(root, run) {
  if (locks.has(root)) return run();
  const path = lockPath(root);
  const token = randomUUID();
  const deadline = Date.now() + lockWait();
  for (;;) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' });
      break;
    } catch (error) {
      if (writeCodes.has(error.code)) fail('RECORDS_UNWRITABLE', `${dirname(path)} can't be written (${error.code}), so nothing was changed; make it writable, then run this again`);
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = await readLock(path);
    if (!holder || lockStale(holder) && await breakStale(path, holder)) continue;
    if (Date.now() > deadline) fail('AGENTS_BUSY', `Another Context Kit command (pid ${holder.pid ?? 'unknown'}) is installing or syncing this workspace's agents; try again when it finishes`);
    await new Promise(done => setTimeout(done, 50 + Math.random() * 100));
  }
  const touch = setInterval(async () => {
    if ((await readLock(path).catch(() => null))?.token === token) await utimes(path, new Date(), new Date()).catch(() => {});
  }, LOCK_TOUCH);
  touch.unref();
  locks.set(root, token);
  await sweepStateTemporaries(root);
  try { return await run(); }
  finally {
    locks.delete(root);
    clearInterval(touch);
    if ((await readLock(path).catch(() => null))?.token === token) await rm(path, { force: true });
  }
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
  if (options.globalRule !== undefined && typeof options.globalRule !== 'boolean') fail('INVALID_INPUT', 'globalRule is true, false or absent');
  return { agents, scope, project: resolve(options.project ?? process.cwd()), env: options.env ?? process.env };
}
// Agent CLIs (claude, codex, ...) get the scrubbed git environment: they may run git themselves,
// and an inherited GIT_DIR would point it at another repository than the one they work in.
async function run(cli, args, env, cwd) {
  return exec(cli, args, { env: gitEnvironment(env), cwd, timeout: 60000, maxBuffer: 1024 * 1024 });
}

// Puts one skill into one location's directory, for the harnesses that location serves there.
async function installSkill(place, skill, records, results, { link, force, adopt, root, env = process.env }) {
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
  // The copy this record describes was deleted and another put in its place. The record stays, so
  // status and every install name it; the copy is taken back only with the installed content.
  let readopted = false;
  if (record && await skillState(record) === 'replaced') {
    if (await mayReadopt(record, root, env, adopt)) { record.identity = await fileIdentity(target); readopted = true; }
    else if (!force) {
      const served = servedBy(record);
      return results.push({ agent: served[0], agents: served, kind: 'skill', name: skill.name, path: target, action: 'conflict', code: 'SKILL_REPLACED', state: 'replaced', reason: replacedReason(target, await sameContent(record)) });
    }
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
        // A record from before identities were kept gets one now, from the copy it matches.
        keep({ ...rest, ...entry({}), ...(mode === 'copy' ? { installedHash: record.installedHash } : {}), identity: record.identity ?? await fileIdentity(target) });
        return report('unchanged', { ...(recovered ? { recovered: true } : {}), ...(readopted ? { readopted: true } : {}) });
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
    const pending = { mode, source: skill.path, sourceHash, ...(mode === 'copy' ? { hash: await hashTree(temporary) } : {}),
      identity: await fileIdentity(temporary), ...(record ? {} : { first: true }) };
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
  keep(entry({ ...(mode === 'copy' ? { installedHash: await hashTree(target) } : {}), identity: await fileIdentity(target) }));
  report(record ? 'updated' : 'installed', readopted ? { readopted: true } : {});
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
    // Replaced since install: whatever is there now isn't the copy that was installed.
    if (state === 'replaced') {
      records.splice(records.indexOf(legacy), 1);
      await save();
      report('skipped', { code: 'SKILL_FOREIGN', reason: `${legacy.path} was replaced since install by a copy Context Kit didn't put there; it is left as it is` });
      continue;
    }
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
    // -C and a scrubbed environment: an inherited GIT_DIR (say, from another repository's hook)
    // must never make this workspace's hooks land in another repository.
    const top = (await git(root, ['rev-parse', '--show-toplevel'], { timeout: 10000 })).stdout.trim();
    if (await realpath(top) !== await realpath(root)) return null;
    return resolve(root, (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { timeout: 10000 })).stdout.trim());
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

// The optional global rule (--global-rule): one small Claude Code user rule, context-kit.md in
// $CLAUDE_CONFIG_DIR/rules or ~/.claude/rules, which Claude Code loads in every project
// (code.claude.com/docs/en/memory, "User-level rules"). It says how repositories resolve and
// never lists them; the routing skill's description stays the mechanism. The opt-in is the
// record: a plain install keeps the rule until --no-global-rule or uninstall. Ownership is the
// record's file identity, never content alone, so a rule file Context Kit didn't write is
// never replaced or removed, even with --force.
const RULE = 'context-kit.md';
const RULE_MARK = '<!-- Managed by Context Kit (agents install --global-rule); agents install --no-global-rule removes it. -->';
const rulesDirectory = env => join(env.CLAUDE_CONFIG_DIR || join(home(env), '.claude'), 'rules');
function ruleText(entry) {
  return `# Your repositories\n\nThe user's own repositories resolve from any directory, so don't search the file system for one. ` +
    `When a request names one, call the \`${entry.resolve.tool}\` tool of the \`${entry.server}\` MCP server, or run ` +
    `\`${entry.launcher} ${entry.resolve.command}\`, and work in the checkout it gives. ` +
    `Read that checkout's AGENTS.md or CLAUDE.md before changing it.\n\n${RULE_MARK}\n`;
}
// installed | changed | missing | replaced, as for skills: `replaced` when the path holds
// another file than the one written, `changed` when that file was edited or is not a file.
async function ruleState(record) {
  const info = await lstat(record.path).catch(() => null);
  if (!info) return 'missing';
  if (!sameFile(await fileIdentity(record.path), record.identity)) return 'replaced';
  if (!info.isFile()) return 'changed';
  return sha(await readFile(record.path, 'utf8')) === record.installedHash ? 'installed' : 'changed';
}
// A symbolic link from the config directory's anchor down to the rule file: written and deleted
// only through real directories.
const ruleLink = (path, env) => symlinkedBelow(anchorFor(dirname(path), env), path);
// Temporaries beside the rule (`.context-kit.md.context-kit-<pid>-<ms>`); over an hour old they go.
const RULE_TEMPORARY = /^\.context-kit\.md\.context-kit-\d+-(\d+)$/;
async function sweepRuleTemporaries(directory) {
  for (const name of await readdir(directory).catch(() => [])) {
    const created = Number(name.match(RULE_TEMPORARY)?.[1]);
    if (!created || Date.now() - created <= 3600000) continue;
    if ((await lstat(join(directory, name)).catch(() => null))?.isFile()) await rm(join(directory, name), { force: true }).catch(() => {});
  }
}
// An interrupted write: the record holds `pending` (the hash and identity of the built file,
// which link and rename keep). The write happened only if that very file is in place.
async function settleRule(record) {
  if (!record?.pending) return record;
  const { pending, ...prior } = record;
  const text = await readFile(record.path, 'utf8').catch(() => null);
  const done = text !== null && sha(text) === pending.hash && sameFile(await fileIdentity(record.path), pending.identity);
  // The built file, by identity: never swapped in, or a second name of the rule a link left.
  for (const name of await readdir(dirname(record.path)).catch(() => [])) {
    const path = join(dirname(record.path), name);
    if (RULE_TEMPORARY.test(name) && sameFile(await fileIdentity(path), pending.identity)) await rm(path, { force: true }).catch(() => {});
  }
  if (done) return { ...prior, installedHash: pending.hash, identity: pending.identity, enabled: true };
  return pending.first ? null : prior;
}
// Removes the recorded rule if it is still the file written, as written; reports what it did.
async function removeRule(record, env, { force = false }) {
  const result = { agent: 'claude', kind: 'rule', name: RULE, path: record.path };
  const state = await ruleState(record);
  if (state === 'missing') return { ...result, action: 'removed', reason: 'already absent', drop: true };
  if (state === 'replaced') return { ...result, action: 'skipped', code: 'RULE_REPLACED', state, drop: true, reason: `${record.path} was replaced by a file Context Kit didn't write; it is left as it is` };
  if (state === 'changed' && !force) return { ...result, action: 'kept', code: 'RULE_EDITED', state: 'edited', reason: `${record.path} was edited since install, so it is kept; remove it yourself or pass --force` };
  const linked = await ruleLink(record.path, env);
  if (linked) return { ...result, action: 'kept', code: 'SYMLINKED_PATH', reason: `${linked} is a symbolic link; remove ${record.path} yourself` };
  try { await rm(record.path, { force: true }); }
  catch (error) { return { ...result, action: 'kept', ...writeFailure(error, dirname(record.path)) }; }
  return { ...result, action: 'removed', drop: true };
}
// `want`: true (--global-rule), false (--no-global-rule) or undefined (as recorded).
async function installRule(root, agents, scope, env, records, entry, { globalRule: want, force = false, adopt = false }) {
  const index = records.findIndex(item => item.kind === 'rule');
  let record = index < 0 ? null : await settleRule(records[index]);
  if (index >= 0) records.splice(index, 1, ...(record ? [record] : []));
  const wanted = want ?? Boolean(record?.enabled);
  const results = [];
  if (wanted) {
    for (const agent of agents.filter(item => item !== 'claude')) {
      results.push({ agent, kind: 'rule', name: RULE, action: 'unsupported', reason: `${AGENTS[agent].label} has no user rules directory Context Kit can own a file in; its routing skill still names your repositories` });
    }
  }
  if (!agents.includes('claude')) return results;
  if (scope !== 'user') {
    if (want) results.push({ agent: 'claude', kind: 'rule', name: RULE, action: 'skipped', reason: 'the global rule is a user rule; install at user scope with --global-rule' });
    return results;
  }
  const keep = next => { records.splice(0, records.length, ...records.filter(item => item !== record), ...(next ? [next] : [])); record = next; };
  const path = join(rulesDirectory(env), RULE);
  const report = (action, extra = {}) => results.push({ agent: 'claude', kind: 'rule', name: RULE, path, action, ...extra });
  // Opting out, or a rule left in an earlier CLAUDE_CONFIG_DIR: the recorded file goes first.
  if (record && (!wanted || record.path !== path)) {
    const { drop, ...removed } = await removeRule(record, env, { force });
    results.push(removed);
    if (!drop) { keep({ ...record, enabled: wanted }); return results; }
    keep(null);
  }
  if (!wanted) return results;
  const text = ruleText(entry);
  let state = record ? await ruleState(record) : null;
  // Another file with exactly what was written (a restore, a sync service) is taken back by the
  // workspace that owns the launcher, or with --adopt, as for skills.
  if (state === 'replaced' && (await lstat(path)).isFile() && sha(await readFile(path, 'utf8')) === record.installedHash && (adopt || await ownsLauncher(root, env))) {
    record.identity = await fileIdentity(path);
    state = 'installed';
  }
  const linked = await ruleLink(path, env);
  if (linked) return report('refused', { code: 'SYMLINKED_PATH', reason: `${linked} is a symbolic link; Context Kit writes ${path} only through real directories` }), results;
  if (state === 'changed' && !force) { keep({ ...record, enabled: true }); return report('edited', { code: 'RULE_EDITED', state: 'edited', reason: `${path} was edited since install; it is kept. Pass --force to replace it` }), results; }
  if (state === 'replaced') { keep({ ...record, enabled: true }); return report('conflict', { code: 'RULE_REPLACED', state, reason: `${path} was replaced by a file Context Kit didn't write; it is left as it is. Remove it, then agents install` }), results; }
  if (state === 'installed' && record.installedHash === sha(text)) { keep({ ...record, root, enabled: true }); return report('unchanged'), results; }
  const present = await lstat(path).then(() => true, () => false);
  if (present && !record) return report('conflict', { code: 'RULE_FOREIGN', reason: `${path} exists and was not written by Context Kit; it is left as it is. Rename it, then agents install --global-rule` }), results;
  // Built beside the rule, then hard-linked into place when new (which fails if a file appeared
  // meanwhile) or renamed over the recorded one. The record holds the built file's identity as
  // `pending` first, so an install interrupted after the swap is completed by the next.
  const directory = dirname(path);
  const temporary = join(directory, `.${RULE}.context-kit-${process.pid}-${Date.now()}`);
  try {
    await mkdir(directory, { recursive: true });
    await sweepRuleTemporaries(directory);
    await writeFile(temporary, text, { flag: 'wx', mode: 0o644 });
    const pending = { hash: sha(text), identity: await fileIdentity(temporary), ...(record ? {} : { first: true }) };
    const prior = record;
    keep({ ...(prior ?? { kind: 'rule', agent: 'claude', name: RULE, path }), root, enabled: prior?.enabled ?? false, pending });
    await saveRecords(root, records);
    if (present) await rename(temporary, path);
    else await link(temporary, path);
    keep({ kind: 'rule', agent: 'claude', name: RULE, path, root, enabled: true, installedHash: pending.hash, identity: pending.identity });
    report(present ? 'updated' : 'installed');
  } catch (error) {
    const { pending: _, ...prior } = record ?? {};
    keep(!record || record.pending?.first ? null : prior);
    if (error.code === 'EEXIST') report('conflict', { code: 'RULE_FOREIGN', reason: `${path} appeared during install; it is left as it is` });
    else report('failed', writeFailure(error, directory));
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return results;
}

// MCP registration through a harness's JSON config file (Copilot CLI, Cursor). The file must
// be plain JSON (JSON.parse) with no key listed twice; anything else, comments included, is
// refused untouched (CONFIG_MALFORMED), since rewriting it would lose the user's text. The one
// entry is edited in place in the text, so every other byte stays as it was and uninstall
// restores the file exactly. A symbolic link to the file, or in its directory path, is written
// through: the link stays and its target is edited, as a dotfile manager expects.
//
// Ownership is evidence, as for skills: the record holds the resolved target and the identity
// of the file the install wrote. Another target (a retargeted link) is someone else's file
// (`replaced`); another file at the target (rewritten since, by the harness or by hand) is
// still edited for our entry, but what the install created around it (the file, mcpServers, an
// empty object's text) is no longer claimed.
//
// Every write is checked against the file it was computed from: a capture link must show that
// file, unchanged, just before the swap, or the edit is computed again from what the file holds
// (bounded). A change made during the swap itself, in place, is detected afterwards and the file
// put back as that writer left it (MCP_CONFLICT). Bytes Context Kit can't account for are kept
// beside the file under an exclusive `.context-kit-displaced-` name rather than deleted. The
// residual is in place(): a writer that replaces the file by rename in the instant between the
// last check and the swap loses its change, and no copy of it is kept.
const skipSpace = (text, at) => { while (at < text.length && ' \t\n\r'.includes(text[at])) at++; return at; };
function stringEnd(text, at) {
  let next = at + 1;
  while (text[next] !== '"') next += text[next] === '\\' ? 2 : 1;
  return next + 1;
}
const malformed = (path, why) => Object.assign(new Error(`${path} ${why}; Context Kit edits only plain JSON and never rewrites a file it can't keep intact. Fix it, or add the entry by hand`), { code: 'CONFIG_MALFORMED' });
// The spans of a value in text JSON.parse accepted; objects list their members. A key listed
// twice in any object is ambiguous (JSON.parse keeps the last), so it is refused.
function scanValue(text, at, path) {
  const start = skipSpace(text, at);
  if (text[start] === '{' || text[start] === '[') {
    const object = text[start] === '{';
    const members = [];
    const keys = new Set();
    let next = skipSpace(text, start + 1);
    if (text[next] === (object ? '}' : ']')) return { start, end: next + 1, members };
    for (;;) {
      let key = null;
      const memberStart = next;
      if (object) {
        const keyEnd = stringEnd(text, next);
        key = JSON.parse(text.slice(next, keyEnd));
        if (keys.has(key)) throw malformed(path, `lists the key ${JSON.stringify(key)} more than once in one object`);
        keys.add(key);
        next = skipSpace(text, keyEnd) + 1;
      }
      const value = scanValue(text, next, path);
      members.push({ key, start: memberStart, value });
      next = skipSpace(text, value.end);
      if (text[next] === ',') { next = skipSpace(text, next + 1); continue; }
      return { start, end: next + 1, members };
    }
  }
  if (text[start] === '"') return { start, end: stringEnd(text, start) };
  const literal = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  literal.lastIndex = start;
  literal.exec(text);
  return { start, end: literal.lastIndex };
}
const lineIndent = (text, at) => text.slice(text.lastIndexOf('\n', at - 1) + 1, at).match(/^[ \t]*/)[0];
const splice = (text, start, end, insert = '') => text.slice(0, start) + insert + text.slice(end);
// Lines end as the file's do (CRLF or LF).
const endOfLine = text => text.includes('\r\n') ? '\r\n' : '\n';
const rendered = (value, indent, unit, eol) => JSON.stringify(value, null, unit).replaceAll('\n', `${eol}${indent}`);
// Adds a member as the object's last; removing it again restores the text exactly (an empty
// object's own text is recorded by the caller).
function addMember(text, object, key, value, unit) {
  const name = JSON.stringify(key);
  const eol = endOfLine(text);
  if (!object.members.length) {
    const outer = lineIndent(text, object.start);
    return splice(text, object.start, object.end, `{${eol}${outer}${unit}${name}: ${rendered(value, outer + unit, unit, eol)}${eol}${outer}}`);
  }
  const first = object.members[0];
  const last = object.members.at(-1);
  if (!text.slice(object.start, first.start).includes('\n')) return splice(text, last.value.end, last.value.end, `, ${name}: ${JSON.stringify(value)}`);
  const indent = lineIndent(text, first.start);
  return splice(text, last.value.end, last.value.end, `,${eol}${indent}${name}: ${rendered(value, indent, unit, eol)}`);
}
// Removes one of several members.
function removeMember(text, object, index) {
  const { members } = object;
  return index > 0 ? splice(text, members[index - 1].value.end, members[index].value.end) : splice(text, members[0].start, members[1].start);
}
function replaceValue(text, member, value, unit) {
  const multiline = text.slice(member.value.start, member.value.end).includes('\n');
  return splice(text, member.value.start, member.value.end, multiline ? rendered(value, lineIndent(text, member.start), unit, endOfLine(text)) : JSON.stringify(value));
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Where a config path is written: a link's target, or the path through real directories, and
// the first directory that doesn't exist yet (which an install would create).
async function resolveTarget(path) {
  const info = await lstat(path).catch(() => null);
  if (info?.isSymbolicLink()) {
    try { return { real: await realpath(path), missing: null }; }
    catch { throw Object.assign(new Error(`${path} is a symbolic link to a file that doesn't exist; fix the link, then agents install`), { code: 'CONFIG_LINK_BROKEN' }); }
  }
  let existing = dirname(path);
  const rest = [basename(path)];
  for (;;) {
    const resolved = await realpath(existing).catch(() => null);
    if (resolved) return { real: join(resolved, ...rest), missing: rest.length > 1 ? join(resolved, rest[0]) : null };
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
}
// One config file, parsed: `text` is what the edit is computed from and `expected` what the file
// must hold for the swap (the same, except when folding in a change made during a swap).
function parseConfig(path, text) {
  let data;
  try { data = JSON.parse(text); } catch (error) { throw malformed(path, `is not plain JSON (${error.message})`); }
  if (!plainObject(data)) throw malformed(path, 'does not hold a JSON object');
  if (data.mcpServers !== undefined && !plainObject(data.mcpServers)) throw malformed(path, 'has an mcpServers value that is not an object');
  const top = scanValue(text, 0, path);
  return { text, data, top, servers: top.members.find(member => member.key === 'mcpServers') ?? null, unit: text.match(/^[ \t]+(?=")/m)?.[0] ?? '  ' };
}
async function readConfig(path) {
  const { real, missing: missingDirectory } = await resolveTarget(path);
  let text;
  try { text = await readFile(real, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { path, real, missingDirectory, text: null, expected: null, missing: true, data: {}, top: null, servers: null, identity: null };
    throw Object.assign(new Error(`${path} can't be read (${error.code ?? 'error'}); it is left as it is`), { code: writeCodes.has(error.code) ? 'NOT_READABLE' : 'READ_FAILED' });
  }
  return { path, real, missingDirectory, ...parseConfig(path, text), expected: text, identity: await fileIdentity(real), mode: (await stat(real)).mode & 0o7777 };
}
const serverMember = (config, name) => config.servers?.value.members.find(member => member.key === name) ?? null;
const raced = () => Object.assign(new Error('raced'), { code: 'RACED' });
const conflict = (path, why) => Object.assign(new Error(`${path} ${why}`), { code: 'MCP_CONFLICT' });
// Files Context Kit leaves beside a config file. Each name carries the hash of what Context Kit
// expected it to hold: its own temporary (`t`), a capture of the file it read (`p`), the file an
// uninstall moved aside to delete (`o`), or a previous version it replaced or deleted (`v`).
// A previous version is kept, not deleted, because a harness holding the file open may still
// write to it; a later run deletes it once it is an hour old (CONTEXT_KIT_KEEP_PREVIOUS_MS) and
// still holds exactly what it held. Whatever holds something else is someone's bytes: it is
// moved to a new displaced name and reported. Leftovers of a process that is gone: a temporary
// that matches goes, a capture is a previous version, and a moved-aside file goes back when
// nothing took its place.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const digest = text => sha(text).slice(0, 16);
const keepPrevious = () => Number(process.env.CONTEXT_KIT_KEEP_PREVIOUS_MS ?? 3600000);
const leftoverPattern = real => new RegExp(`^\\.${basename(real).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.context-kit-(\\d+)-(\\d+)-([tpov])([0-9a-f]{16})$`);
// Config files with leftovers, and a directory an install created for one, so a later run can
// finish with them even after uninstall dropped the record (saved to .state/leftovers.json).
const noted = new Map();
const noteLeftover = (real, createdDirectory) => noted.set(real, { real, ...(createdDirectory ?? noted.get(real)?.createdDirectory ? { createdDirectory: createdDirectory ?? noted.get(real).createdDirectory } : {}) });
// A name nothing else has: linked, which never replaces an existing file, then the old name dropped.
async function displace(path, real) {
  for (let n = 0; ; n++) {
    const target = join(dirname(real), `${basename(real)}.context-kit-displaced-${Date.now()}-${process.pid}-${n}`);
    try { await link(path, target); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    await rm(path, { force: true });
    return target;
  }
}
// A second name of a file: dropped while the file is still at `real` (its data stays there),
// otherwise kept as a previous version.
async function release(path, real) {
  if (sameFile(await fileIdentity(path), await fileIdentity(real))) return rm(path, { force: true });
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return;
  await rename(path, join(dirname(path), `.${basename(real)}.context-kit-${process.pid}-${Date.now()}-v${digest(text)}`)).catch(() => {});
  noteLeftover(real);
}
async function recoverConfig(real) {
  const directory = dirname(real);
  const pattern = leftoverPattern(real);
  const displaced = [];
  for (const name of await readdir(directory).catch(() => [])) {
    const match = name.match(pattern);
    if (!match) continue;
    const [, pid, made, kind, hash] = match;
    const gone = !alive(Number(pid)) || Date.now() - Number(made) > 3600000;
    if (kind !== 'v' && !gone) continue;
    const path = join(directory, name);
    if (!(await lstat(path).catch(() => null))?.isFile()) continue;
    try {
      if (kind === 'o') {
        try { await link(path, real); await rm(path, { force: true }); continue; } catch { /* Something took its place. */ }
      } else if (digest(await readFile(path, 'utf8')) === hash) {
        if (kind === 't' || Date.now() - Number(made) >= keepPrevious()) await rm(path, { force: true });
        else noteLeftover(real);
        continue;
      }
      displaced.push(await displace(path, real));
    } catch { /* Left as it is. */ }
  }
  return displaced;
}
const leftoversPath = root => join(root, '.state', 'leftovers.json');
// Finishes with earlier leftovers (see recoverConfig) and saves the ones still pending.
async function sweepLeftovers(root) {
  let entries = [];
  try { entries = JSON.parse(await readFile(leftoversPath(root), 'utf8')).items ?? []; } catch { /* None. */ }
  for (const entry of entries) noteLeftover(entry.real, entry.createdDirectory);
  const displaced = [];
  for (const entry of [...noted.values()]) {
    displaced.push(...await recoverConfig(entry.real));
    const left = (await readdir(dirname(entry.real)).catch(() => [])).some(name => leftoverPattern(entry.real).test(name));
    if (left) continue;
    if (entry.createdDirectory && !await exists(entry.real)) displaced.push(...await removeCreated(entry.createdDirectory, entry.real));
    noted.delete(entry.real);
  }
  return displaced;
}
async function saveLeftovers(root) {
  const items = [...noted.values()];
  if (!items.length) return rm(leftoversPath(root), { force: true });
  await mkdir(join(root, '.state'), { recursive: true });
  const temporary = `${leftoversPath(root)}.${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify({ version: 1, items }, null, 2) + '\n');
  await rename(temporary, leftoversPath(root));
}
// Puts `text` in place of config.expected (null: deletes the file), only while the file is the one
// read: a capture link of it must have the identity read and the expected content, and the path
// must still hold that file just before the rename. `hooks.directory(path)` runs before a missing
// directory is created and `hooks.built(identity)` before the swap, so the records can say what
// is about to happen. Throws RACED when nothing was written and the plan should be redone, and
// MCP_CONFLICT when another writer changed the file during the swap; then the file is put back as
// that writer left it.
//
// Residual: POSIX has no conditional rename, so a writer that replaces the file by its own rename
// between the last check and this rename loses its change. An in-place writer in that window is
// detected through the capture and its bytes put back.
async function place(config, text, hooks, depth = 0) {
  const { real } = config;
  const directory = dirname(real);
  const stamp = `.${basename(real)}.context-kit-${process.pid}-${Date.now()}`;
  if (text === null) {
    // Moved aside, which is atomic, and checked: a file that isn't the one read is put back.
    const aside = join(directory, `${stamp}-o${digest(config.expected)}`);
    try { await rename(real, aside); } catch (error) { if (error.code === 'ENOENT') throw raced(); throw error; }
    // The deleted file is kept as a previous version: a harness holding it open may still write.
    if (sameFile(await fileIdentity(aside), config.identity) && await readFile(aside, 'utf8').catch(() => null) === config.expected) return release(aside, real);
    try { await link(aside, real); } catch {
      throw conflict(config.path, `was replaced during uninstall; the version it held is kept at ${await displace(aside, real)}`);
    }
    await release(aside, real);
    throw raced();
  }
  if (config.missingDirectory) await hooks.directory?.(config.missingDirectory);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${stamp}-t${digest(text)}`);
  const capture = join(directory, `${stamp}-p${digest(config.expected ?? '')}`);
  try {
    await writeFile(temporary, text, { mode: config.mode ?? 0o600, flag: 'wx' });
    await chmod(temporary, config.mode ?? 0o600);
    const built = await fileIdentity(temporary);
    await hooks.built?.(built);
    if (config.expected === null) {
      // A new file is linked into place, which fails if one appeared meanwhile.
      try { await link(temporary, real); } catch (error) { if (error.code === 'EEXIST') throw raced(); throw error; }
      return;
    }
    try { await link(real, capture); } catch (error) { if (error.code === 'ENOENT') throw raced(); throw error; }
    if (!sameFile(await fileIdentity(capture), config.identity) || await readFile(capture, 'utf8') !== config.expected) { await release(capture, real); throw raced(); }
    if (!sameFile(await fileIdentity(real), config.identity)) { await release(capture, real); throw raced(); }
    await rename(temporary, real);
    // The capture names the file the swap displaced: an in-place write during the swap shows
    // there. Its bytes go back in place of ours, by the same checked swap; what can't go back
    // (another write meanwhile, or writes that keep coming) is kept displaced.
    const after = await readFile(capture, 'utf8');
    // The replaced file is kept as a previous version, as for a delete.
    if (after === config.expected) return release(capture, real);
    if (depth >= 3) throw conflict(config.path, `kept changing while Context Kit edited it; the version another writer left is kept at ${await displace(capture, real)}`);
    try { await place({ ...config, expected: text, identity: built, missingDirectory: null }, after, {}, depth + 1); }
    catch (error) {
      if (error.code !== 'RACED' && error.code !== 'MCP_CONFLICT') throw error;
      throw conflict(config.path, `was changed while Context Kit edited it, and again before it could be put back; the version the first writer left is kept at ${await displace(capture, real)}`);
    }
    await release(capture, real);
    throw conflict(config.path, 'was changed while Context Kit edited it, so it is left as the other writer left it. Run agents install again');
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
// Reads, plans and places until the plan applies to what the file holds; every attempt is
// computed from what the file holds then, and nothing is written for an attempt that raced.
// `plan(config)` returns { done } to stop without writing, or { text } to write (null deletes).
async function transact(path, plan, hooks = {}) {
  const displaced = await recoverConfig((await resolveTarget(path)).real);
  const tagged = error => Object.assign(error, displaced.length ? { displaced } : {});
  let config = await readConfig(path);
  for (let attempt = 0; attempt < 4; attempt++) {
    const step = await plan(config);
    if (step.done) return { ...step, config, displaced: [...displaced, ...(step.displaced ?? [])] };
    try { await place(config, step.text, hooks); return { ...step, config, displaced }; }
    catch (error) { if (error.code !== 'RACED') throw tagged(error); }
    try { config = await readConfig(path); }
    catch (error) {
      if (error.code !== 'CONFIG_MALFORMED') throw tagged(error);
      throw tagged(conflict(path, `was changed while Context Kit edited it, to something that isn't plain JSON; it is left as it is`));
    }
  }
  throw tagged(conflict(path, 'kept changing while Context Kit edited it; nothing was written. Run agents install again'));
}
// Read-only and tolerant: Gemini CLI's own settings may hold comments, which it allows.
async function readLoose(path) {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  const plain = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '').replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(plain); } catch { return null; }
}
const OWN_CODES = ['MCP_CONFLICT', 'NOT_READABLE', 'READ_FAILED'];
const configFailure = (base, error) => ({ ...configFailureOf(base, error), ...(error.displaced ? { displaced: error.displaced } : {}) });
const configFailureOf = (base, error) => ['CONFIG_MALFORMED', 'CONFIG_LINK_BROKEN'].includes(error.code)
  ? { ...base, action: 'refused', code: error.code, reason: error.message }
  : OWN_CODES.includes(error.code) ? { ...base, action: 'failed', code: error.code, reason: error.message }
    : { ...base, action: 'failed', ...writeFailure(error, base.path) };
const ownEntry = (record, value) => record.entry !== undefined && isDeepStrictEqual(value, record.entry);
// What the install created around its entry, claimed only while the file is the one it wrote.
const CREATED = ['createdFile', 'createdContainer', 'empty', 'createdDirectory'];
const createdBy = (record, config) => record && config.real === record.real && sameFile(config.identity, record.identity)
  ? Object.fromEntries(CREATED.filter(key => record[key] !== undefined).map(key => [key, record[key]])) : {};
const retargetedReason = (path, record) => `${path} now leads to ${record.now ?? 'another file'}, not the file Context Kit edited (${record.real}); it is left as it is`;
// Directories an install created for a config file, deepest first, while they are empty, after
// what an interrupted write left in the file's own directory.
async function removeCreated(createdDirectory, real) {
  const displaced = await recoverConfig(real);
  for (let directory = dirname(real); !relative(createdDirectory, directory).startsWith('..'); directory = dirname(directory)) {
    try { await rmdir(directory); } catch { break; }
    if (directory === createdDirectory) break;
  }
  return displaced;
}
// An install interrupted around its swap: the entry it wrote is its own only if the file at the
// recorded target is the very file it built. Otherwise the record is what it was before, and a
// directory a first install created for it goes while empty.
async function settleJson(record) {
  if (!record?.pending) return record;
  const { pending, ...prior } = record;
  const target = await resolveTarget(record.path).catch(() => null);
  if (pending.identity && target?.real === pending.real && sameFile(await fileIdentity(pending.real), pending.identity)) {
    const { first: _, ...done } = pending;
    return { ...prior, ...done };
  }
  if (pending.first && pending.createdDirectory) await removeCreated(pending.createdDirectory, join(pending.createdDirectory, basename(record.path)));
  return pending.first ? null : prior;
}
async function registerJson(agent, name, command, root, env, records, { force = false, save }) {
  const path = AGENTS[agent].mcp.file(env);
  const entry = AGENTS[agent].mcp.entry(command);
  const base = { agent, kind: 'mcp', name, path };
  const index = records.findIndex(item => item.kind === 'mcp' && item.agent === agent && item.path === path && item.name === name);
  let record = index < 0 ? null : await settleJson(records[index]);
  if (index >= 0) records.splice(index, 1, ...(record ? [record] : []));
  let current = record;
  const keep = next => { records.splice(0, records.length, ...records.filter(item => item !== current), ...(next ? [next] : [])); current = next; };
  const kept = { kind: 'mcp', agent, name, scope: 'user', path, root, command, entry };
  let made = {};
  let planned = {};
  let outcome;
  try {
    outcome = await transact(path, async config => {
      const member = serverMember(config, name);
      const found = member ? config.data.mcpServers[name] : undefined;
      const retargeted = record && !config.missing && config.real !== record.real;
      if (retargeted && !force) return { done: { action: 'conflict', code: 'MCP_REPLACED', state: 'replaced', reason: `${retargetedReason(path, { ...record, now: config.real })}; pass --force to edit it` } };
      const owner = retargeted ? null : record;
      if (member && !owner && !force) return { done: { action: 'conflict', code: 'MCP_FOREIGN', reason: `${path} already lists an MCP server named ${name} that Context Kit didn't add; remove it or pass --force` } };
      if (member && owner && !ownEntry(owner, found) && !force) return { done: { action: 'edited', state: 'edited', reason: `${path} holds an edited ${name} entry; it is kept. Pass --force to replace it` } };
      const inherited = createdBy(owner, config);
      if (member && isDeepStrictEqual(found, entry)) return { done: { action: 'unchanged', created: inherited } };
      let text;
      let created = { ...inherited };
      if (config.missing) {
        text = `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`;
        // A directory the install created earlier and is still there stays its own.
        created = { createdFile: true, createdContainer: true, ...(owner?.createdDirectory && !config.missingDirectory ? { createdDirectory: owner.createdDirectory } : {}) };
      } else if (!config.servers) {
        text = addMember(config.text, config.top, 'mcpServers', { [name]: entry }, config.unit);
        const { createdFile } = inherited;
        created = { ...(createdFile ? { createdFile } : {}), createdContainer: true, ...(config.top.members.length ? {} : { empty: config.text.slice(config.top.start, config.top.end) }) };
      } else if (member) text = replaceValue(config.text, member, entry, config.unit);
      else {
        const servers = config.servers.value;
        text = addMember(config.text, servers, name, entry, config.unit);
        if (!inherited.createdContainer) {
          delete created.empty;
          if (!servers.members.length) created.empty = config.text.slice(servers.start, servers.end);
        }
      }
      planned = created;
      return { text, created };
    }, {
      // Recorded before the directory and before the swap, so an interrupted install's entry is
      // still its own and its directory goes with it.
      directory: async directory => { made.createdDirectory = directory; keep({ ...(record ?? kept), pending: { first: !record, createdDirectory: directory } }); await save(); },
      built: async identity => {
        const target = await resolveTarget(path);
        keep({ ...(record ?? kept), pending: { ...kept, first: !record, real: target.real, identity, ...planned, ...made } });
        await save();
      },
    });
  } catch (error) {
    keep(record);
    // The entry to add by hand.
    return { ...configFailure(base, error), entry };
  }
  if (outcome.done) {
    if (outcome.done.action === 'unchanged') keep({ ...kept, real: outcome.config.real, identity: outcome.config.identity, ...outcome.done.created });
    else keep(record);
    const { created: _, ...result } = outcome.done;
    return { ...base, ...result, ...shown(outcome) };
  }
  const real = (await resolveTarget(path)).real;
  const createdDirectory = made.createdDirectory ?? outcome.created.createdDirectory;
  keep({ ...kept, ...outcome.created, ...(createdDirectory ? { createdDirectory } : {}), real, identity: await fileIdentity(real) });
  return { ...base, action: record && serverMember(outcome.config, name) ? 'updated' : 'installed', ...shown(outcome) };
}
// Copies of the file an interrupted write left that held bytes Context Kit can't account for.
const shown = outcome => outcome.displaced?.length ? { displaced: outcome.displaced,
  note: `kept what an interrupted write left beside the file, which may hold changes of yours: ${outcome.displaced.join(', ')}` } : {};
async function jsonState(record) {
  if (record.pending) return 'pending';
  let config;
  try { config = await readConfig(record.path); }
  catch (error) { return error.code === 'CONFIG_MALFORMED' ? 'malformed' : 'unreadable'; }
  if (!config.missing && config.real !== record.real) return 'replaced';
  const member = serverMember(config, record.name);
  if (!member) return 'missing';
  return ownEntry(record, config.data.mcpServers[record.name]) ? 'installed' : 'edited';
}
// Removes exactly the recorded entry from what the file holds now, and what the install created
// for it while the file is still the one it wrote. An edited entry stays unless forced; a file
// the path no longer leads to is someone else's (skipped, its record dropped).
async function uninstallJson(record, { force = false } = {}) {
  const base = { agent: record.agent, kind: 'mcp', name: record.name, path: record.path };
  const settled = await settleJson(record);
  if (!settled) return { ...base, action: 'skipped', drop: true, reason: 'its install never finished, so what is there is left as it is' };
  let outcome;
  try {
    outcome = await transact(record.path, async config => {
      if (!config.missing && config.real !== settled.real) return { done: { action: 'skipped', code: 'MCP_REPLACED', drop: true, reason: retargetedReason(record.path, { ...settled, now: config.real }) } };
      const member = serverMember(config, record.name);
      if (!member) {
        // A created file already gone (an uninstall interrupted after deleting it): its empty
        // directories go too.
        let kept = [];
        if (config.missing && settled.createdFile && settled.createdDirectory) {
          kept = await removeCreated(settled.createdDirectory, config.real);
          if (await exists(settled.createdDirectory)) noteLeftover(config.real, settled.createdDirectory);
        }
        return { done: { action: 'removed', drop: true, reason: 'already absent' }, displaced: kept };
      }
      if (!ownEntry(settled, config.data.mcpServers[record.name]) && !force) return { done: { action: 'kept', state: 'edited', reason: `${record.path} holds an edited ${record.name} entry; pass --force to remove it` } };
      const created = createdBy(settled, config);
      const servers = config.servers.value;
      const { top } = config;
      let text;
      if (servers.members.length > 1) text = removeMember(config.text, servers, servers.members.indexOf(member));
      else if (!created.createdContainer) text = splice(config.text, servers.start, servers.end, created.empty ?? '{}');
      else if (top.members.length > 1) text = removeMember(config.text, top, top.members.indexOf(config.servers));
      else text = created.createdFile ? null : splice(config.text, top.start, top.end, created.empty ?? '{}');
      return { text, created };
    });
  } catch (error) { return { ...configFailure(base, error), action: 'kept' }; }
  if (outcome.done) return { ...base, ...outcome.done, ...shown(outcome) };
  // Directories the install created, deepest first, while they are empty.
  const { createdDirectory } = outcome.created;
  if (outcome.text === null && createdDirectory) {
    outcome.displaced = [...outcome.displaced, ...await removeCreated(createdDirectory, outcome.config.real)];
    if (await exists(createdDirectory)) noteLeftover(outcome.config.real, createdDirectory);
  }
  return { ...base, action: 'removed', drop: true, ...shown(outcome) };
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
    if (record.kind === 'mcp' && record.path && record.name !== serverNameNow) {
      if (!(await uninstallJson(record)).drop) continue;
      drop();
      results.push({ agent: record.agent, kind: 'mcp', name: record.name, path: record.path, action: 'removed', reason: `registered for ${from}, which moved` });
    } else if (record.kind === 'mcp' && record.name !== serverNameNow) {
      const cli = await which(AGENTS[record.agent].cli, env);
      if (!cli) continue;
      await run(cli, ['mcp', 'remove', ...cliScope(record.agent, record.scope), record.name], env, record.project ?? root).catch(() => {});
      if (await mcpExists(record.agent, cli, record.name, env, record.project ?? root)) continue;
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

// A fixed code and reason for a harness CLI that failed. Its output is never repeated: it can
// carry tokens or paths the user didn't mean to share.
function cliFailure(cli, verb, error) {
  if (error.killed || error.code === 'ETIMEDOUT') return { code: 'MCP_CLI_TIMEOUT', reason: `${cli} mcp ${verb} did not finish within a minute` };
  if (typeof error.code === 'string') return { code: 'MCP_CLI_NOT_RUNNABLE', reason: `${cli} could not be run (${error.code})` };
  return { code: verb === 'add' ? 'MCP_ADD_FAILED' : 'MCP_REMOVE_FAILED', reason: `${cli} mcp ${verb} exited with status ${error.code ?? 'unknown'}; run it yourself to see why` };
}
async function mcpExists(agent, cli, name, env, cwd) {
  if (AGENTS[agent].mcp.has) return AGENTS[agent].mcp.has(name, env);
  try { await run(cli, ['mcp', 'get', name], env, cwd); return true; } catch { return false; }
}

export async function installAgents(root, options = {}) {
  parseOptions(options);
  return withAgentsLock(root, async () => {
    const displaced = await sweepLeftovers(root);
    const result = await installUnlocked(root, options);
    await saveLeftovers(root);
    return displaced.length ? { ...result, displaced } : result;
  });
}
async function installUnlocked(root, options) {
  const { agents, scope, project, env } = parseOptions(options);
  // Gemini CLI reads its skills under $GEMINI_CLI_HOME/.agents/skills when that is set, which is
  // not the shared ~/.agents/skills; refused before anything is written rather than missed.
  if (agents.includes('gemini') && scope === 'user' && env.GEMINI_CLI_HOME && resolve(env.GEMINI_CLI_HOME) !== resolve(home(env))) {
    fail('GEMINI_HOME_UNSUPPORTED', `GEMINI_CLI_HOME (${env.GEMINI_CLI_HOME}) moves Gemini CLI's skills to ${join(env.GEMINI_CLI_HOME, '.agents', 'skills')}, which Context Kit doesn't install into; ` +
      'unset it or point it at your home directory, or install without gemini');
  }
  // Every configuration the install reads is read before anything is written, so a broken one
  // (context-kit.json, an addon, the registry, .state/checkouts.json) refuses with INVALID_CONFIG
  // and nothing changed: the addons, then what rendering the routing skill reads, then the
  // workspace rule.
  const addons = await loadAddons(root);
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
  const skills = [...addons.filter(addon => addon.enabled).flatMap(addon => addon.skills), ...generated];
  for (const { location, agents: served } of skillLocations(agents, scope, env)) {
    const place = { location, agents: served, scope, keys: LOCATIONS[location].keys, directory: LOCATIONS[location].directory(scope, env, project), save: () => saveRecords(root, records) };
    const blocked = await prepareDirectory(place);
    if (blocked) {
      for (const skill of skills) results.push({ agent: served[0], agents: served, kind: 'skill', name: skill.name, path: join(place.directory, skill.name), action: 'failed', ...blocked });
    } else {
      for (const skill of skills) await installSkill(place, skill, records, results, { ...options, root, env });
      // Remove unchanged skills this installer placed here that no enabled addon provides now.
      for (const record of records.filter(item => item.kind === 'skill' && resolve(item.path, '..') === place.directory && !skills.some(skill => skill.name === item.name))) {
        const report = (action, extra = {}) => results.push({ agent: record.agents[0], agents: record.agents, kind: 'skill', name: record.name, path: record.path, action, ...extra });
        const state = await skillState(record);
        if (state === 'replaced' && !await mayReadopt(record, root, env, options.adopt)) { report('kept', { code: 'SKILL_REPLACED', state, reason: replacedReason(record.path, await sameContent(record)) }); continue; }
        if (state === 'changed') { report('kept', { code: 'SKILL_EDITED', reason: 'edited since install' }); continue; }
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
  const warnings = await seenTwice(agents, scope, env, project, records);
  try {
    for (const agent of agents) {
      results.push(await registerServer(root, agent, scope, project, env, records, options, () => saveRecords(root, records)));
      results.push(await installGuard(root, agent, scope, env, project, records, options));
    }
    results.push(...await installRule(root, agents, scope, env, records, await routingEntry(root, records, server), options));
    results.push(...await installHooks(root, records, options));
  } finally { await saveRecords(root, records); }
  return { root, scope, results, warnings, skipped: skippedNames(generated) };
}

// Directories a harness reads skills from that its documentation ranks against none of the
// others. Cursor loads ~/.agents/skills, ~/.cursor/skills and, for compatibility,
// ~/.claude/skills and ~/.codex/skills (the same four under a project), with no precedence.
const UNRANKED = { cursor: base => ['.agents', '.cursor', '.claude', '.codex'].map(name => join(base, name, 'skills')) };
// A warning per skill this workspace installed into two or more of them.
async function seenTwice(agents, scope, env, project, records) {
  const warnings = [];
  for (const agent of agents.filter(item => UNRANKED[item])) {
    const directories = UNRANKED[agent](scope === 'user' ? home(env) : project);
    const byName = new Map();
    for (const record of records.filter(item => item.kind === 'skill' && directories.includes(dirname(item.path)))) {
      if (await skillState(record) === 'missing') continue;
      byName.set(record.name, union(byName.get(record.name) ?? [], [record.path]));
    }
    for (const [name, paths] of byName) {
      if (paths.length < 2) continue;
      const hashes = new Set(await Promise.all(paths.map(path => hashTree(path).catch(() => path))));
      warnings.push({ agent, code: 'READ_TWICE', name, paths,
        reason: `${AGENTS[agent].label} reads ${name} from ${paths.join(' and ')}, and its documentation gives no precedence between them; ` +
          `the copies ${hashes.size === 1 ? 'are identical' : 'differ'}` });
    }
  }
  return warnings;
}

async function registerServer(root, agent, scope, project, env, records, { allowWrite = false, globalMcp = false, force = false, name: override }, save) {
  const name = serverName(root, override);
  const base = { agent, kind: 'mcp', name };
  if (agent === 'codex' && scope === 'project' && !globalMcp) {
    return { ...base, action: 'skipped', reason: 'Codex has no project-scoped MCP; pass --global-mcp to register it for the user' };
  }
  if (scope === 'project' && AGENTS[agent].projectMcp === false) {
    return { ...base, action: 'skipped', reason: `${AGENTS[agent].label}'s project MCP config is usually committed, so Context Kit registers it only at user scope; its skills are in the project` };
  }
  // Absolute paths: MCP clients started outside a shell may not see nvm's PATH.
  const command = [process.execPath, join(KIT_ROOT, 'bin', 'mcp.mjs'), '--root', root, '--no-skill-prompts', ...(allowWrite ? ['--allow-write'] : [])];
  if (AGENTS[agent].mcp.kind === 'json') return registerJson(agent, name, command, root, env, records, { force, save });
  const cli = await which(AGENTS[agent].cli, env);
  if (!cli) return { ...base, action: 'skipped', reason: `${AGENTS[agent].cli} CLI not found on PATH` };
  const agentScope = agent === 'claude' && scope !== 'user' ? 'local' : 'user';
  const cwd = scope === 'project' ? project : root;
  const record = records.find(item => item.kind === 'mcp' && item.agent === agent && item.name === name && item.scope === agentScope && (agentScope !== 'local' || item.project === project));
  if (!record && await mcpExists(agent, cli, name, env, cwd) && !force) {
    return { ...base, action: 'conflict', reason: `${agent} already has an MCP server named ${name}; remove it or pass --force` };
  }
  const scopeArgs = cliScope(agent, agentScope);
  await run(cli, ['mcp', 'remove', ...scopeArgs, name], env, cwd).catch(() => {});
  const add = AGENTS[agent].mcp.add?.(name, command) ?? [name, '--', ...command];
  try { await run(cli, ['mcp', 'add', ...scopeArgs, ...add], env, cwd); }
  catch (error) { return { ...base, action: 'failed', ...cliFailure(AGENTS[agent].cli, 'add', error) }; }
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
    if (record.kind === 'rule') {
      const state = record.pending ? 'pending' : await ruleState(record);
      items.push({ agent: record.agent, kind: 'rule', name: record.name, path: record.path, enabled: Boolean(record.enabled), ...moved(record, state === 'changed' ? 'edited' : state, ['installed']) });
      continue;
    }
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
      if (state === 'replaced') {
        const same = await sameContent(record);
        shown.reason = !same ? replacedReason(record.path, false)
          : await ownsLauncher(root, env) ? `${record.path} was replaced by a copy with the installed content; agents install takes it back` : replacedReason(record.path, true);
      }
      for (const agent of servedBy(record)) items.push({ agent, kind: 'skill', name: record.name, path: record.path, mode: record.mode, ...shown });
    } else if (record.kind === 'mcp' && record.path) {
      let state = await jsonState(record);
      const from = state === 'installed' && movedFrom(record, root);
      if (state === 'installed' && !from && !await exists(record.command[0])) state = 'broken';
      items.push({ agent: record.agent, kind: 'mcp', name: record.name, scope: record.scope, path: record.path, ...(from ? moved(record, state, ['installed']) : { state }),
        ...(state === 'broken' ? { reason: `${record.command[0]} no longer exists; run agents install again` } : {}) });
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
  parseAgents(options.agents, Object.keys(AGENTS));
  return withAgentsLock(root, async () => {
    const displaced = await sweepLeftovers(root);
    const result = await uninstallUnlocked(root, options);
    await saveLeftovers(root);
    return displaced.length ? { ...result, displaced } : result;
  });
}
async function uninstallUnlocked(root, options) {
  const env = options.env ?? process.env;
  const agents = parseAgents(options.agents, Object.keys(AGENTS));
  const remaining = [];
  const results = [];
  const all = await loadRecords(root);
  await ensureRecordsWritable(root, all);
  // Hooks and the launcher serve every agent, so they go only when no agent's items remain installed.
  const hooks = all.filter(record => record.kind === 'hook' || record.kind === 'launcher');
  // Before each item: this command still holds the lock, so one that lost it (a sleep past the
  // stale age, a takeover) stops before deleting anything more. What it already removed shows
  // as missing, and the next uninstall finishes.
  for (let record of all.filter(item => item.kind !== 'hook' && item.kind !== 'launcher')) {
    await lockHeld(root);
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
      // Replaced by a copy this installer didn't place: removed only when it may be taken back
      // (the installed content, and this workspace's launcher or --adopt), never with --force alone.
      if (state === 'replaced' && !await mayReadopt(record, root, env, options.adopt)) {
        results.push({ ...base, action: 'skipped', code: 'SKILL_REPLACED', reason: `${record.path} was replaced since install by a copy Context Kit didn't put there; it is left as it is` });
        continue;
      }
      if (state === 'changed' && !options.force) { remaining.push(record); results.push({ ...base, action: 'kept', code: 'SKILL_EDITED', reason: 'edited since install' }); continue; }
      const link = (record.location === 'agents' || legacyCodex(record)) && await symlinkedBelow(anchorFor(record.path, env), dirname(record.path));
      if (link) { remaining.push(record); results.push({ ...base, action: 'kept', code: 'SYMLINKED_PATH', reason: `${link} is a symbolic link; remove ${record.path} yourself` }); continue; }
      try { await rm(record.path, { recursive: true, force: true }); }
      catch (error) { remaining.push(record); results.push({ ...base, action: 'kept', ...writeFailure(error, dirname(record.path)) }); continue; }
      results.push({ ...base, action: 'removed' });
      continue;
    }
    if (!agents.includes(record.agent)) { remaining.push(record); continue; }
    if (record.kind === 'rule') {
      const settled = await settleRule(record);
      if (!settled) continue;
      const { drop, ...result } = await removeRule(settled, env, options);
      if (!drop) remaining.push(settled);
      results.push(result);
      continue;
    }
    if (record.kind === 'guard') {
      const result = await uninstallGuard(record, options);
      if (result.action === 'kept') remaining.push(record);
      results.push(result);
      continue;
    }
    if (record.kind === 'mcp' && record.path) {
      const { drop, ...result } = await uninstallJson(record, options);
      if (!drop) remaining.push(record);
      results.push(result);
      continue;
    }
    const base = { agent: record.agent, kind: record.kind, name: record.name };
    const cli = await which(AGENTS[record.agent].cli, env);
    if (!cli) { remaining.push(record); results.push({ ...base, action: 'kept', reason: `${AGENTS[record.agent].cli} CLI not found on PATH` }); continue; }
    // A remove that failed while the server is still registered keeps its record, so a later
    // uninstall tries again; one that failed because it was already gone is done.
    let failure = null;
    try { await run(cli, ['mcp', 'remove', ...cliScope(record.agent, record.scope), record.name], env, record.project ?? root); }
    catch (error) { failure = error; }
    if (failure && await mcpExists(record.agent, cli, record.name, env, record.project ?? root)) {
      remaining.push(record);
      results.push({ ...base, action: 'kept', state: 'failed', ...cliFailure(AGENTS[record.agent].cli, 'remove', failure) });
      continue;
    }
    results.push({ ...base, action: 'removed' });
  }
  for (const record of hooks) {
    if (remaining.length) { remaining.push(record); continue; }
    await lockHeld(root);
    const state = record.kind === 'launcher' ? await launcherState(record) : await hookState(record);
    const base = { kind: record.kind, name: record.name, path: record.path };
    if (state === 'unreadable') { remaining.push(record); results.push({ ...base, action: 'kept', code: 'NOT_READABLE', reason: `${record.path} can't be read; it is left as it is` }); continue; }
    if (state === 'changed' && !options.force) { remaining.push(record); results.push({ ...base, action: 'kept', reason: 'edited since install' }); continue; }
    await rm(record.path, { force: true });
    results.push({ ...base, action: 'removed' });
  }
  // Leftovers first: once a record is dropped, only they say what is still to clean up.
  await saveLeftovers(root);
  await saveRecords(root, remaining);
  return { root, results };
}

// After repositories change: re-render generated skills and update every installed,
// unchanged copy in place, without touching MCP registrations. Wherever a generated skill
// is installed, routing shards that appear are installed beside it and ones that are no
// longer generated are removed, unless edited.
export async function refreshGeneratedSkills(root, options = {}) {
  return withAgentsLock(root, async () => {
    // Previous versions of config files, by the same rules as install and uninstall.
    const displaced = (await sweepLeftovers(root)).map(path => ({ kind: 'leftover', path, action: 'displaced',
      reason: 'kept what Context Kit had set aside beside a config file, which no longer holds what it held and may hold changes of yours' }));
    const outcome = await refreshUnlocked(root, options);
    await saveLeftovers(root);
    if (!displaced.length) return outcome;
    return Array.isArray(outcome) ? [...displaced, ...outcome] : { ...outcome, results: [...displaced, ...outcome.results] };
  });
}
async function refreshUnlocked(root, { report } = {}) {
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
      const state = await skillState(record);
      if (state === 'replaced' && !await mayReadopt(record, root, process.env, false)) { results.push(result(record, 'kept', { code: 'SKILL_REPLACED', state, reason: replacedReason(record.path, await sameContent(record)) })); continue; }
      if (state === 'changed') { results.push(result(record, 'kept', { code: 'SKILL_EDITED', reason: 'edited since install' })); continue; }
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
  // npm fetches a github: core with git, so it gets the scrubbed environment too.
  await exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: created.root, env: gitEnvironment(env), timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const { stdout } = await exec(process.execPath, [join(created.root, 'node_modules', 'context-kit', 'bin', 'hub.mjs'),
    '--root', created.root, 'agents', 'install', ...installArgs], { env, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  return { root: created.root, core, addons: created.addons, agents: JSON.parse(stdout) };
}
