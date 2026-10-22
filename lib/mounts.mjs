// Mounts: hubs from other git repositories, declared in the workspace's tracked
// context-kit.json at a pinned commit and fetched per machine into untracked
// .state/mounts/<name>/<key>/, a read-only export keyed by source, path and commit.
// Only add and fetch reach a source; nothing here moves a pin implicitly.
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { KIT_ROOT, loadHubs } from './hubs.mjs';
import { splitFrontmatter, summarize } from './okf.mjs';
import { fail, readText } from './files.mjs';
import { normalizeUpstream } from './repos.mjs';

const exec = promisify(execFile);
export const MOUNT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const KEYS = ['source', 'path', 'ref', 'commit'];
const TIERS = ['human-reviewed', 'machine-confirmed', 'unverified'];

// Why a source can't be stored, or null. Never includes the value: it may hold a secret.
export function sourceProblem(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 500) return 'source must be a git URL';
  const value = source.trim();
  if (/[\s\0]/.test(value)) return 'source must be a git URL';
  if (/[?#]/.test(value)) return 'source must not carry a query or fragment';
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase();
  if (scheme) {
    let url;
    try { url = new URL(value); } catch { return 'source must be a git URL'; }
    if (url.password) return 'source must not carry a password';
    if ((scheme === 'http' || scheme === 'https') && url.username) return 'HTTP(S) sources must not carry user info; use a git credential helper';
    if (!['http', 'https', 'ssh', 'git', 'git+ssh', 'file'].includes(scheme)) return 'source must be an HTTPS, SSH, git or file:// URL';
  } else if (/^[^/:]+@/.test(value) && value.slice(0, value.indexOf('@')).includes(':')) return 'source must not carry a password';
  let key;
  try { key = normalizeUpstream(value); } catch { key = null; }
  return key ? null : 'source must be a git URL';
}
// A repository-relative directory: '' for the root. null when it leaves the repository.
function cleanPath(path) {
  if (path === undefined) return '';
  if (typeof path !== 'string' || path.length > 500 || isAbsolute(path) || /[\\\0]/.test(path)) return null;
  const parts = path.split('/').filter(part => part && part !== '.');
  return parts.includes('..') ? null : parts.join('/');
}
// Problems with context-kit.json's mounts, one per mount and field, never echoing a source.
export function mountProblems(mounts) {
  if (!mounts || typeof mounts !== 'object' || Array.isArray(mounts)) return ['mounts must map mount names to {source, path, ref, commit}'];
  const problems = [];
  for (const [name, mount] of Object.entries(mounts)) {
    const problem = message => problems.push(`mounts.${JSON.stringify(name).slice(1, -1).slice(0, 80)}: ${message}`);
    if (name.length > 64 || !MOUNT_NAME.test(name)) problem('names are lowercase words joined by hyphens, at most 64 characters');
    if (!mount || typeof mount !== 'object' || Array.isArray(mount)) { problem('expected {source, path, ref, commit}'); continue; }
    const unknown = Object.keys(mount).filter(key => !KEYS.includes(key));
    if (unknown.length) problem(`unknown keys ${unknown.map(key => JSON.stringify(key).slice(0, 40)).join(', ')}`);
    const source = sourceProblem(mount.source);
    if (source) problem(source);
    if (Object.hasOwn(mount, 'path') && (typeof mount.path !== 'string' || cleanPath(mount.path) === null)) problem('path must be a directory inside the repository');
    if (Object.hasOwn(mount, 'ref') && (typeof mount.ref !== 'string' || !REF.test(mount.ref))) problem('ref must be a branch or tag name');
    if (typeof mount.commit !== 'string' || !COMMIT.test(mount.commit)) problem('commit must be a full 40-hex commit SHA');
  }
  return problems;
}

const configPath = root => join(root, 'context-kit.json');
async function readConfig(root) {
  let text;
  try { text = await readFile(configPath(root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  return JSON.parse(text); // Shape already checked by loadAddons on every operation.
}
// Declared mounts, sorted by name, with the identity their fetched content must match.
async function declared(root) {
  const mounts = (await readConfig(root))?.mounts ?? {};
  return Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b)).map(([name, mount]) => describe(name, mount));
}
function describe(name, { source, path, ref, commit }) {
  const clean = cleanPath(path);
  const identity = { source: normalizeUpstream(source), path: clean, commit: commit.toLowerCase() };
  const key = createHash('sha256').update(JSON.stringify([identity.source, identity.path, identity.commit])).digest('hex').slice(0, 32);
  return { name, source, path: clean, ref: ref ?? null, commit: identity.commit, identity, key };
}
async function writeConfig(root, update) {
  const config = await readConfig(root) ?? { version: 1, addons: await defaultAddons() };
  const mounts = update({ ...(config.mounts ?? {}) });
  const next = { ...config, mounts: Object.fromEntries(Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b))) };
  if (!Object.keys(next.mounts).length) delete next.mounts;
  const temporary = `${configPath(root)}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, configPath(root));
}
// A workspace without context-kit.json enables every addon; keep that when creating one.
async function defaultAddons() {
  const { loadAddons } = await import('./addons.mjs');
  return (await loadAddons(KIT_ROOT)).filter(addon => addon.name !== 'core').map(addon => addon.name);
}

const stateDir = (root, ...parts) => join(root, '.state', 'mounts', ...parts);
// Git that never prompts, never uses an askpass helper and stops in bounded time. Credential
// helpers and SSH agents configured by the user still apply. Messages are redacted.
function gitEnv(isolated = false) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  env.GIT_ALLOW_PROTOCOL ??= 'file:git:http:https:ssh';
  delete env.GIT_ASKPASS; delete env.SSH_ASKPASS;
  // Exporting a tree runs no user filters or hooks.
  if (isolated) Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  return env;
}
// For contacting a source: SSH in batch mode, unless the user chose their own SSH command.
let remote;
const remoteEnv = () => remote ??= (async () => {
  const env = gitEnv();
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return env;
  const configured = await exec('git', ['config', '--get', 'core.sshCommand'], { env, timeout: 10000 }).then(({ stdout }) => stdout.trim(), () => '');
  return configured ? env : { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
})();
export const redact = text => String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1');
async function git(args, { cwd, env, timeout = 120000 } = {}) {
  return (await exec('git', ['-c', 'core.askPass=', ...args], { cwd, env: env ?? await remoteEnv(), timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
function fetchFailed(mount, error, doing) {
  const detail = redact((error.stderr || error.message || '').toString()).trim().split('\n').filter(Boolean);
  const auth = detail.some(line => /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|http 40[13]|returned error: 40[13]/i.test(line));
  const reason = error.killed ? 'timed out' : auth ? 'authentication failed (configure a git credential helper or SSH key for it)' : detail.pop() ?? 'git failed';
  fail('FETCH_FAILED', `Mount ${mount.name}: ${doing} ${mount.source}: ${reason.slice(0, 300)}`);
}

// The commit a ref names at the source: its default branch when ref is null.
async function resolveRef(mount) {
  let output;
  try { output = await git(mount.ref ? ['ls-remote', '--', mount.source, mount.ref] : ['ls-remote', '--symref', '--', mount.source, 'HEAD']); }
  catch (error) { fetchFailed(mount, error, 'could not list'); }
  const lines = output.split('\n').filter(Boolean);
  if (!mount.ref) {
    const branch = lines.find(line => line.startsWith('ref: refs/heads/'))?.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/)?.[1];
    const commit = lines.find(line => /^[0-9a-f]{40}\tHEAD$/.test(line))?.slice(0, 40);
    if (!branch || !commit) fail('FETCH_FAILED', `Mount ${mount.name}: ${mount.source} has no default branch; pass --ref`);
    return { ref: branch, commit };
  }
  const refs = new Map(lines.map(line => line.split('\t')).map(([sha, name]) => [name, sha]));
  for (const name of [`refs/heads/${mount.ref}`, `refs/tags/${mount.ref}^{}`, `refs/tags/${mount.ref}`, mount.ref]) {
    if (refs.has(name)) return { ref: mount.ref, commit: refs.get(name) };
  }
  fail('FETCH_FAILED', `Mount ${mount.name}: ${mount.source} has no branch or tag ${mount.ref}`);
}
// Brings exactly the pinned commit into the mount's bare cache. Fetch by SHA first; if the
// host refuses it, fetch the ref's history and use the commit only if it is there.
async function fetchCommit(root, mount) {
  const cache = stateDir(root, '.git', mount.name);
  const recorded = await git(['--git-dir', cache, 'config', '--get', 'context-kit.source'], { env: gitEnv(true) }).catch(() => null);
  if (recorded?.trim() !== mount.identity.source) {
    // A cache only ever holds what its one source served.
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    await git(['init', '--quiet', '--bare', cache], { env: gitEnv(true) });
    await git(['--git-dir', cache, 'config', 'context-kit.source', mount.identity.source], { env: gitEnv(true) });
  }
  const has = () => git(['--git-dir', cache, 'cat-file', '-e', `${mount.commit}^{commit}`], { env: gitEnv(true) }).then(() => true, () => false);
  const base = ['--git-dir', cache, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules'];
  try { await git([...base, '--depth', '1', '--', mount.source, mount.commit], { timeout: 600000 }); }
  catch (error) {
    if (/authentication failed|could not read (username|password)|terminal prompts disabled|does not appear to be a git repository|could not resolve host|repository .* not found|unable to access/i.test(String(error.stderr))) {
      fetchFailed(mount, error, 'could not fetch from');
    }
    const shallow = (await git(['--git-dir', cache, 'rev-parse', '--is-shallow-repository'], { env: gitEnv(true) })).trim() === 'true';
    try { await git([...base, ...(shallow ? ['--unshallow'] : []), '--', mount.source, mount.ref ?? 'HEAD'], { timeout: 600000 }); }
    catch (fallback) { fetchFailed(mount, fallback, 'could not fetch from'); }
  }
  if (!await has()) fail('FETCH_FAILED', `Mount ${mount.name}: ${mount.source} does not have commit ${mount.commit}`);
  return cache;
}
// path must be a directory in the commit, reached without symlinks.
async function checkTreePath(cache, mount) {
  const parts = mount.path ? mount.path.split('/') : [];
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const entry = (await git(['--git-dir', cache, 'ls-tree', mount.commit, '--', prefix], { env: gitEnv(true) })).split('\n')
      .map(line => line.match(/^(\d+) (\w+) [0-9a-f]+\t(.*)$/)).find(match => match && match[3] === prefix);
    if (!entry) fail('NOT_A_HUB', `Mount ${mount.name}: ${mount.path} does not exist at ${mount.commit}`);
    if (entry[1] === '120000') fail('INVALID_PATH', `Mount ${mount.name}: ${prefix} is a symlink in the repository`);
    if (entry[2] !== 'tree') fail('NOT_A_HUB', `Mount ${mount.name}: ${mount.path} is not a directory at ${mount.commit}`);
  }
}
// Writable again, so content can be removed.
async function unlock(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isDirectory()) return;
  await chmod(path, 0o755);
  for (const entry of await readdir(path)) await unlock(join(path, entry));
}
async function lock(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) { for (const entry of await readdir(path)) await lock(join(path, entry)); }
  await chmod(path, info.isDirectory() || info.mode & 0o100 ? 0o555 : 0o444);
}
const removeTree = async path => { await unlock(path); await rm(path, { recursive: true, force: true }); };

// Exports path at the commit into a temporary sibling, records its identity last, makes it
// read-only and renames it into place. Returns the hub check of the exported tree.
async function exportCommit(root, cache, mount) {
  const directory = stateDir(root, mount.name);
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory)) if (entry.startsWith('.tmp-')) await removeTree(join(directory, entry));
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const index = join(cache, `index-${randomUUID()}`);
  try {
    await mkdir(temporary);
    const env = { ...gitEnv(true), GIT_INDEX_FILE: index };
    await git(['--git-dir', cache, 'read-tree', mount.path ? `${mount.commit}:${mount.path}` : mount.commit], { env });
    await git(['--git-dir', cache, '--work-tree', temporary, 'checkout-index', '--all', '--force'], { env, timeout: 600000 });
    const check = await inspectHub(temporary);
    await rm(join(temporary, '.mount.json'), { force: true });
    await writeFile(join(temporary, '.mount.json'), JSON.stringify({ version: 1, ...mount.identity }, null, 2) + '\n', { flag: 'wx' });
    await lock(temporary);
    try { await rename(temporary, join(directory, mount.key)); }
    catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; } // Another fetch got there first.
    return check;
  } finally {
    await rm(index, { force: true });
    await removeTree(temporary);
  }
}

// Whether a directory holds a hub manifest and a loadable OKF bundle (its curated documents
// are concepts), with its manifest id and concepts per OKF trust tier.
async function inspectHub(directory) {
  const broken = reason => ({ ok: false, reason, manifestId: null, trust: null });
  const manifestFile = join(directory, 'hub.json');
  const info = await lstat(manifestFile).catch(() => null);
  if (!info?.isFile()) return broken('no hub.json at the mounted path');
  let manifest;
  try { manifest = JSON.parse(await readText(manifestFile)); } catch (error) { return broken(`hub.json: ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1 || typeof manifest.id !== 'string' ||
      !Array.isArray(manifest.documents) || !manifest.documents.length || manifest.documents.some(item => typeof item !== 'string')) {
    return broken('hub.json is not a hub manifest');
  }
  let concepts;
  try { concepts = await conceptsIn(directory); } catch (error) { return broken(error.message); }
  for (const document of manifest.documents) {
    if (!concepts.has(document)) return broken(`${document}: curated document is not an OKF concept (a regular Markdown file with a type)`);
  }
  const trust = Object.fromEntries(TIERS.map(tier => [tier, 0]));
  for (const [path, data] of concepts) if (!path.startsWith('inbox/')) trust[summarize(data).summary.trust]++;
  return { ok: true, manifestId: manifest.id, trust };
}
// OKF concepts in an exported tree, by bundle-relative path. Its content is someone else's,
// so the walk never follows a symlink: only regular files inside the tree are read.
async function conceptsIn(directory) {
  const concepts = new Map();
  let entries = 0;
  const walk = async relativePath => {
    for (const entry of await readdir(join(directory, relativePath), { withFileTypes: true })) {
      if (++entries > 10000) fail('TOO_LARGE', 'Mounted bundle exceeds 10000 entries');
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(path);
      if (!entry.isFile() || !entry.name.endsWith('.md') || ['index.md', 'log.md'].includes(entry.name)) continue;
      if (concepts.size >= 2000) fail('TOO_LARGE', 'Mounted bundle exceeds 2000 concepts');
      const front = splitFrontmatter(await readText(join(directory, path)).catch(() => ''));
      if (front && !front.error && typeof front.data.type === 'string' && front.data.type.trim()) concepts.set(path, front.data);
    }
  };
  await walk('');
  return concepts;
}
// fetched when the export for this exact source, path and commit is present; broken when
// that export is not a loadable hub; unfetched otherwise.
async function status(root, mount) {
  const directory = stateDir(root, mount.name, mount.key);
  let descriptor;
  try { descriptor = JSON.parse(await readFile(join(directory, '.mount.json'), 'utf8')); } catch { descriptor = null; }
  const matches = descriptor && ['source', 'path', 'commit'].every(field => descriptor[field] === mount.identity[field]);
  if (!matches) return { status: 'unfetched', reason: `not fetched at this source, path and commit; run mounts fetch ${mount.name}`, manifestId: null, trust: null };
  const check = await inspectHub(directory);
  return check.ok ? { status: 'fetched', manifestId: check.manifestId, trust: check.trust }
    : { status: 'broken', reason: check.reason, manifestId: null, trust: null };
}
const view = async (root, mount) => ({ name: mount.name, source: mount.source, path: mount.path, ref: mount.ref, commit: mount.commit, ...await status(root, mount) });

