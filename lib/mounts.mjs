// Mounts: hubs from other git repositories, declared in the workspace's tracked
// context-kit.json at a pinned commit and fetched per machine into untracked
// .state/mounts/<name>/<key>/, a read-only export keyed by source, path and commit.
// Only add, fetch and upgrade reach a source; only add and upgrade write a pin, on request.
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { conceptRef, hubFile, KIT_ROOT, loadHubs, loadMountedHub } from './hubs.mjs';
import { summarize } from './okf.mjs';
import { fail, readText } from './files.mjs';
import { normalizeUpstream, registry } from './repos.mjs';

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
  const problems = mountProblems(mounts);
  if (problems.length) fail('INVALID_CONFIG', `context-kit.json: ${problems.join('; ')}`);
  return Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b)).map(([name, mount]) => describe(name, mount));
}
function describe(name, { source, path, ref, commit }) {
  const clean = cleanPath(path);
  const identity = { source: normalizeUpstream(source), path: clean, commit: commit.toLowerCase() };
  const key = createHash('sha256').update(JSON.stringify([identity.source, identity.path, identity.commit])).digest('hex').slice(0, 32);
  return { name, source, path: clean, ref: ref ?? null, commit: identity.commit, identity, key };
}
// Read-modify-write of context-kit.json under the config lock, replaced atomically.
// Just before the rename it checks that the config lock, and any lock the caller holds
// (guards), are still its own (else MOUNT_BUSY, nothing written), and that the file is
// unchanged since it was read; after the rename it reads the file back and checks that
// confirm(mounts) holds. A changed file or a missing change is re-applied, at most five
// times, then MOUNT_BUSY. This makes a lost-lock race very unlikely to lose a change, not
// impossible: two writers can still pass the checks together, and a later writer can
// overwrite after confirmation. Closing that needs a different lock mechanism.
const rawConfig = root => readFile(configPath(root), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
async function writeConfig(root, update, { confirm, guards = [] }) {
  await withLock(root, 'config', async held => {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 5) fail('MOUNT_BUSY', 'context-kit.json keeps changing under another command; try again');
      const text = await rawConfig(root);
      const config = text === null ? { version: 1, addons: await defaultAddons() } : JSON.parse(text);
      const problems = config.mounts === undefined ? [] : mountProblems(config.mounts);
      if (problems.length) fail('INVALID_CONFIG', `context-kit.json: ${problems.join('; ')}`);
      const mounts = update({ ...(config.mounts ?? {}) });
      const next = { ...config, mounts: Object.fromEntries(Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b))) };
      if (!Object.keys(next.mounts).length) delete next.mounts;
      const temporary = `${configPath(root)}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      try {
        for (const guard of [...guards, held]) await guard();
        if (await rawConfig(root) !== text) continue;
        await rename(temporary, configPath(root));
      } finally { await rm(temporary, { force: true }); }
      const written = await rawConfig(root);
      if (written !== null && confirm(JSON.parse(written).mounts ?? {})) return;
    }
  });
}
// A workspace without context-kit.json enables every addon; keep that when creating one.
async function defaultAddons() {
  const { loadAddons } = await import('./addons.mjs');
  return (await loadAddons(KIT_ROOT)).filter(addon => addon.name !== 'core').map(addon => addon.name);
}

// State lives under .state/mounts in the workspace. Every component from the workspace root
// must be a real directory, never a symlink, so nothing is written or deleted elsewhere.
// Missing components are created, or, with create false, the path is null.
async function stateDir(root, parts, { create = true } = {}) {
  let path = root;
  for (const part of ['.state', 'mounts', ...parts]) {
    path = join(path, part);
    let info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) {
      if (!create) return null;
      await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(path);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('PATH_ESCAPE', `${relative(root, path)} must be a directory inside the workspace, not a symlink`);
  }
  const offset = relative(await realpath(root), await realpath(path));
  if (!offset || offset === '..' || offset.startsWith('../') || isAbsolute(offset)) fail('PATH_ESCAPE', `${relative(root, path)} leaves the workspace`);
  return path;
}

// One holder per lock: a file created exclusively, holding the owner's pid and a token, and
// touched while held. A lock whose owner is gone, or untouched for an hour, is stale. Breakers
// take turns through a second exclusive file, and delete a stale lock only if it is still the
// one they judged stale, so a live lock is never removed.
const sleep = ms => new Promise(done => setTimeout(done, ms));
const LOCK_WAIT = 15 * 60 * 1000;
const LOCK_STALE = 60 * 60 * 1000;
const LOCK_TOUCH = 5 * 60 * 1000;
const BREAK_STALE = 10000;
async function readLock(path) {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile()) fail('PATH_ESCAPE', `${path} must be a regular lock file`);
  let data = {};
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch { /* Being written, or damaged. */ }
  return { ...data, mtime: info.mtimeMs, ino: info.ino };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const isStale = holder => {
  const age = Date.now() - Math.max(holder.at ?? 0, holder.mtime);
  return holder.token ? !alive(holder.pid) || age > LOCK_STALE : age > BREAK_STALE; // Unreadable: give its writer time.
};
const sameLock = (a, b) => a && b && a.token === b.token && a.ino === b.ino && a.mtime === b.mtime;
// Removes path when it is the stale lock observed; returns whether to retry at once.
async function breakStale(path, observed) {
  const breaker = `${path}.break`;
  const token = randomUUID();
  try { await writeFile(breaker, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const other = await readLock(breaker);
    // A breaker only reads and deletes; one held this long belongs to a process that stopped.
    if (other && Date.now() - other.mtime > BREAK_STALE && sameLock(await readLock(breaker), other)) await rm(breaker, { force: true });
    return false;
  }
  try {
    const current = await readLock(path);
    if (!current) return true;
    if (sameLock(current, observed) && isStale(current)) await rm(path, { force: true });
    return true;
  } finally {
    if ((await readLock(breaker).catch(() => null))?.token === token) await rm(breaker, { force: true });
  }
}
async function withLock(root, label, run) {
  const path = join(await stateDir(root, []), `.lock-${label}`);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT;
  for (;;) {
    try { await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const holder = await readLock(path);
    if (!holder || isStale(holder) && await breakStale(path, holder)) continue;
    if (Date.now() > deadline) fail('MOUNT_BUSY', `Another Context Kit command is changing ${label.replace(/^mount-/, 'mount ')}; try again when it finishes`);
    await sleep(50 + Math.random() * 100);
  }
  // Touch the lock while held, so a long run (or a sleeping machine) never looks abandoned.
  const touch = setInterval(async () => {
    if ((await readLock(path).catch(() => null))?.token === token) await utimes(path, new Date(), new Date()).catch(() => {});
  }, LOCK_TOUCH);
  touch.unref();
  // Before a write that matters, the holder checks the lock still holds its token: a takeover
  // it lost (a stale-lock race) then refuses with MOUNT_BUSY instead of writing alongside.
  const held = async () => {
    if ((await readLock(path).catch(() => null))?.token !== token) {
      fail('MOUNT_BUSY', `Another Context Kit command took over the ${label.replace(/^mount-/, 'mount ')} lock; nothing was changed, try again`);
    }
  };
  try { return await run(held); }
  finally {
    clearInterval(touch);
    if ((await readLock(path).catch(() => null))?.token === token) await rm(path, { force: true });
  }
}

// Git that contacts a source: the user's own configuration and credential helpers apply, but
// it never prompts, runs no hooks and stops in bounded time. Repository-location overrides
// from the environment are dropped, since every call names its repository.
const LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
  'GIT_NAMESPACE', 'GIT_TEMPLATE_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_QUARANTINE_PATH', 'GIT_SHALLOW_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_GRAFT_FILE', 'GIT_ASKPASS', 'SSH_ASKPASS'];
let remote;
const remoteEnv = () => remote ??= (async () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const name of LOCATION) delete env[name];
  env.GIT_ALLOW_PROTOCOL ??= 'file:git:http:https:ssh';
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return env;
  // SSH in batch mode, unless the user chose their own SSH command.
  const configured = await exec('git', ['config', '--get', 'core.sshCommand'], { env, timeout: 10000 }).then(({ stdout }) => stdout.trim(), () => '');
  return configured ? env : { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
})();
const remoteGit = async (args, timeout = 120000) =>
  (await exec('git', ['-c', 'core.askPass=', '-c', 'core.hooksPath=/dev/null', ...args], { env: await remoteEnv(), timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
// Git over the local cache only: no GIT_* from the environment, no system or global config,
// so no inherited filters, hooks, replacements or alternates.
function localEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}
const localGit = async (args, { maxBuffer = 16 * 1024 * 1024, timeout = 120000 } = {}) =>
  (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { env: localEnv(), timeout, maxBuffer, encoding: 'buffer' })).stdout;

// A git failure as a fixed category with the declared, credential-free source. Git's own
// messages are never passed on: rewritten URLs (insteadOf) or servers may put secrets there.
function gitFailure(mount, error, doing) {
  const text = String(error.stderr ?? '');
  const category = error.killed || error.signal ? 'timed out'
    : /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|error: 40[13]|\b40[13]\b/i.test(text) ? 'authentication failed (configure a git credential helper or SSH key for it)'
    : /does not appear to be a git repository|repository .*not found|error: 404|\b404\b|no such file or directory/i.test(text) ? 'repository not found'
    : /could not resolve|connection refused|timed out|network is unreachable|connection reset|unable to access|ssl|tls/i.test(text) ? 'network error'
    : /not our ref|unadvertised object|couldn't find remote ref|no such remote ref|upload-pack: not our ref/i.test(text) ? 'the ref or commit is not available there'
    : 'git failed';
  fail('FETCH_FAILED', `Mount ${mount.name}: ${doing} ${mount.source}: ${category}`);
}
// Our own coded failures pass through; anything else (file system, git internals) becomes a
// fixed message, so no raw command text or path reaches a result.
function safeError(mount, error) {
  const ours = typeof error.code === 'string' && /^[A-Z][A-Z_]+$/.test(error.code) && !error.code.startsWith('ERR_') && error.errno === undefined && !error.syscall;
  return ours ? error : Object.assign(new Error(`Mount ${mount.name}: could not prepare its content from ${mount.source}`), { code: 'FETCH_FAILED' });
}

// The commit a ref names at the source (an annotated tag peeled to its commit): its default
// branch when ref is null.
async function resolveRef(mount) {
  let output;
  try { output = await remoteGit(mount.ref ? ['ls-remote', '--', mount.source, mount.ref, `${mount.ref}^{}`] : ['ls-remote', '--symref', '--', mount.source, 'HEAD']); }
  catch (error) { gitFailure(mount, error, 'could not list'); }
  const lines = output.split('\n').filter(Boolean);
  if (!mount.ref) {
    const branch = lines.find(line => line.startsWith('ref: refs/heads/'))?.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/)?.[1];
    const commit = lines.find(line => /^[0-9a-f]{40}\tHEAD$/.test(line))?.slice(0, 40);
    if (!branch || !commit) fail('FETCH_FAILED', `Mount ${mount.name}: ${mount.source} has no default branch; pass --ref`);
    return { ref: branch, commit };
  }
  const refs = new Map(lines.map(line => line.split('\t')).filter(([sha]) => COMMIT.test(sha)).map(([sha, name]) => [name, sha]));
  for (const name of [`refs/heads/${mount.ref}`, `refs/tags/${mount.ref}^{}`, `refs/tags/${mount.ref}`, mount.ref]) {
    if (refs.has(name)) return { ref: mount.ref, commit: refs.get(name) };
  }
  fail('FETCH_FAILED', `Mount ${mount.name}: ${mount.source} has no branch or tag ${mount.ref}`);
}
// Brings exactly the pinned commit into the mount's bare cache, which only ever holds what its
// one source served. Fetch by SHA first; if the host refuses it, fetch the ref's history and
// use the commit only if it is there. The pin must name a commit, not a tag or tree.
async function fetchCommit(root, mount, held) {
  let cache = await stateDir(root, ['.git', mount.name]);
  const recorded = await localGit(['--git-dir', cache, 'config', '--get', 'context-kit.source']).then(String, () => null);
  if (recorded?.trim() !== mount.identity.source) {
    await held();
    await removeTree(cache);
    cache = await stateDir(root, ['.git', mount.name]);
    await localGit(['init', '--quiet', '--bare', '--template=', cache]);
    await localGit(['--git-dir', cache, 'config', 'context-kit.source', mount.identity.source]);
  }
  const base = ['--git-dir', cache, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules'];
  try { await remoteGit([...base, '--depth', '1', '--', mount.source, mount.commit], 600000); }
  catch (error) {
    if (!/not our ref|unadvertised object|couldn't find remote ref|no such remote ref|want .* not valid|server does not allow/i.test(String(error.stderr))) gitFailure(mount, error, 'could not fetch from');
    const shallow = String(await localGit(['--git-dir', cache, 'rev-parse', '--is-shallow-repository'])).trim() === 'true';
    try { await remoteGit([...base, ...(shallow ? ['--unshallow'] : []), '--', mount.source, mount.ref ?? 'HEAD'], 600000); }
    catch (fallback) { gitFailure(mount, fallback, 'could not fetch from'); }
  }
  const type = await localGit(['--git-dir', cache, 'cat-file', '-t', mount.commit]).then(output => String(output).trim(), () => null);
  if (type === null) fail('FETCH_FAILED', `Mount ${mount.name}: ${mount.source} does not have commit ${mount.commit}`);
  if (type !== 'commit') fail('FETCH_FAILED', `Mount ${mount.name}: ${mount.commit} is a ${type}, not a commit`);
  return cache;
}
// path must be a directory in the commit, reached without symlinks.
async function checkTreePath(cache, mount) {
  const parts = mount.path ? mount.path.split('/') : [];
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const entry = String(await localGit(['--git-dir', cache, 'ls-tree', '-z', mount.commit, '--', prefix])).split('\0')
      .map(line => line.match(/^(\d+) (\w+) [0-9a-f]+\t(.*)$/s)).find(match => match && match[3] === prefix);
    if (!entry) fail('NOT_A_HUB', `Mount ${mount.name}: ${mount.path} does not exist at ${mount.commit}`);
    if (entry[1] === '120000') fail('INVALID_PATH', `Mount ${mount.name}: ${prefix} is a symlink in the repository`);
    if (entry[2] !== 'tree') fail('NOT_A_HUB', `Mount ${mount.name}: ${mount.path} is not a directory at ${mount.commit}`);
  }
}

// Budgets for one mounted tree, checked from the tree listing before anything is written.
export const LIMITS = { entries: 10000, bytes: 64 * 1024 * 1024, file: 16 * 1024 * 1024, depth: 32, path: 1024 };
// The selected tree's regular files, and what is not exported (symlinks, submodules).
async function preflight(cache, mount) {
  const treeish = mount.path ? `${mount.commit}:${mount.path}` : mount.commit;
  let output;
  try { output = String(await localGit(['--git-dir', cache, 'ls-tree', '-r', '-z', '--long', treeish], { maxBuffer: 4 * 1024 * 1024 })); }
  catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail('TOO_LARGE', `Mount ${mount.name}: more than ${LIMITS.entries} entries`);
    throw error;
  }
  const records = output.split('\0').filter(Boolean);
  const tooLarge = what => fail('TOO_LARGE', `Mount ${mount.name}: ${what} (limits: ${LIMITS.entries} entries, ${LIMITS.bytes / 1048576} MiB in all, ${LIMITS.file / 1048576} MiB per file, depth ${LIMITS.depth})`);
  if (records.length > LIMITS.entries) tooLarge(`${records.length} entries`);
  const files = [];
  const skipped = [];
  let bytes = 0;
  for (const record of records) {
    const match = record.match(/^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t(.+)$/s);
    if (!match) fail('FETCH_FAILED', `Mount ${mount.name}: unreadable tree at ${mount.commit}`);
    const [, mode, type, sha, size, path] = match;
    const parts = path.split('/');
    if (path.length > LIMITS.path || parts.length > LIMITS.depth) tooLarge(`a path deeper or longer than allowed`);
    if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes('\0'))) {
      fail('FETCH_FAILED', `Mount ${mount.name}: the tree at ${mount.commit} has an unsafe path`);
    }
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) { skipped.push(path); continue; }
    const length = Number(size);
    if (length > LIMITS.file) tooLarge(`a file over ${LIMITS.file / 1048576} MiB`);
    bytes += length;
    if (bytes > LIMITS.bytes) tooLarge(`more than ${LIMITS.bytes / 1048576} MiB`);
    files.push({ path, sha, size: length, executable: mode === '100755' });
  }
  return { files, skipped };
}
// Raw blob bytes for the given objects, read with cat-file --batch: no filters, no checkout.
function readBlobs(cache, files) {
  return new Promise((resolveBlobs, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '--git-dir', cache, 'cat-file', '--batch'], { env: localEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => child.kill(), 600000);
    child.stdout.on('data', chunk => { chunks.push(chunk); length += chunk.length; if (length > LIMITS.bytes + files.length * 200 + 1024) child.kill(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('cat-file failed'));
      const buffer = Buffer.concat(chunks);
      const blobs = [];
      let offset = 0;
      for (const file of files) {
        const end = buffer.indexOf(10, offset);
        const header = end < 0 ? '' : buffer.subarray(offset, end).toString();
        if (header !== `${file.sha} blob ${file.size}`) return reject(new Error('unexpected cat-file output'));
        blobs.push(buffer.subarray(end + 1, end + 1 + file.size));
        offset = end + 1 + file.size + 1;
      }
      resolveBlobs(blobs);
    });
    child.stdin.end(files.map(file => file.sha).join('\n') + (files.length ? '\n' : ''));
  });
}

// Writable again, so content can be removed. Never follows a symlink.
async function thaw(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isDirectory()) return;
  await chmod(path, 0o755);
  for (const entry of await readdir(path)) await thaw(join(path, entry));
}
async function freeze(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) { for (const entry of await readdir(path)) await freeze(join(path, entry)); }
  await chmod(path, info.isDirectory() || info.mode & 0o100 ? 0o555 : 0o444);
}
const removeTree = async path => { await thaw(path); await rm(path, { recursive: true, force: true }); };

// A mount keeps the export its pin names and the one the previous pin named, so a read that
// loaded the old pin just before an upgrade can finish. Older exports are removed, under the
// mount's lock, only while it is still this command's.
async function previousKey(directory) {
  const file = join(directory, '.previous');
  if (!(await lstat(file).catch(() => null))?.isFile()) return null;
  const key = (await readFile(file, 'utf8').catch(() => '')).trim();
  return /^[0-9a-f]{32}$/.test(key) ? key : null;
}
async function rememberPrevious(directory, key) {
  const temporary = join(directory, `.previous.${randomUUID()}.tmp`);
  await writeFile(temporary, key + '\n', { flag: 'wx' });
  await rename(temporary, join(directory, '.previous')); // Replaces a file or symlink, never follows one.
}
async function collectExports(root, mount, held) {
  const directory = await stateDir(root, [mount.name], { create: false });
  if (!directory) return;
  const keep = new Set([mount.key, await previousKey(directory)]);
  await held();
  for (const item of await readdir(directory)) if (!item.startsWith('.') && !keep.has(item)) await removeTree(join(directory, item));
}

// Under the mount's lock: checks the tree's budgets, writes its regular files into a new
// temporary sibling (only ever real directories this creates, so no write can leave it),
// records its identity last and makes it read-only. The caller switches it in or drops it.
async function prepareExport(root, cache, mount) {
  const { files, skipped } = await preflight(cache, mount);
  const directory = await stateDir(root, [mount.name]);
  // Temporaries left by an earlier run are abandoned: only the lock holder creates them.
  for (const entry of await readdir(directory)) if (entry.startsWith('.tmp-')) await removeTree(join(directory, entry));
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  try {
    await mkdir(temporary);
    const blobs = await readBlobs(cache, files);
    for (const [index, file] of files.entries()) {
      const target = join(temporary, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, blobs[index], { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
    }
    const check = await inspectHub(temporary, mount, skipped);
    await rm(join(temporary, '.mount.json'), { force: true });
    await writeFile(join(temporary, '.mount.json'), JSON.stringify({ version: 1, ...mount.identity, skipped: skipped.slice(0, 100) }, null, 2) + '\n', { flag: 'wx' });
    await freeze(temporary);
    return { directory, temporary, check };
  } catch (error) {
    await removeTree(temporary);
    throw error;
  }
}
// Renames a prepared export into place, only while this command still holds the mount's lock.
async function switchIn(root, { directory, temporary }, mount, held) {
  // The state directory must still be the real one this export was prepared in.
  if (await stateDir(root, [mount.name], { create: false }) !== directory) fail('PATH_ESCAPE', `${relative(root, directory)} changed during the export`);
  const destination = join(directory, mount.key);
  const existing = await lstat(destination).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) fail('PATH_ESCAPE', `${relative(root, destination)} must be a directory, not a symlink`);
  await held();
  if (existing) await removeTree(destination); // An incomplete export never matched its descriptor.
  await rename(temporary, destination);
}
async function exportCommit(root, cache, mount, held) {
  const prepared = await prepareExport(root, cache, mount);
  try {
    await switchIn(root, prepared, mount, held);
    return prepared.check;
  } finally {
    await removeTree(prepared.temporary);
  }
}

// Whether a directory holds a loadable hub, read exactly as reads load it (loadMountedHub),
// with its manifest id and concepts per OKF trust tier, and the hub itself.
async function inspectHub(directory, mount, skipped) {
  let hub;
  try { hub = await loadMountedHub(directory, mount, skipped); }
  catch (error) { return { ok: false, reason: error.code === 'MOUNT_BROKEN' ? error.message : 'the fetched content could not be read', manifestId: null, trust: null }; }
  const trust = Object.fromEntries(TIERS.map(tier => [tier, 0]));
  for (const [path, data] of hub.concepts) if (!path.startsWith('inbox/')) trust[summarize(data).summary.trust]++;
  return { ok: true, manifestId: hub.manifestId, trust, hub };
}
// fetched when the export for this exact source, path and commit is present; broken when
// that export is not a loadable hub, or the state path is unsafe; unfetched otherwise.
// A fetched mount carries its loaded hub.
async function status(root, mount) {
  const unfetched = { status: 'unfetched', reason: `not fetched at this source, path and commit; run mounts fetch ${mount.name}`, manifestId: null, trust: null };
  let parent;
  try { parent = await stateDir(root, [mount.name], { create: false }); }
  catch (error) { return { status: 'broken', reason: error.code === 'PATH_ESCAPE' ? error.message : 'its fetched state could not be read', manifestId: null, trust: null, unsafe: true }; }
  if (!parent) return unfetched;
  const directory = join(parent, mount.key);
  const info = await lstat(directory).catch(() => null);
  const file = info?.isDirectory() && !info.isSymbolicLink() ? await lstat(join(directory, '.mount.json')).catch(() => null) : null;
  let descriptor = null;
  if (file?.isFile()) { try { descriptor = JSON.parse(await readText(join(directory, '.mount.json'))); } catch { descriptor = null; } }
  const matches = descriptor && ['source', 'path', 'commit'].every(field => descriptor[field] === mount.identity[field]);
  if (!matches) return unfetched;
  const skipped = Array.isArray(descriptor.skipped) ? descriptor.skipped.filter(path => typeof path === 'string').slice(0, 100) : [];
  const { ok, reason, hub, ...check } = await inspectHub(directory, mount, skipped);
  if (ok) return { status: 'fetched', ...check, hub };
  // Content removed while it was read is another command switching exports, not a broken hub.
  if (!(await lstat(join(directory, '.mount.json')).catch(() => null))?.isFile()) {
    return { status: 'unfetched', reason: 'its fetched content was being replaced by another command; try again', manifestId: null, trust: null, transient: true };
  }
  return { status: 'broken', reason, ...check };
}
const view = async (root, mount) => {
  const { hub, unsafe, transient, ...state } = await status(root, mount);
  return { name: mount.name, source: mount.source, path: mount.path, ref: mount.ref, commit: mount.commit, ...state };
};

export async function listMounts(root) {
  const mounts = [];
  for (const mount of await declared(root)) mounts.push(await view(root, mount));
  return { root, mounts };
}

// Every declared mount, by name, with its status and, when fetched, its loaded hub. Reads use
// only what is fetched; nothing here contacts a source.
// A mount that did not load while an upgrade moved its pin is loaded once more at the new pin.
export async function loadMounts(root) {
  for (let attempt = 0; ; attempt++) {
    const stamp = await declarationStamp(root);
    const mounts = [];
    for (const mount of await declared(root)) {
      let state;
      try { state = await status(root, mount); }
      catch { state = { status: 'broken', reason: 'its fetched content could not be read' }; }
      mounts.push({ name: mount.name, status: state.status, reason: state.reason ?? null, unsafe: Boolean(state.unsafe), transient: Boolean(state.transient), hub: state.hub ?? null });
    }
    if (attempt > 0 || mounts.every(mount => mount.status === 'fetched') || await declarationStamp(root) === stamp) return mounts;
  }
}
// The declaration as written, to tell whether a pin moved during a read.
export const declarationStamp = root => rawConfig(root).catch(() => null);
// The coded failure for addressing a mount that is not loaded, with the remedy.
export function unavailable(mount) {
  if (mount.transient) fail('MOUNT_BUSY', `Mount ${mount.name} was being switched to another commit by another command while it was read; try again`);
  if (mount.status === 'unfetched') fail('MOUNT_NOT_FETCHED', `Mount ${mount.name} is not fetched on this machine at its pinned source, path and commit; run mounts fetch ${mount.name}`);
  const remedy = mount.unsafe ? 'replace the symlinked path under .state with a real directory' : `pin a commit whose content is a hub, or run mounts remove ${mount.name}`;
  fail('MOUNT_BROKEN', `Mount ${mount.name} is broken: ${mount.reason}; ${remedy}`);
}
// A warning for each declared mount that is not loaded, naming its remedy.
export const mountWarnings = mounts => mounts.filter(mount => mount.status !== 'fetched')
  .map(mount => `mount ${mount.name} is ${mount.status}: ${mount.reason}`);
// Writes resolve their hub first; a mount, fetched or not, is read-only.
// A name a workspace hub also has is MOUNT_EXISTS, as validate says.
export async function refuseMountWrite(root, id) {
  if ((await declared(root)).some(mount => mount.name === id)) {
    if ((await hubIds(root).catch(() => new Set())).has(id)) {
      fail('MOUNT_EXISTS', `A mount and a workspace hub are both called ${id}; run mounts remove ${id}, then mounts add it under another name`);
    }
    fail('READ_ONLY_MOUNT', `${id} is a mount, which is read-only here; change it in its own repository, then move the pin`);
  }
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
// Fails before any change when a mount's state or cache path holds a symlink.
async function checkState(root, name) {
  await stateDir(root, [name], { create: false });
  await stateDir(root, ['.git', name], { create: false });
}
// Removes a mount's exports and cache, after checking their paths stay in the workspace.
async function removeState(root, name) {
  const exports = await stateDir(root, [name], { create: false });
  if (exports) await removeTree(exports);
  const cache = await stateDir(root, ['.git', name], { create: false });
  if (cache) await removeTree(cache);
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
  const taken = async () => {
    if ((await declared(root)).some(mount => mount.name === name)) fail('MOUNT_EXISTS', `A mount is already called ${name}`);
    if ((await hubIds(root)).has(name)) fail('MOUNT_EXISTS', `A workspace hub is already called ${name}`);
  };
  await taken();
  const pending = { name, source: source.trim(), ref: ref ?? null, path: clean };
  await checkState(root, name);
  return withLock(root, `mount-${name}`, async held => {
    await taken();
    await checkState(root, name);
    const resolved = await resolveRef(pending);
    const mount = describe(name, { source: pending.source, path: clean, ref: resolved.ref, commit: resolved.commit });
    try {
      const cache = await fetchCommit(root, mount, held);
      await checkTreePath(cache, mount);
      const check = await exportCommit(root, cache, mount, held);
      if (!check.ok) fail('NOT_A_HUB', `Mount ${name}: ${mount.path || 'the repository root'} at ${mount.commit} is not a hub: ${check.reason}`);
      const entry = { source: mount.source, ...(mount.path ? { path: mount.path } : {}), ref: mount.ref, commit: mount.commit };
      let ours = false; // A re-applied update finds our own entry already there.
      await writeConfig(root, mounts => {
        if (Object.hasOwn(mounts, name) && !(ours && JSON.stringify(mounts[name]) === JSON.stringify(entry))) fail('MOUNT_EXISTS', `A mount is already called ${name}`);
        ours = true;
        return { ...mounts, [name]: entry };
      }, { guards: [held], confirm: mounts => JSON.stringify(mounts[name]) === JSON.stringify(entry) });
    } catch (error) {
      // Clean up only while the mount's lock is still ours.
      if (error.code !== 'PATH_ESCAPE') await held().then(() => removeState(root, name)).catch(() => {});
      throw safeError(mount, error);
    }
    return { root, mount: await view(root, mount) };
  });
}

// Fetches each mount (or one) at its pin, each under its own lock. A failure is reported
// for that mount, which keeps whatever it had, and the others still fetch.
export async function fetchMounts(selection, { name } = {}) {
  const { root } = selection;
  await writableWorkspace(selection);
  const all = await declared(root);
  const chosen = name === undefined ? all : all.filter(mount => mount.name === name);
  if (name !== undefined && !chosen.length) fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
  const mounts = [];
  const failed = [];
  for (let mount of chosen) {
    try {
      const outcome = await withLock(root, `mount-${mount.name}`, async held => {
        await checkState(root, mount.name);
        // The pin as it is under the lock: an upgrade or remove may have finished meanwhile.
        const { name: wanted } = mount;
        mount = (await declared(root)).find(item => item.name === wanted) ?? fail('UNKNOWN_MOUNT', `No mount is called ${wanted} any more (run mounts to list them)`);
        if ((await status(root, mount)).status !== 'unfetched') { await collectExports(root, mount, held); return 'unchanged'; }
        const cache = await fetchCommit(root, mount, held);
        await checkTreePath(cache, mount);
        await exportCommit(root, cache, mount, held);
        await collectExports(root, mount, held);
        return 'fetched';
      });
      mounts.push({ ...await view(root, mount), outcome });
    } catch (error) {
      failed.push(mount.name);
      mounts.push({ ...await view(root, mount), outcome: 'failed', error: { code: ['MOUNT_BUSY', 'UNKNOWN_MOUNT'].includes(error.code) ? error.code : 'FETCH_FAILED', message: safeError(mount, error).message } });
    }
  }
  return { root, mounts, failed };
}

export async function removeMount(selection, { name }) {
  const { root } = selection;
  await writableWorkspace(selection);
  if (!(await declared(root)).some(item => item.name === name)) fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
  return withLock(root, `mount-${name}`, async held => {
    await checkState(root, name); // Before changing anything.
    let removed = false; // A re-applied update finds it already gone.
    await writeConfig(root, mounts => {
      if (!Object.hasOwn(mounts, name) && !removed) fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
      removed = true;
      delete mounts[name];
      return mounts;
    }, { guards: [held], confirm: mounts => !Object.hasOwn(mounts, name) });
    try { await held(); }
    catch (error) {
      // The declaration is gone; only the fetched content is left, and it is never served
      // without one. Say exactly that rather than "nothing was changed".
      error.message = `Removed the declaration of ${name}, but another command took over its lock, so its fetched content in .state/mounts/${name} was left; delete it by hand if no command is using it`;
      throw error;
    }
    await removeState(root, name);
    return { root, removed: name };
  });
}

// What moves between two loaded commits of one mount: concepts (inbox excluded) added,
// removed or changed by their bytes, and Repository concepts added, removed or changed,
// matched by upstream. Every entry is a concept reference.
async function conceptDigests(hub) {
  const digests = new Map();
  for (const path of [...hub.concepts.keys()].filter(path => !path.startsWith('inbox/'))) {
    digests.set(conceptRef(hub, path), createHash('sha256').update(await readFile(await hubFile(hub, path))).digest('hex'));
  }
  return digests;
}
const repositoriesOf = hub => new Map(registry([hub]).repositories.map(repository =>
  [repository.key, { ref: `${hub.manifest.id}:/${repository.concept}`, title: repository.title, upstream: repository.upstream }]));
const byRef = (a, b) => a.ref.localeCompare(b.ref);
async function changesBetween(before, after) {
  const [old, next] = [await conceptDigests(before), await conceptDigests(after)];
  const concepts = {
    added: [...next.keys()].filter(ref => !old.has(ref)).sort(),
    removed: [...old.keys()].filter(ref => !next.has(ref)).sort(),
    changed: [...next.keys()].filter(ref => old.has(ref) && old.get(ref) !== next.get(ref)).sort(),
  };
  const [was, now] = [repositoriesOf(before), repositoriesOf(after)];
  const repositories = {
    added: [...now].filter(([key]) => !was.has(key)).map(([, repository]) => repository).sort(byRef),
    removed: [...was].filter(([key]) => !now.has(key)).map(([, repository]) => repository).sort(byRef),
    changed: [...now].filter(([key, repository]) => was.has(key) && (JSON.stringify(was.get(key)) !== JSON.stringify(repository) || concepts.changed.includes(repository.ref)))
      .map(([, repository]) => repository).sort(byRef),
  };
  return { concepts, repositories };
}
const nothingChanged = () => ({ concepts: { added: [], removed: [], changed: [] }, repositories: { added: [], removed: [], changed: [] } });

// Moves a mount's pin, only on request: to the commit its ref (or --to's ref or commit) names
// now. Under the mount's lock it fetches that exact commit, prepares and checks its export
// aside, then, unless check, switches the export in and rewrites the pin atomically. Any
// failure keeps the old pin and content. A branch tip is never used in place of a commit.
export async function upgradeMount(selection, { name, to, check = false }) {
  const { root } = selection;
  await writableWorkspace(selection);
  const commitTarget = typeof to === 'string' && /^[0-9a-f]{40}$/i.test(to);
  if (to !== undefined && !commitTarget && !REF.test(to)) fail('INVALID_INPUT', `Mount ${name}: --to must be a full 40-hex commit, or a branch or tag name`);
  const find = async () => (await declared(root)).find(mount => mount.name === name) ?? fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
  await find();
  await checkState(root, name);
  return withLock(root, `mount-${name}`, async held => {
    await checkState(root, name);
    // The pin as it is now, under the lock, and the entry as written, to detect a change under us.
    const current = await find();
    const entry = (await readConfig(root))?.mounts?.[name];
    if (!entry || mountProblems({ [name]: entry }).length || describe(name, entry).key !== current.key || (entry.ref ?? null) !== current.ref) {
      fail('MOUNT_BUSY', `The declaration of ${name} in context-kit.json changed while the upgrade started; nothing was changed, run mounts upgrade ${name} again`);
    }
    const ref = commitTarget ? current.ref : to ?? current.ref;
    let target;
    try { target = commitTarget ? to.toLowerCase() : (await resolveRef({ ...current, ref })).commit; }
    catch (error) { throw safeError(current, error); }
    const candidate = describe(name, { source: current.source, path: current.path, ref: ref ?? undefined, commit: target });
    const before = await status(root, current);
    const report = { from: { commit: current.commit, ref: current.ref, status: before.status }, to: { commit: candidate.commit, ref: candidate.ref } };
    if (candidate.commit === current.commit && candidate.ref === current.ref) {
      return { root, mount: await view(root, current), outcome: 'current', ...report, changes: nothingChanged() };
    }
    let prepared = null;
    let switched = false;
    try {
      const cache = await fetchCommit(root, candidate, held);
      // The declaration is fine; the candidate's content is what fails to be a hub.
      try { await checkTreePath(cache, candidate); }
      catch (error) { if (['NOT_A_HUB', 'INVALID_PATH'].includes(error.code)) fail('MOUNT_BROKEN', `${error.message}; the pin stays at ${current.commit}`); throw error; }
      prepared = await prepareExport(root, cache, candidate);
      if (!prepared.check.ok) fail('MOUNT_BROKEN', `Mount ${name}: ${candidate.commit} is not a loadable hub: ${prepared.check.reason}; the pin stays at ${current.commit}`);
      report.to.manifestId = prepared.check.manifestId;
      if (before.hub) report.changes = await changesBetween(before.hub, prepared.check.hub);
      else {
        report.changes = null;
        report.baseline = `the pinned commit is ${before.status} on this machine, so there is nothing to compare with; run mounts fetch ${name} first for a change report`;
      }
      if (check) return { root, mount: await view(root, current), outcome: candidate.commit === current.commit ? 'current' : 'available', ...report };

      // A complete export of the candidate already here (the previous pin's, or the pin's own
      // when only the ref moves) is used as it is, never replaced under a reader.
      if ((await status(root, candidate)).status !== 'fetched') {
        await switchIn(root, prepared, candidate, held);
        switched = candidate.key !== current.key;
      }
      const next = { ...entry, ...(candidate.ref === null ? {} : { ref: candidate.ref }), commit: candidate.commit };
      let ours = false; // A re-applied update finds our own entry already there.
      await writeConfig(root, mounts => {
        const now = JSON.stringify(mounts[name]);
        if (now !== JSON.stringify(entry) && !(ours && now === JSON.stringify(next))) {
          fail('MOUNT_BUSY', `The declaration of ${name} in context-kit.json changed during the upgrade; its pin was not moved, run mounts upgrade ${name} again`);
        }
        ours = true;
        return { ...mounts, [name]: next };
      }, { guards: [held], confirm: mounts => JSON.stringify(mounts[name]) === JSON.stringify(next) });
    } catch (error) {
      // A switched-in export the pin does not name is never served; drop it while the lock is ours.
      if (switched && error.code !== 'PATH_ESCAPE') {
        await held().then(async () => {
          if ((await declared(root)).find(mount => mount.name === name)?.commit !== candidate.commit) await removeTree(join(prepared.directory, candidate.key));
        }).catch(() => {});
      }
      throw safeError(candidate, error);
    } finally {
      if (prepared) await removeTree(prepared.temporary);
    }
    // The old pin's export stays, as the previous one; older ones go. Left alone if the lock was lost.
    try {
      if (candidate.key !== current.key) { await held(); await rememberPrevious(prepared.directory, current.key); }
      await collectExports(root, candidate, held);
    } catch { /* Unserved content; the next upgrade, fetch or remove clears it. */ }
    return { root, mount: await view(root, candidate), outcome: 'upgraded', ...report };
  });
}
