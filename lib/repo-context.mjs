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
// `.git` segment, backslash, control character or leading `/`. One trailing `/` is allowed and dropped.
function subpathOf(given) {
  if (given === undefined || given === '' || given === '.') return '';
  const text = given.endsWith('/') && given.length > 1 ? given.slice(0, -1) : given;
  const bad = reason => fail('INVALID_PATH', `${JSON.stringify(given)} is not a path inside the checkout: ${reason}`);
  if ([...text].length > SUBPATH_MAX) bad(`over ${SUBPATH_MAX} characters`);
  if (text.startsWith('/')) bad('it is absolute');
  if (/[\\\u0000-\u001f\u007f]/.test(text)) bad('it holds a backslash or control character');
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

// The tracked directory a subpath names, in the index's spelling: subpath and index paths are
// compared in Unicode NFC, so an NFD spelling of an NFC directory (which macOS file systems accept)
// finds the same files. A name that several tracked spellings share once normalized is refused.
function trackedDirectory(paths, path, id) {
  if (!path) return '';
  const wanted = `${path.normalize('NFC')}/`;
  const depth = path.split('/').length;
  const spellings = new Set();
  for (const item of paths) if (item.normalize('NFC').startsWith(wanted)) spellings.add(item.split('/').slice(0, depth).join('/'));
  if (!spellings.size) fail('UNKNOWN_PATH', `${path} holds no tracked files in the checkout of ${id}`);
  if (spellings.size > 1) fail('INVALID_PATH', `${path} names ${spellings.size} tracked directories that differ only in Unicode normalization; it is ambiguous`);
  return [...spellings][0];
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));
// Per-field allowances, in bytes of compact JSON, so the parts that are always kept can never
// outgrow the budget: each string of the resolution, paths and hints; the whole concept summary.
export const FIELD_MAX = 400;
export const SUMMARY_MAX = 1024;
const CLIP = '…';
// A string within max bytes of JSON, cut at a code point and ending in … when it was longer; the
// field's name goes into `clipped`.
function clip(text, max, clipped, field) {
  if (typeof text !== 'string' || bytes(text) <= max) return text;
  const points = [...text];
  let low = 0, high = points.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (bytes(points.slice(0, mid).join('') + CLIP) <= max) low = mid; else high = mid - 1; }
  clipped?.push(field);
  return points.slice(0, low).join('') + CLIP;
}
// The longest prefix of items whose list stays within max bytes.
function fitting(items, max) {
  let count = 0;
  while (count < items.length && bytes(items.slice(0, count + 1)) <= max) count++;
  return items.slice(0, count);
}