export async function listMounts(root) {
  const mounts = [];
  for (const mount of await declared(root)) mounts.push(await view(root, mount));
  return { root, mounts };
}

// Mount commands change the workspace's tracked config or its state: only for an explicit
// workspace outside the toolkit checkout, like repos add.
async function writableWorkspace({ root, explicit }) {
  const offset = relative(await realpath(KIT_ROOT), root);
  if (!explicit || !offset || offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset)) {
    fail('WRITE_DISABLED', 'Mount commands require an explicit workspace outside the toolkit checkout');
  }
}
async function hubIds(root) {
  try { return new Set((await loadHubs(root)).map(hub => hub.manifest.id)); }
  catch (error) { if (error.code === 'NO_HUBS') return new Set(); throw error; }
}
// A mount named like a workspace hub would be ambiguous wherever a hub id is taken.
export async function mountNameClashes(root) {
  const ids = await hubIds(root);
  return (await declared(root)).filter(mount => ids.has(mount.name)).map(mount => mount.name);
}

export async function addMount(selection, { name, source, ref, path }) {
  const { root } = selection;
  await writableWorkspace(selection);
  if (name.length > 64 || !MOUNT_NAME.test(name)) fail('INVALID_INPUT', 'Mount names are lowercase words joined by hyphens, at most 64 characters');
  const problem = sourceProblem(source);
  if (problem) fail('INVALID_INPUT', `Mount ${name}: ${problem}`);
  const clean = cleanPath(path);
  if (clean === null) fail('INVALID_PATH', `Mount ${name}: --path must be a directory inside the repository`);
  if (ref !== undefined && !REF.test(ref)) fail('INVALID_INPUT', `Mount ${name}: --ref must be a branch or tag name`);
  if ((await declared(root)).some(mount => mount.name === name)) fail('MOUNT_EXISTS', `A mount is already called ${name}`);
  if ((await hubIds(root)).has(name)) fail('MOUNT_EXISTS', `A workspace hub is already called ${name}`);
  const pending = { name, source: source.trim(), ref: ref ?? null, path: clean, identity: { source: normalizeUpstream(source.trim()) } };
  const resolved = await resolveRef(pending);
  const mount = describe(name, { source: pending.source, path: clean, ref: resolved.ref, commit: resolved.commit });
  let check;
  try {
    const cache = await fetchCommit(root, mount);
    await checkTreePath(cache, mount);
    check = await exportCommit(root, cache, mount);
    if (!check.ok) fail('NOT_A_HUB', `Mount ${name}: ${mount.path || 'the repository root'} at ${mount.commit} is not a hub: ${check.reason}`);
  } catch (error) {
    await removeTree(stateDir(root, name));
    await rm(stateDir(root, '.git', name), { recursive: true, force: true });
    throw error;
  }
  await writeConfig(root, mounts => ({ ...mounts, [name]: { source: mount.source, ...(mount.path ? { path: mount.path } : {}), ref: mount.ref, commit: mount.commit } }));
  return { root, mount: await view(root, mount) };
}

