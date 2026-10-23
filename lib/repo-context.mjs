// Opening a repository: resolve a name to this machine's checkout in one read-only call and hand
// over its instruction files and a bounded default bootstrap (a tree of tracked paths).
//
// Safety: git is read only from the index (`ls-files -z --stage`) and `rev-parse`, never with a
// command that compares or converts working-tree content, with every GIT_* variable removed and
// global and system config, hooks and fsmonitor off. Working-tree files are read and hashed here,
// after a per-component walk from the checkout's real root that refuses any symlink below it.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { listRepositories, findRepository, remedies } from './repos.mjs';
import { fail } from './files.mjs';

const exec = promisify(execFile);
// The whole open result, as compact JSON (JSON.stringify without spacing), in bytes: about 2k tokens.
export const OPEN_BUDGET = 8192;
export const TREE_DEPTH = 2;
export const TREE_ENTRIES = 150;
export const SUBPATH_MAX = 200;
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];

// The environment every git call here runs with: no GIT_* variable from the caller (a hook's
// GIT_DIR, injected GIT_CONFIG_* settings), and no global or system config.
export function sealedEnvironment(env = process.env) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}
const SEAL = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false'];
// Only these read neither working-tree content nor the network, and never refresh the index.
const READS = new Set(['rev-parse', 'ls-files']);
async function sealedGit(directory, args, { maxBuffer = 1024 * 1024 } = {}) {
  if (!READS.has(args[0])) throw new Error(`sealedGit runs only ${[...READS].join(' and ')}`);
  const { stdout } = await exec('git', ['-C', directory, ...SEAL, ...args], { env: sealedEnvironment(), timeout: 60000, maxBuffer, encoding: 'buffer' });
  return stdout;
}

// Byte order of UTF-8 is code-point order.
const byCodePoint = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const within = (parent, path) => { const offset = relative(parent, path); return offset === '' || (offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset)); };

// A subpath as given: '' for the root; otherwise relative, '/'-separated, no empty, `.`, `..` or
// `.git` segment, backslash, NUL or leading `/`. One trailing `/` is allowed and dropped.
function subpathOf(given) {
  if (given === undefined || given === '' || given === '.') return '';
  const text = given.endsWith('/') && given.length > 1 ? given.slice(0, -1) : given;
  const bad = reason => fail('INVALID_PATH', `${JSON.stringify(given)} is not a path inside the checkout: ${reason}`);
  if ([...text].length > SUBPATH_MAX) bad(`over ${SUBPATH_MAX} characters`);
  if (text.startsWith('/')) bad('it is absolute');
  if (/[\\\0]/.test(text)) bad('it holds a backslash or NUL');
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') bad('it has an empty, . or .. segment');
    if (segment.toLowerCase() === '.git') bad('it enters .git');
  }
  return text;
}

// Walks a relative path from the checkout's real root, lstat-ing each component. A symlink at
// any component stops it (escape); so does a missing component or a non-directory on the way.
async function walk(top, path) {
  let current = top;
  let info = await lstat(top);
  const parts = path ? path.split('/') : [];
  for (const [at, part] of parts.entries()) {
    if (!info.isDirectory()) return { missing: true };
    current = join(current, part);
    try { info = await lstat(current); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { missing: true }; throw error; }
    if (info.isSymbolicLink()) return { escape: parts.slice(0, at + 1).join('/') };
  }
  // Belt and braces: with no symlink on the way the real path is the walked one.
  const real = await realpath(current);
  if (!within(top, real)) return { escape: path };
  return { path: current, info };
}

// One instruction file, read and hashed only when it is a regular file reached without symlinks:
// opened with O_NOFOLLOW (and O_NONBLOCK, so a FIFO swapped in can't block), then checked to be
// the very file lstat saw.
async function pointer(top, path, tracked) {
  const where = await walk(top, path);
  if (where.missing) return null;
  if (where.escape) return { warning: `${path}: a symlink, not read` };
  if (!where.info.isFile()) return null;
  let handle;
  try { handle = await open(where.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ELOOP') return { warning: `${path}: a symlink, not read` }; return { warning: `${path}: could not be read (${error.code ?? 'error'})` }; }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== where.info.ino || opened.dev !== where.info.dev) return { warning: `${path}: changed while it was read, skipped` };
    const hash = createHash('sha256');
    let size = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { path, size, sha256: hash.digest('hex'), tracked };
  } finally { await handle.close(); }
}

// Tracked paths from the index, deduplicated (conflict stages repeat a path), in code-point order.
async function trackedPaths(top) {
  const output = (await sealedGit(top, ['ls-files', '-z', '--stage'], { maxBuffer: 256 * 1024 * 1024 })).toString('utf8');
  const paths = new Set();
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab >= 0) paths.add(record.slice(tab + 1));
  }
  return [...paths].sort(byCodePoint);
}