// Opens a registered repository by id, title, alias or upstream name, ignoring the caller's
// working directory. Never clones, records or searches: an unrecorded or stale checkout is a
// successful `missing` result with the exact next commands.
//
// The whole result fits OPEN_BUDGET bytes of compact JSON for every input. The resolution and the
// root's instruction pointers are always kept (their strings bounded by FIELD_MAX); the concept
// summary is bounded by SUMMARY_MAX (aliases cut from the end first); then the tree is cut from the
// end, then deeper instruction pointers, innermost directory first. Every cut is in `truncated`,
// with how to get the rest.
export async function openRepository(root, name, subpath) {
  const given = subpathOf(subpath);
  const { repositories } = await listRepositories(root);
  const { repository, matched } = findRepository(repositories, name);
  const clipped = [];
  const truncated = {};
  const id = repository.id;
  const alternates = (repository.alternateIds ?? []).map(other => clip(other, FIELD_MAX, clipped, 'resolution.alternateIds'));
  const alternateIds = fitting(alternates, FIELD_MAX);
  if (alternateIds.length < alternates.length) truncated.alternateIds = { omitted: alternates.length - alternateIds.length, next: 'repos' };
  // The concept summary within its allowance: long fields clipped, then aliases from the end.
  const read = clip(`read ${repository.hub}:/${repository.concept}`, FIELD_MAX);
  const summaryOf = aliases => ({ id: clip(id, FIELD_MAX, clipped, 'repository.id'), title: clip(repository.title, FIELD_MAX / 2, clipped, 'repository.title'),
    aliases, hub: clip(repository.hub, FIELD_MAX / 2, clipped, 'repository.hub'), concept: clip(repository.concept, FIELD_MAX, clipped, 'repository.concept') });
  const aliases = repository.aliases.map(alias => clip(alias, FIELD_MAX / 4, clipped, 'repository.aliases'));
  let kept = aliases.length;
  while (kept > 0 && bytes(summaryOf(aliases.slice(0, kept))) > SUMMARY_MAX) kept--;
  const summary = summaryOf(aliases.slice(0, kept));
  if (kept < aliases.length) truncated.repository = { aliases: aliases.length - kept, next: read };
  const head = (status, recorded, path) => ({
    root: clip(root, FIELD_MAX, clipped, 'root'), status, repository: summary,
    resolution: { name: clip(name, FIELD_MAX, clipped, 'resolution.name'), matched, concept: clip(id, FIELD_MAX, clipped, 'resolution.concept'), alternateIds,
      upstream: clip(repository.upstream, FIELD_MAX, clipped, 'resolution.upstream'), path: clip(recorded, FIELD_MAX, clipped, 'resolution.path'), source: 'machine' },
    path: clip(path, FIELD_MAX, clipped, 'path'),
  });
  // `truncated`, or null; clipped fields are listed once, with where their full values are.
  const report = extra => {
    const all = { ...truncated, ...extra, ...(clipped.length ? { fields: [...new Set(clipped)], next: `repos, ${read}` } : {}) };
    return Object.keys(all).length ? all : null;
  };
  const missing = reason => {
    const result = { ...head('missing', null, given), reason: clip(reason, FIELD_MAX * 2), next: remedies(id).map(command => clip(command, FIELD_MAX)), instructions: [], tree: null, warnings: [] };
    return { ...result, truncated: report({}) };
  };
  if (!repository.path) return missing(repository.recorded ? `the recorded checkout ${repository.recorded} no longer exists` : 'no checkout is recorded on this machine');
  let top;
  try { top = await realpath(repository.path); } catch { return missing(`the recorded checkout ${repository.path} no longer exists`); }
  let shown;
  try { shown = await realpath((await sealedGit(top, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\n$/, '')); }
  catch { shown = null; }
  if (shown !== top) return missing(`the recorded checkout ${repository.path} is no longer the top of a git checkout`);

  const paths = await trackedPaths(top);
  const path = trackedDirectory(paths, given, id);
  const target = await walk(top, path);
  if (target.missing || (target.info && !target.info.isDirectory())) fail('UNKNOWN_PATH', `${path} is not a directory in the checkout of ${id}`);
  if (target.escape) fail('PATH_ESCAPE', `${path} leaves the checkout of ${id}: ${target.escape} is a symlink`);

  const tracked = new Set(paths);
  // One level per directory from the root down to the subpath, outermost first; exact names only.
  const levels = [];
  const segments = path ? path.split('/') : [];
  for (let depth = 0; depth <= segments.length; depth++) {
    const directory = segments.slice(0, depth).join('/');
    const level = { directory, pointers: [], warnings: [] };
    const names = new Set(await readdir(join(top, directory)).catch(() => []));
    for (const file of INSTRUCTION_FILES) {
      if (!names.has(file)) continue;
      const relativePath = directory ? `${directory}/${file}` : file;
      const found = await pointer(top, relativePath, tracked.has(relativePath));
      if (found?.warning) level.warnings.push(found.warning);
      else if (found) level.pointers.push(found);
    }
    levels.push(level);
  }

  const tree = fullTree(paths, path);
  const located = head('located', repository.path, path);
  const openHint = clip(`repos open ${id} <directory>`, FIELD_MAX);
  // The result with the first `shown` tree entries and the first `depths` levels of pointers.
  const build = (shown, depths = levels.length) => {
    const entries = tree.entries.slice(0, shown);
    const omitted = tree.entries.length - entries.length;
    const kept = levels.slice(0, depths);
    const dropped = levels.slice(depths);
    const droppedPointers = dropped.reduce((sum, level) => sum + level.pointers.length, 0);
    const extra = {
      ...(omitted ? { tree: { omitted, first: clip(tree.entries[shown], FIELD_MAX / 2), next: openHint } } : {}),
      ...(droppedPointers ? { instructions: { omitted: droppedPointers, from: clip(dropped.find(level => level.pointers.length).directory, FIELD_MAX),
        next: 'read AGENTS.md and CLAUDE.md in each directory from `from` down to `path`' } } : {}),
    };
    return { ...located, instructions: kept.flatMap(level => level.pointers),
      tree: { root: located.path, files: tree.total, depth: TREE_DEPTH, entries, counts: Object.fromEntries(entries.filter(entry => tree.counts.has(entry)).map(entry => [entry, tree.counts.get(entry)])) },
      truncated: report(extra), warnings: kept.flatMap(level => level.warnings) };
  };
  const fits = result => bytes(result) <= OPEN_BUDGET;
  // The largest tree prefix that fits with every level; else no tree and the most levels that fit
  // (the root's level always). Binary search: fitting is monotone in the prefix length.
  let low = 0, high = Math.min(TREE_ENTRIES, tree.entries.length);
  if (fits(build(high))) return build(high);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(build(mid))) low = mid; else high = mid - 1; }
  if (fits(build(low))) return build(low);
  low = 1; high = levels.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(build(0, mid))) low = mid; else high = mid - 1; }
  const result = build(0, low);
  // The allowances make this unreachable; failing loudly beats breaking the contract quietly.
  if (!fits(result)) fail('TOO_LARGE', `The open result for ${clip(id, FIELD_MAX)} exceeds ${OPEN_BUDGET} bytes even with only the resolution and root instructions`);
  return result;
}