// Fetches each mount (or one) at its pin. A failure is reported for that mount, which keeps
// whatever it had, and the others still fetch.
export async function fetchMounts(selection, { name } = {}) {
  const { root } = selection;
  await writableWorkspace(selection);
  const all = await declared(root);
  const chosen = name === undefined ? all : all.filter(mount => mount.name === name);
  if (name !== undefined && !chosen.length) fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
  const mounts = [];
  const failed = [];
  for (const mount of chosen) {
    const before = await status(root, mount);
    if (before.status !== 'unfetched') { mounts.push({ ...await view(root, mount), outcome: 'unchanged' }); continue; }
    try {
      const cache = await fetchCommit(root, mount);
      await checkTreePath(cache, mount);
      await exportCommit(root, cache, mount);
      mounts.push({ ...await view(root, mount), outcome: 'fetched' });
    } catch (error) {
      failed.push(mount.name);
      mounts.push({ ...await view(root, mount), outcome: 'failed',
        error: { code: 'FETCH_FAILED', message: redact(error.message) } });
    }
  }
  return { root, mounts, failed };
}

export async function removeMount(selection, { name }) {
  const { root } = selection;
  await writableWorkspace(selection);
  const mount = (await declared(root)).find(item => item.name === name);
  if (!mount) fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
  await writeConfig(root, mounts => { delete mounts[name]; return mounts; });
  await removeTree(stateDir(root, name));
  await rm(stateDir(root, '.git', name), { recursive: true, force: true });
  return { root, removed: name };
}
