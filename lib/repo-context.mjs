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
import { fail, readText } from './files.mjs';
import { loadHubs, parseRef, skillFile } from './hubs.mjs';
import { loadAddons } from './addons.mjs';
import { freshness, splitFrontmatter, summarize } from './okf.mjs';
import { globProblem } from './globs.mjs';

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
// finds the same files, and case-insensitively too when the checkout's file system is. A name that
// several tracked spellings share once compared that way is refused, never merged.
const fold = name => name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
function trackedDirectory(paths, path, id, caseless) {
  if (!path) return '';
  const compare = caseless ? fold : name => name.normalize('NFC');
  const wanted = `${compare(path)}/`;
  const depth = path.split('/').length;
  const spellings = new Set();
  for (const item of paths) if (compare(item).startsWith(wanted)) spellings.add(item.split('/').slice(0, depth).join('/'));
  if (!spellings.size) fail('UNKNOWN_PATH', `${path} holds no tracked files in the checkout of ${id}`);
  if (spellings.size > 1) fail('INVALID_PATH', `${path} names ${spellings.size} tracked directories that differ only in Unicode normalization${caseless ? ' or case' : ''}; it is ambiguous`);
  return [...spellings][0];
}
// Whether the checkout's file system ignores case: its .git entry is also found as .GIT.
async function caseInsensitive(top) {
  const [lower, upper] = await Promise.all([lstat(join(top, '.git')).catch(() => null), lstat(join(top, '.GIT')).catch(() => null)]);
  return Boolean(lower && upper && lower.ino === upper.ino && lower.dev === upper.dev);
}
// A word for a POSIX shell, quoted unless it is plainly safe.
const shellWord = word => /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const bytes = value => Buffer.byteLength(JSON.stringify(value));
// Per-field allowances, in bytes of compact JSON, so the parts that are always kept can never
// outgrow the budget: each string of the resolution, paths and hints; the whole concept summary.
export const FIELD_MAX = 400;
export const SUMMARY_MAX = 1024;
const CLIP = '…';
// A string within max bytes of JSON, cut at a code point and ending in … when it was longer; the
// field's name goes into `clipped`. For paths and commands, where a cut value is unusable, `whole`
// gives null instead.
function clip(text, max, clipped, field) {
  if (typeof text !== 'string' || bytes(text) <= max) return text;
  const points = [...text];
  let low = 0, high = points.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (bytes(points.slice(0, mid).join('') + CLIP) <= max) low = mid; else high = mid - 1; }
  clipped?.push(field);
  return points.slice(0, low).join('') + CLIP;
}
function whole(text, max, clipped, field) {
  if (bytes(text) <= max) return text;
  clipped.push(field);
  return null;
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
  // The concept's `context`: lenient, except that a structurally invalid one is refused.
  const hubs = await loadHubs(root, { allowEmpty: true });
  const context = hubs.find(hub => hub.manifest.id === repository.hub)?.concepts.get(`${repository.concept}.md`)?.context;
  if (context !== undefined) {
    const shape = contextShape(context);
    if (shape.length) fail('INVALID_CONTEXT', clip(`${repository.id}: ${shape.slice(0, 10).join('; ')}${shape.length > 10 ? `; and ${shape.length - 10} more` : ''} (run validate)`, FIELD_MAX * 8));
  }
  const clipped = [];
  const truncated = {};
  const id = repository.id;
  const alternates = (repository.alternateIds ?? []).map(other => clip(other, FIELD_MAX, clipped, 'resolution.alternateIds'));
  const alternateIds = fitting(alternates, FIELD_MAX);
  if (alternateIds.length < alternates.length) truncated.alternateIds = { omitted: alternates.length - alternateIds.length, next: 'repos' };
  // The concept summary within its allowance: long fields clipped, then aliases from the end.
  // Where the concept is read in full: one shell-quoted command, given whole or not at all.
  const read = whole(`read ${shellWord(`${repository.hub}:/${repository.concept}`)}`, FIELD_MAX, [], 'read');
  const readContext = read && whole(`${read} --frontmatter`, FIELD_MAX, [], 'read');
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
  const report = (extra, more = []) => {
    const fields = [...new Set([...clipped, ...more])];
    const all = { ...truncated, ...extra, ...(fields.length ? { fields, next: read ? `repos, ${read}` : 'repos' } : {}) };
    return Object.keys(all).length ? all : null;
  };
  // Declared items trimmed to `count`, reported in `truncated.declared` with where to read them all.
  const declaredWith = (items, count, subpath) => {
    const { part, warnings, fields, omitted } = declaredPart(items, count, subpath);
    return { part, warnings, fields, extra: omitted ? { declared: { ...omitted, next: readContext } } : {} };
  };
  const missing = async reason => {
    const items = await declaredItems(root, hubs, repository, context, given || null, name => name.normalize('NFC'));
    const build = count => {
      const more = [];
      const declared = declaredWith(items, count, given || null);
      const result = { ...head('missing', null, given), reason: clip(reason, FIELD_MAX * 2, more, 'reason'), next: remedies(id).map(command => clip(command, FIELD_MAX, more, 'next')),
        ...declared.part, instructions: [], tree: null, warnings: declared.warnings };
      return { ...result, truncated: report(declared.extra, [...more, ...declared.fields]) };
    };
    let low = 0, high = items.length;
    if (bytes(build(high)) <= OPEN_BUDGET) return build(high);
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (bytes(build(mid)) <= OPEN_BUDGET) low = mid; else high = mid - 1; }
    return build(low);
  };
  if (!repository.path) return missing(repository.recorded ? `the recorded checkout ${repository.recorded} no longer exists` : 'no checkout is recorded on this machine');
  let top;
  try { top = await realpath(repository.path); } catch { return missing(`the recorded checkout ${repository.path} no longer exists`); }
  let shown;
  try { shown = await realpath((await sealedGit(top, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\n$/, '')); }
  catch { shown = null; }
  if (shown !== top) return missing(`the recorded checkout ${repository.path} is no longer the top of a git checkout`);

  const paths = await trackedPaths(top);
  const caseless = await caseInsensitive(top);
  const path = trackedDirectory(paths, given, id, caseless);
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
  const items = await declaredItems(root, hubs, repository, context, path || null, caseless ? fold : name => name.normalize('NFC'));
  const located = head('located', repository.path, path);
  // Every tracked file below the tree's root, read the way Context Kit reads it: from the index,
  // with fsmonitor and hooks off. It lists omitted files and directories' contents alike.
  const listing = `git -C ${shellWord(top)} -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.quotePath=false ls-files -- ${shellWord(path || '.')}`;
  // The result with the first `shown` tree entries, the first `count` declared items and the
  // first `depths` levels of instruction pointers.
  const build = (shown, count = items.length, depths = levels.length) => {
    const declared = declaredWith(items, count, path || null);
    const more = [...declared.fields];
    const entries = tree.entries.slice(0, shown);
    const rest = tree.entries.slice(shown);
    const kept = levels.slice(0, depths);
    const dropped = levels.slice(depths);
    const droppedPointers = dropped.reduce((sum, level) => sum + level.pointers.length, 0);
    // Omitted files are listed by git; an omitted directory also opens on its own.
    const directory = rest.find(entry => entry.endsWith('/'));
    const next = rest.length ? [whole(listing, FIELD_MAX * 2, more, 'truncated.tree.next'),
      ...(directory ? [whole(`repos open ${id} ${shellWord(directory.slice(0, -1))}`, FIELD_MAX, more, 'truncated.tree.next')] : [])].filter(Boolean) : [];
    const extra = {
      ...declared.extra,
      ...(rest.length ? { tree: { omitted: rest.length, first: whole(rest[0], FIELD_MAX / 2, more, 'truncated.tree.first'), next } } : {}),
      ...(droppedPointers ? { instructions: { omitted: droppedPointers, from: whole(dropped.find(level => level.pointers.length).directory, FIELD_MAX, more, 'truncated.instructions.from'),
        next: 'read AGENTS.md and CLAUDE.md in each directory from `from` down to `path`' } } : {}),
    };
    return { ...located, ...declared.part, instructions: kept.flatMap(level => level.pointers),
      tree: { root: located.path, files: tree.total, depth: TREE_DEPTH, entries, counts: Object.fromEntries(entries.filter(entry => tree.counts.has(entry)).map(entry => [entry, tree.counts.get(entry)])) },
      truncated: report(extra, more), warnings: [...kept.flatMap(level => level.warnings), ...declared.warnings] };
  };
  const fits = result => bytes(result) <= OPEN_BUDGET;
  // The largest tree prefix that fits with every level; else no tree and the most levels that fit
  // (the root's level always). Binary search: fitting is monotone in the prefix length.
  let low = 0, high = Math.min(TREE_ENTRIES, tree.entries.length);
  if (fits(build(high))) return build(high);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(build(mid))) low = mid; else high = mid - 1; }
  if (fits(build(low))) return build(low);
  // Then declared items from the end, then deeper instruction pointers, innermost first.
  low = 0; high = items.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(build(0, mid))) low = mid; else high = mid - 1; }
  if (fits(build(0, low))) return build(0, low);
  low = 1; high = levels.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(build(0, 0, mid))) low = mid; else high = mid - 1; }
  const result = build(0, 0, low);
  // The allowances make this unreachable; failing loudly beats breaking the contract quietly.
  if (!fits(result)) fail('TOO_LARGE', `The open result for ${clip(id, FIELD_MAX)} exceeds ${OPEN_BUDGET} bytes even with only the resolution and root instructions`);
  return result;
}

