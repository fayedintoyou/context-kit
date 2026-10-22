// Mounts: hubs from other git repositories, declared in the workspace's tracked
// context-kit.json at a pinned commit and fetched per machine into untracked
// .state/mounts/<name>/<key>/, a read-only export keyed by source, path and commit.
// Only add and fetch reach a source; nothing here moves a pin implicitly.
import { chmod, link, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
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
// Read-modify-write of context-kit.json under the config lock, replaced atomically.
async function writeConfig(root, update) {
  await withLock(root, 'config', async () => {
    const config = await readConfig(root) ?? { version: 1, addons: await defaultAddons() };
    const problems = config.mounts === undefined ? [] : mountProblems(config.mounts);
    if (problems.length) fail('INVALID_CONFIG', `context-kit.json: ${problems.join('; ')}`);
    const mounts = update({ ...(config.mounts ?? {}) });
    const next = { ...config, mounts: Object.fromEntries(Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b))) };
    if (!Object.keys(next.mounts).length) delete next.mounts;
    const temporary = `${configPath(root)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, configPath(root));
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

// One holder per lock: a file created exclusively, holding the owner's pid and a token. A
// lock whose owner is gone, or older than an hour, is stale and taken over.
const sleep = ms => new Promise(done => setTimeout(done, ms));
const LOCK_WAIT = 15 * 60 * 1000;
async function readLock(path) {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile()) fail('PATH_ESCAPE', `${path} must be a regular lock file`);
  try { return { ...JSON.parse(await readFile(path, 'utf8')), mtime: info.mtimeMs }; } catch { return { mtime: info.mtimeMs }; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function breakStale(path) {
  const holder = await readLock(path);
  if (!holder) return true;
  const age = Date.now() - (holder.at ?? holder.mtime);
  const stale = holder.token ? !alive(holder.pid) || age > 60 * 60 * 1000 : age > 10000; // Unreadable: give its writer 10 s.
  if (!stale) return false;
  const aside = `${path}.stale-${randomUUID()}`;
  try { await rename(path, aside); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  // Another process may have broken it first and taken it; give that lock back.
  const moved = await readLock(aside);
  if (moved?.token !== holder.token) await link(aside, path).catch(() => {});
  await rm(aside, { force: true });
  return true;
}
async function withLock(root, label, run) {
  const path = join(await stateDir(root, []), `.lock-${label}`);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT;
  for (;;) {
    try { await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (await breakStale(path)) continue;
    if (Date.now() > deadline) fail('MOUNT_BUSY', `Another Context Kit command is changing ${label.replace(/^mount-/, 'mount ')}; try again when it finishes`);
    await sleep(50 + Math.random() * 100);
  }
  try { return await run(); }
  finally { if ((await readLock(path).catch(() => null))?.token === token) await rm(path, { force: true }); }
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
async function fetchCommit(root, mount) {
  let cache = await stateDir(root, ['.git', mount.name]);
  const recorded = await localGit(['--git-dir', cache, 'config', '--get', 'context-kit.source']).then(String, () => null);
  if (recorded?.trim() !== mount.identity.source) {
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

// Under the mount's lock: checks the tree's budgets, writes its regular files into a new
// temporary sibling (only ever real directories this creates, so no write can leave it),
// records its identity last, makes it read-only and renames it into place.
async function exportCommit(root, cache, mount) {
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
    const check = await inspectHub(temporary);
    await rm(join(temporary, '.mount.json'), { force: true });
    await writeFile(join(temporary, '.mount.json'), JSON.stringify({ version: 1, ...mount.identity, skipped: skipped.slice(0, 100) }, null, 2) + '\n', { flag: 'wx' });
    await freeze(temporary);
    const destination = join(directory, mount.key);
    const existing = await lstat(destination).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) fail('PATH_ESCAPE', `${relative(root, destination)} must be a directory, not a symlink`);
    if (existing) await removeTree(destination); // An incomplete export never matched its descriptor.
    await rename(temporary, destination);
    return check;
  } finally {
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
  try { manifest = JSON.parse(await readText(manifestFile)); } catch { return broken('hub.json is not valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1 || typeof manifest.id !== 'string' ||
      !Array.isArray(manifest.documents) || !manifest.documents.length || manifest.documents.some(item => typeof item !== 'string')) {
    return broken('hub.json is not a hub manifest');
  }
  let concepts;
  try { concepts = await conceptsIn(directory); } catch (error) { return broken(error.code === 'TOO_LARGE' ? error.message : 'the bundle could not be read'); }
  for (const document of manifest.documents) {
    if (!concepts.has(document)) return broken(`${document.slice(0, 200)}: curated document is not an OKF concept (a regular Markdown file with a type)`);
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
      if (++entries > LIMITS.entries + 1) fail('TOO_LARGE', `Mounted bundle exceeds ${LIMITS.entries} entries`);
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
// that export is not a loadable hub, or the state path is unsafe; unfetched otherwise.
async function status(root, mount) {
  const unfetched = { status: 'unfetched', reason: `not fetched at this source, path and commit; run mounts fetch ${mount.name}`, manifestId: null, trust: null };
  let parent;
  try { parent = await stateDir(root, [mount.name], { create: false }); }
  catch (error) { return { status: 'broken', reason: error.message, manifestId: null, trust: null }; }
  if (!parent) return unfetched;
  const directory = join(parent, mount.key);
  const info = await lstat(directory).catch(() => null);
  const file = info?.isDirectory() && !info.isSymbolicLink() ? await lstat(join(directory, '.mount.json')).catch(() => null) : null;
  let descriptor = null;
  if (file?.isFile()) { try { descriptor = JSON.parse(await readText(join(directory, '.mount.json'))); } catch { descriptor = null; } }
  const matches = descriptor && ['source', 'path', 'commit'].every(field => descriptor[field] === mount.identity[field]);
  if (!matches) return unfetched;
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
  return withLock(root, `mount-${name}`, async () => {
    await taken();
    await checkState(root, name);
    const resolved = await resolveRef(pending);
    const mount = describe(name, { source: pending.source, path: clean, ref: resolved.ref, commit: resolved.commit });
    try {
      const cache = await fetchCommit(root, mount);
      await checkTreePath(cache, mount);
      const check = await exportCommit(root, cache, mount);
      if (!check.ok) fail('NOT_A_HUB', `Mount ${name}: ${mount.path || 'the repository root'} at ${mount.commit} is not a hub: ${check.reason}`);
      await writeConfig(root, mounts => {
        if (Object.hasOwn(mounts, name)) fail('MOUNT_EXISTS', `A mount is already called ${name}`);
        return { ...mounts, [name]: { source: mount.source, ...(mount.path ? { path: mount.path } : {}), ref: mount.ref, commit: mount.commit } };
      });
    } catch (error) {
      if (error.code !== 'PATH_ESCAPE') await removeState(root, name).catch(() => {});
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
  for (const mount of chosen) {
    try {
      const outcome = await withLock(root, `mount-${mount.name}`, async () => {
        await checkState(root, mount.name);
        if ((await status(root, mount)).status !== 'unfetched') return 'unchanged';
        const cache = await fetchCommit(root, mount);
        await checkTreePath(cache, mount);
        await exportCommit(root, cache, mount);
        return 'fetched';
      });
      mounts.push({ ...await view(root, mount), outcome });
    } catch (error) {
      failed.push(mount.name);
      mounts.push({ ...await view(root, mount), outcome: 'failed', error: { code: 'FETCH_FAILED', message: safeError(mount, error).message } });
    }
  }
  return { root, mounts, failed };
}

export async function removeMount(selection, { name }) {
  const { root } = selection;
  await writableWorkspace(selection);
  if (!(await declared(root)).some(item => item.name === name)) fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
  return withLock(root, `mount-${name}`, async () => {
    await checkState(root, name); // Before changing anything.
    await writeConfig(root, mounts => {
      if (!Object.hasOwn(mounts, name)) fail('UNKNOWN_MOUNT', `No mount is called ${name} (run mounts to list them)`);
      delete mounts[name];
      return mounts;
    });
    await removeState(root, name);
    return { root, removed: name };
  });
}