// The default tree under base ('' or a subpath): paths at depth 1 and 2 below it, directories
// ending in `/` with their tracked-file counts, nothing deeper; every entry, in code-point order.
function fullTree(paths, base) {
  const prefix = base ? `${base}/` : '';
  const files = new Set();
  const counts = new Map();
  let total = 0;
  const count = directory => counts.set(directory, (counts.get(directory) ?? 0) + 1);
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    total++;
    const parts = path.slice(prefix.length).split('/');
    if (parts.length === 1) { files.add(path); continue; }
    count(`${prefix}${parts[0]}/`);
    if (parts.length === TREE_DEPTH) files.add(path);
    else count(`${prefix}${parts[0]}/${parts[1]}/`);
  }
  return { total, entries: [...files, ...counts.keys()].sort(byCodePoint), counts };
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Opens a registered repository by id, title, alias or upstream name, ignoring the caller's
// working directory. Never clones, records or searches: an unrecorded or stale checkout is a
// successful `missing` result with the exact next commands.
export async function openRepository(root, name, subpath) {
  const path = subpathOf(subpath);
  const { repositories } = await listRepositories(root);
  const { repository, matched } = findRepository(repositories, name);
  const head = (status, recorded) => ({
    root, status,
    repository: { id: repository.id, title: repository.title, aliases: repository.aliases, hub: repository.hub, concept: repository.concept },
    resolution: { name, matched, concept: repository.id, alternateIds: repository.alternateIds ?? [], upstream: repository.upstream, path: recorded, source: 'machine' },
    path,
  });
  const missing = reason => ({ ...head('missing', null),
    reason, next: remedies(repository.id), instructions: [], tree: null, truncated: null, warnings: [] });
  if (!repository.path) return missing(repository.recorded ? `the recorded checkout ${repository.recorded} no longer exists` : 'no checkout is recorded on this machine');
  let top;
  try { top = await realpath(repository.path); } catch { return missing(`the recorded checkout ${repository.path} no longer exists`); }
  let shown;
  try { shown = await realpath((await sealedGit(top, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\n$/, '')); }
  catch { shown = null; }
  if (shown !== top) return missing(`the recorded checkout ${repository.path} is no longer the top of a git checkout`);

  const target = await walk(top, path);
  if (target.missing || (target.info && !target.info.isDirectory())) fail('UNKNOWN_PATH', `${path} is not a directory in the checkout of ${repository.id}`);
  if (target.escape) fail('PATH_ESCAPE', `${path} leaves the checkout of ${repository.id}: ${target.escape} is a symlink`);

  const paths = await trackedPaths(top);
  const tracked = new Set(paths);
  const warnings = [];
  const instructions = [];
  // Root, then each directory down to the subpath, outermost first; exact names only.
  const segments = path ? path.split('/') : [];
  for (let depth = 0; depth <= segments.length; depth++) {
    const directory = segments.slice(0, depth).join('/');
    const names = new Set(await readdir(join(top, directory)).catch(() => []));
    for (const file of INSTRUCTION_FILES) {
      if (!names.has(file)) continue;
      const relativePath = directory ? `${directory}/${file}` : file;
      const found = await pointer(top, relativePath, tracked.has(relativePath));
      if (found?.warning) warnings.push(found.warning);
      else if (found) instructions.push(found);
    }
  }

  const tree = fullTree(paths, path);
  const located = head('located', repository.path);
  // The result with the first `shown` tree entries and the first `kept` instruction pointers.
  const build = (shown, kept = instructions.length) => {
    const entries = tree.entries.slice(0, shown);
    const omitted = tree.entries.length - entries.length;
    const dropped = instructions.length - kept;
    const truncated = omitted || dropped ? { ...(omitted ? { omitted, first: tree.entries[shown] } : {}), ...(dropped ? { instructions: dropped } : {}) } : null;
    return { ...located, instructions: instructions.slice(0, kept),
      tree: { root: path, files: tree.total, depth: TREE_DEPTH, entries, counts: Object.fromEntries(entries.filter(entry => tree.counts.has(entry)).map(entry => [entry, tree.counts.get(entry)])) },
      truncated, warnings };
  };
  // Trim the tree from the end to fit, then (only if the tree alone can't make room) the
  // innermost instruction pointers. Largest prefix that fits, by binary search.
  let low = 0, high = Math.min(TREE_ENTRIES, tree.entries.length);
  if (bytes(build(high)) <= OPEN_BUDGET) return build(high);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (bytes(build(mid)) <= OPEN_BUDGET) low = mid; else high = mid - 1; }
  if (bytes(build(low)) <= OPEN_BUDGET) return build(low);
  let kept = instructions.length;
  while (kept > 0 && bytes(build(0, kept)) > OPEN_BUDGET) kept--;
  return build(0, kept);
}