// ---- The `context` field of a Repository concept ----------------------------------------------
//
// A closed schema: every level refuses unknown keys and every list and string has a bound.
// Structural problems (shape, bounds, malformed values) make `repos open` fail with
// INVALID_CONTEXT; references that no longer resolve fail only `validate`, and open returns them
// as pointers marked missing. Nothing in `context` is ever run, fetched or installed.
export const CONTEXT_BOUNDS = { list: 50, areas: 50, roles: 8, packs: 20, name: 40, text: 200, description: 300, verify: 10, mcp: 64,
  packFiles: 500, packBytes: 4 * 1024 * 1024 };
const KEYS = {
  context: ['verify', 'concepts', 'skills', 'mcp', 'areas', 'roles', 'packs'],
  area: ['path', 'concepts', 'skills', 'mcp'],
  role: ['exclude', 'omit', 'concepts', 'skills', 'mcp'],
  pack: ['description', 'files', 'exclude', 'concepts', 'skills', 'mcp', 'limits'],
  limits: ['files', 'bytes'],
};
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MCP_NAME = /^[a-z0-9_-]{1,64}$/;
const KIT_SKILL = /^kit:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const length = text => [...text].length;
const shown = value => { const text = JSON.stringify(value) ?? String(value); return length(text) > 80 ? `${[...text].slice(0, 79).join('')}…` : text; };
const cleanSegments = path => path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !/[\\\u0000-\u001f\u007f]/.test(segment));

// A concept reference: `/<concept-id>` in the declaring hub, or `<hub-id>:/<concept-id>`; null when malformed.
export function conceptReference(text, hubId) {
  if (typeof text !== 'string') return null;
  const ref = text.startsWith('/') ? { hub: hubId, concept: text.slice(1) } : parseRef(text);
  return ref && ref.concept && cleanSegments(ref.concept) ? ref : null;
}
// A skill reference in a hub manifest's form: `kit:<name>` or a workspace `<path>/SKILL.md`.
const skillForm = text => typeof text === 'string' && (KIT_SKILL.test(text) ||
  (text.endsWith('/SKILL.md') && !text.startsWith('/') && cleanSegments(text)));
// An area's directory: relative, no `.`, `..` or `.git` segment, backslash or glob character.
function areaPath(text) {
  if (typeof text !== 'string' || !text) return null;
  const path = text.endsWith('/') && text.length > 1 ? text.slice(0, -1) : text;
  if (path.startsWith('/') || /[*?[\]{}]/.test(path) || !cleanSegments(path) || path.split('/').some(segment => segment.toLowerCase() === '.git')) return null;
  return path;
}

// Structural problems of one `context` value, each `<key path>: <why>`.
export function contextShape(context) {
  const problems = [];
  const add = (at, why) => problems.push(`${at}: ${why}`);
  const B = CONTEXT_BOUNDS;
  const closed = (value, allowed, at) => {
    if (!isMapping(value)) { add(at, 'must be a mapping'); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(`${at}.${key}`, `unknown key (allowed: ${allowed.join(', ')})`);
    return true;
  };
  const text = (value, at, max = B.text) => {
    if (typeof value !== 'string' || !value.trim()) { add(at, 'must be a non-empty string'); return false; }
    if (length(value) > max) { add(at, `${length(value)} characters; at most ${max}`); return false; }
    return true;
  };
  const list = (value, at, max, each) => {
    if (!Array.isArray(value)) { add(at, 'must be a list'); return; }
    if (value.length > max) add(at, `${value.length} entries; at most ${max}`);
    value.forEach((item, index) => each(item, `${at}[${index}]`));
  };
  const concepts = (value, at) => list(value, at, B.list, (item, where) => {
    if (text(item, where) && !conceptReference(item, 'x')) add(where, `${shown(item)} is malformed; write /<concept-id> or <hub-id>:/<concept-id>`);
  });
  const skills = (value, at) => list(value, at, B.list, (item, where) => {
    if (text(item, where) && !skillForm(item)) add(where, `${shown(item)} is malformed; write kit:<name> or a workspace <path>/SKILL.md`);
  });
  const mcp = (value, at) => list(value, at, B.list, (item, where) => {
    if (typeof item !== 'string' || !MCP_NAME.test(item)) add(where, `${shown(item)} is not an MCP server name (lowercase letters, digits, - and _, at most ${B.mcp} characters)`);
  });
  const globs = (value, at, required = false) => {
    if (required && Array.isArray(value) && !value.length) add(at, 'must list at least one glob');
    list(value, at, B.list, (item, where) => {
      if (!text(item, where)) return;
      const why = globProblem(item);
      if (why) add(where, `${shown(item)}: ${why}`);
    });
  };
  const pointers = (value, at) => {
    if ('concepts' in value) concepts(value.concepts, `${at}.concepts`);
    if ('skills' in value) skills(value.skills, `${at}.skills`);
    if ('mcp' in value) mcp(value.mcp, `${at}.mcp`);
  };
  const named = (value, at, max, kind, each) => {
    if (!isMapping(value)) { add(at, 'must be a mapping'); return; }
    const names = Object.keys(value);
    if (names.length > max) add(at, `${names.length} ${kind}s; at most ${max}`);
    for (const name of names) {
      if (!NAME.test(name) || name.length > B.name) add(`${at}.${name}`, `${kind} names are lowercase letters, digits and single hyphens, at most ${B.name} characters`);
      each(value[name], `${at}.${name}`, name);
    }
  };
  if (!closed(context, KEYS.context, 'context')) return problems;
  if ('verify' in context) list(context.verify, 'context.verify', B.verify, (item, where) => {
    if (typeof item === 'string' && /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(item)) add(where, 'must be a single line without control characters');
    else text(item, where);
  });
  pointers(context, 'context');
  if ('areas' in context) {
    const seen = new Map();
    list(context.areas, 'context.areas', B.areas, (area, where) => {
      if (!closed(area, KEYS.area, where)) return;
      if (!('path' in area)) add(`${where}.path`, 'required');
      else if (text(area.path, `${where}.path`)) {
        const path = areaPath(area.path);
        if (!path) add(`${where}.path`, `${shown(area.path)} must be a directory relative to the checkout root, without a leading /, . or .. segments, backslashes or glob characters`);
        // Folded for case too, so two areas never name one directory on a caseless file system.
        else if (seen.has(fold(path))) add(`${where}.path`, `${shown(area.path)} repeats ${seen.get(fold(path))}`);
        else seen.set(fold(path), where);
      }
      pointers(area, where);
    });
  }
  if ('roles' in context) named(context.roles, 'context.roles', B.roles, 'role', (role, at) => {
    if (!closed(role, KEYS.role, at)) return;
    if ('exclude' in role) globs(role.exclude, `${at}.exclude`);
    if ('omit' in role) list(role.omit, `${at}.omit`, B.list, (item, where) => {
      if (text(item, where) && !conceptReference(item, 'x') && !skillForm(item) && !MCP_NAME.test(item)) add(where, `${shown(item)} is not a concept reference, skill reference or MCP server name`);
    });
    pointers(role, at);
  });
  if ('packs' in context) named(context.packs, 'context.packs', B.packs, 'pack', (pack, at, name) => {
    if (name === 'default') add(at, 'default is reserved for the default bootstrap; name the pack otherwise');
    if (!closed(pack, KEYS.pack, at)) return;
    if (!('description' in pack)) add(`${at}.description`, 'required');
    else text(pack.description, `${at}.description`, B.description);
    if (!('files' in pack)) add(`${at}.files`, 'required');
    else globs(pack.files, `${at}.files`, true);
    if ('exclude' in pack) globs(pack.exclude, `${at}.exclude`);
    pointers(pack, at);
    if ('limits' in pack && closed(pack.limits, KEYS.limits, `${at}.limits`)) {
      for (const [key, max] of [['files', B.packFiles], ['bytes', B.packBytes]]) {
        const value = pack.limits[key];
        if (key in pack.limits && !(Number.isInteger(value) && value >= 1 && value <= max)) add(`${at}.limits.${key}`, `${shown(value)}; must be an integer from 1 to ${max}`);
      }
    }
  });
  return problems;
}

// Every concept and skill reference a `context` declares, with where.
function references(context) {
  const concepts = [], skills = [];
  const from = (value, at) => {
    if (!isMapping(value)) return;
    if (Array.isArray(value.concepts)) value.concepts.forEach((ref, index) => concepts.push({ ref, at: `${at}.concepts[${index}]` }));
    if (Array.isArray(value.skills)) value.skills.forEach((ref, index) => skills.push({ ref, at: `${at}.skills[${index}]` }));
  };
  from(context, 'context');
  if (Array.isArray(context.areas)) context.areas.forEach((area, index) => from(area, `context.areas[${index}]`));
  for (const kind of ['roles', 'packs']) if (isMapping(context[kind])) for (const [name, value] of Object.entries(context[kind])) from(value, `context.${kind}.${name}`);
  return { concepts, skills };
}

// One resolver for concept references: the concept's hub and frontmatter, or why it does not resolve.
export function resolveConcept(hubs, ref, hubId) {
  const parsed = conceptReference(ref, hubId);
  if (!parsed) return { why: 'malformed' };
  const hub = hubs.find(item => item.manifest.id === parsed.hub);
  if (!hub) return { ...parsed, why: 'unknown hub' };
  if (parsed.concept === 'inbox' || parsed.concept.startsWith('inbox/')) return { ...parsed, why: 'inbox note' };
  const data = hub.concepts.get(`${parsed.concept}.md`);
  if (!data) return { ...parsed, why: 'no such concept' };
  return { ...parsed, hubData: hub, data };
}
// Skill references are readable exactly when read-skill serves them: some hub declares the
// reference and, for kit: skills, an enabled addon provides it. The pointer names the first
// declaring hub in hub-ID order.
export function resolveSkill(hubs, provided, ref) {
  if (!skillForm(ref)) return { why: 'malformed' };
  const declaring = hubs.filter(hub => hub.manifest.skills.includes(ref)).map(hub => hub.manifest.id).sort();
  if (!declaring.length) return { why: 'no hub declares it' };
  if (ref.startsWith('kit:') && !provided.enabled.has(ref)) return { why: provided.all.has(ref) ? 'its addon is not enabled' : 'no enabled addon provides it' };
  return { hub: declaring[0] };
}
export async function providedSkills(root) {
  const addons = (await loadAddons(root)).filter(addon => addon.source === 'kit');
  const names = list => new Set(list.flatMap(addon => addon.skills.map(skill => `kit:${skill.name}`)));
  return { enabled: names(addons.filter(addon => addon.enabled)), all: names(addons) };
}

// validate's problems with Repository concepts' `context`, each naming the concept and the key path.
export async function contextProblems(root, hubs) {
  const problems = [];
  let provided = null;
  for (const hub of hubs) {
    for (const [path, data] of [...hub.concepts].sort(([a], [b]) => byCodePoint(a, b))) {
      if (data.type !== 'Repository' || path.startsWith('inbox/') || !('context' in data)) continue;
      const id = `${hub.manifest.id}/${path.slice(0, -3)}`;
      const shape = contextShape(data.context);
      problems.push(...shape.map(problem => `${id}: ${problem}`));
      if (!isMapping(data.context)) continue;
      const { concepts, skills } = references(data.context);
      for (const { ref, at } of concepts) {
        if (typeof ref !== 'string' || !conceptReference(ref, hub.manifest.id)) continue;
        const found = resolveConcept(hubs, ref, hub.manifest.id);
        if (found.why) problems.push(`${id}: ${at}: ${shown(ref)} does not resolve: ${found.why}`);
      }
      for (const { ref, at } of skills) {
        if (!skillForm(ref)) continue;
        provided ??= await providedSkills(root);
        const found = resolveSkill(hubs, provided, ref);
        if (found.why) problems.push(`${id}: ${at}: ${shown(ref)} is not readable: ${found.why}`);
      }
    }
  }
  return problems;
}

// ---- Declared context in an open result -------------------------------------------------------

const POINTER_DESCRIPTION = 300;
const clipPoints = (text, max, fields, field) => {
  if (typeof text !== 'string' || length(text) <= max) return text;
  fields.push(field);
  return `${[...text].slice(0, max - 1).join('')}${CLIP}`;
};
// A concept pointer without its body: hub, ID, type, title, description, trust and freshness
// action; or, when the reference no longer resolves, marked missing with a warning.
function conceptPointer(hubs, ref, hubId) {
  const found = resolveConcept(hubs, ref, hubId);
  if (found.why) return { key: `${found.hub}:/${found.concept}`, value: { hub: clip(found.hub, FIELD_MAX / 2), concept: found.concept, missing: true },
    warning: clip(`${ref} no longer resolves (${found.why}); run validate`, FIELD_MAX), fields: [] };
  const fields = [];
  const { summary } = summarize(found.data);
  return { key: `${found.hub}:/${found.concept}`, fields, value: { hub: clip(found.hub, FIELD_MAX / 2, fields, 'pointers.concepts.hub'), concept: found.concept,
    type: clip(summary.type, FIELD_MAX / 4, fields, 'pointers.concepts.type'), title: clip(summary.title, FIELD_MAX / 2, fields, 'pointers.concepts.title'),
    description: clipPoints(summary.description, POINTER_DESCRIPTION, fields, 'pointers.concepts.description'), trust: summary.trust,
    freshness: freshness(found.data, found.hubData.manifest.freshness).action } };
}
// A skill pointer: the hub and reference read-skill takes, with the skill's name and description.
async function skillPointer(root, hubs, provided, ref) {
  const found = resolveSkill(hubs, provided, ref);
  const missing = why => ({ key: ref, value: { reference: ref, missing: true }, warning: clip(`${ref} is not readable (${why}); run validate`, FIELD_MAX), fields: [] });
  if (found.why) return missing(found.why);
  let data = {};
  try { const front = splitFrontmatter(await readText(await skillFile(root, ref))); data = front && !front.error ? front.data : {}; }
  catch { return missing('its SKILL.md could not be read'); }
  const fields = [];
  return { key: ref, fields, value: { hub: clip(found.hub, FIELD_MAX / 2, fields, 'pointers.skills.hub'), reference: ref,
    name: clip(typeof data.name === 'string' ? data.name : ref.replace(/^kit:|\/SKILL\.md$/g, '').split('/').pop(), FIELD_MAX / 4, fields, 'pointers.skills.name'),
    description: clipPoints(typeof data.description === 'string' ? data.description : '', POINTER_DESCRIPTION, fields, 'pointers.skills.description') } };
}

// The declared part of an open result as an ordered list of items, trimmed from the end to fit:
// verify commands, matched areas (with a subpath), concept, skill and MCP pointers (the
// repository's, then each matched area's, outermost first, each once), then area summaries
// (without a subpath), role names and pack summaries.
async function declaredItems(root, hubs, repository, context, subpath, compare) {
  const items = [];
  if (!isMapping(context)) return items;
  const hubId = repository.hub;
  for (const command of context.verify ?? []) items.push({ kind: 'verify', value: command });
  const areas = context.areas ?? [];
  const matched = [];
  if (subpath !== null) {
    const wanted = `${compare(subpath)}/`;
    for (const area of areas) {
      const path = areaPath(area.path);
      if (wanted.startsWith(`${compare(path)}/`)) matched.push({ ...area, path });
    }
    matched.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const area of matched) items.push({ kind: 'matchedAreas', value: area.path });
  }
  const sources = [context, ...matched];
  const seen = new Set();
  const once = key => !seen.has(key) && seen.add(key);
  const provided = sources.some(source => source.skills?.length) ? await providedSkills(root) : null;
  for (const source of sources) for (const ref of source.concepts ?? []) {
    const pointer = conceptPointer(hubs, ref, hubId);
    if (once(`concept ${pointer.key}`)) items.push({ kind: 'concepts', ...pointer });
  }
  for (const source of sources) for (const ref of source.skills ?? []) {
    if (once(`skill ${ref}`)) items.push({ kind: 'skills', ...await skillPointer(root, hubs, provided, ref) });
  }
  for (const source of sources) for (const name of source.mcp ?? []) if (once(`mcp ${name}`)) items.push({ kind: 'mcp', value: name });
  if (subpath === null) for (const area of areas) items.push({ kind: 'areas', value: { path: areaPath(area.path), concepts: area.concepts?.length ?? 0, skills: area.skills?.length ?? 0, mcp: area.mcp?.length ?? 0 } });
  for (const name of Object.keys(context.roles ?? {})) items.push({ kind: 'roles', value: name });
  for (const [name, pack] of Object.entries(context.packs ?? {})) items.push({ kind: 'packs', value: { name, description: pack.description } });
  return items;
}
// The result fields for the first `count` declared items, their warnings and clipped fields.
function declaredPart(items, count, subpath) {
  const part = { verify: [], ...(subpath !== null ? { matchedAreas: [] } : {}), pointers: { concepts: [], skills: [], mcp: [] },
    ...(subpath === null ? { areas: [] } : {}), roles: [], packs: [] };
  const warnings = [], fields = [];
  for (const item of items.slice(0, count)) {
    (['concepts', 'skills', 'mcp'].includes(item.kind) ? part.pointers[item.kind] : part[item.kind]).push(item.value);
    if (item.warning) warnings.push(item.warning);
    fields.push(...(item.fields ?? []));
  }
  const omitted = items.slice(count);
  const kindName = kind => ['concepts', 'skills', 'mcp'].includes(kind) ? `pointers.${kind}` : kind;
  return { part, warnings, fields, omitted: omitted.length ? { omitted: omitted.length, first: kindName(omitted[0].kind) } : null };
}
