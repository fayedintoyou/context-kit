// Behavior sources: the kit-owned boundary over where a repository's behavioral truth lives.
// A source is chosen by name from a fixed table and lists behaviors with a source-native ID,
// a kind, a title, the text, the file it comes from and a fingerprint of the normalized text.
// Sources only read files and the pinned OpenSpec CLI; nothing in a repository is executed.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { fail, MAX_FILE } from '../files.mjs';

// NFKC, line endings unified, trailing whitespace per line and trailing blank lines dropped,
// so a fingerprint is the same across runs, machines and editors.
export function normalize(text) {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/u, '')).join('\n').replace(/\n+$/, '');
}
export const fingerprint = text => createHash('sha256').update(normalize(text), 'utf8').digest('hex').slice(0, 12);

// The adapter's own failures can carry a line of OpenSpec's stderr; behavior results never do.
async function adapted(read) {
  try { return await read(); }
  catch (error) {
    if (error.code === 'ADAPTER_FAILED') fail('ADAPTER_FAILED', 'OpenSpec could not read the specs; run openspec validate --specs in the repository for details');
    throw error;
  }
}

// OpenSpec: canonical requirements as `<capability> / <requirement>` and scenarios as
// `<capability> / <scenario>`, read through the pinned adapter (canonical specs only, never
// pending change deltas). A requirement's text is its statement followed by its scenarios,
// so editing a scenario changes the fingerprint of the requirement that holds it.
function openspecSource(spec, selection) {
  const capabilities = () => adapted(async () => (await spec.list()).map(item => item.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  async function read(capability) {
    const data = await adapted(() => spec.read(capability));
    const behaviors = [];
    for (const requirement of data.requirements) {
      const id = `${capability} / ${requirement.name}`;
      const text = [requirement.text, ...requirement.scenarios.map(scenario => `#### Scenario: ${scenario.name}\n${scenario.rawText}`)].join('\n\n');
      behaviors.push({ id, kind: 'requirement', title: requirement.name, text, file: data.path, fingerprint: fingerprint(text) });
      for (const scenario of requirement.scenarios) {
        behaviors.push({ id: `${capability} / ${scenario.name}`, kind: 'scenario', title: scenario.name, text: scenario.rawText,
          file: data.path, fingerprint: fingerprint(scenario.rawText), parent: id });
      }
    }
    return behaviors;
  }
  return {
    name: 'openspec',
    describe: () => ({ kind: 'openspec', ...(selection.store === undefined ? {} : { store: selection.store }) }),
    get root() { return spec.root; },
    capabilities,
    read,
    groupOf: capabilityOf,
    noun: 'requirement or scenario',
    // A scope entry is a capability (its scenarios) or `<capability> / <requirement>` (that
    // requirement's scenarios); groups holds what read returned for each capability.
    scoped(entry, groups) {
      const capability = capabilityOf(entry);
      const behaviors = groups.get(capability);
      if (!behaviors) return { error: `Scope names ${capability}, which is no capability of the source` };
      if (entry === capability) return { behaviors: behaviors.filter(behavior => behavior.kind === 'scenario') };
      if (!behaviors.some(behavior => behavior.kind === 'requirement' && behavior.id === entry)) return { error: `Scope names ${entry}, which is no requirement of ${capability}` };
      return { behaviors: behaviors.filter(behavior => behavior.kind === 'scenario' && behavior.parent === entry) };
    },
  };
}

// Linked-intent development (github.com/jszmajda/lid): EARS entries in the workspace
// repository's `docs/intent/**/*-specs.md` (current layout) and `docs/specs/*.md` (the layout
// of upstream's examples/urlshort), read as plain files. An entry is a list item
// `**<ID>**: <text>`, optionally preceded by a status marker `[x]`, `[ ]` or `[D]`, plain (as in
// upstream's EARS reference) or in backticks (as in upstream's own spec files). Its text runs to
// the next list item, heading or blank line; code blocks (examples) are skipped. A symlink is
// never followed: it is reported in `skipped` and not read, as is a list item that looks like an
// entry but has no valid ID or marker (with its line).
// Upstream's ID rule: upper-case letters, digits and hyphens only, path segments ending in a
// number (`AUTH-UI-001`, `PEVAL-RUN-014`, `2FA-001`).
const LID_ID = /^[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]+$/;
// A bullet item's first paragraph: an optional marker in brackets (plain or in backticks), then
// `**<label>**:` and the text.
const LID_CANDIDATE = /^(?:(`?)\[([^\]`]?)\]\1[ \t]+)?\*\*([^*\s]+)\*\*:(?:[ \t]+(.*))?$/;
const LID_MARKERS = { x: 'implemented', ' ': 'gap', D: 'deferred' };
// A bold label that reads as an attempted ID, in any script: a digit and an internal separator.
const LID_LOOKS_LIKE_ID = /^(?=.*\p{N})[\p{L}\p{N}]+(?:[-_.\p{Pd}][\p{L}\p{N}]+)+$/u;
const LID_MAX_FILES = 2000;
const LID_MAX_DEPTH = 16;
// CommonMark block structure only (no HTML, links or typography), so code blocks, fenced or
// indented, at any depth in lists or block quotes, are found the way a Markdown renderer finds them.
const markdown = new MarkdownIt('commonmark', { html: false });

// Entries in file order, and the bullet items that look like entries but aren't (in rejected).
// An entry is a bullet list item whose first block is a paragraph; the paragraph is its text, so
// it runs to the next list item, heading or blank line. Text in code blocks is never read.
export function parseLidEntries(text, file, rejected = []) {
  const tokens = markdown.parse(text.replace(/\r\n?/g, '\n'), {});
  const entries = [];
  let heading = null;
  tokens.forEach((token, index) => {
    if (token.type === 'heading_open' && (token.tag === 'h1' || token.tag === 'h2')) {
      heading = token.tag === 'h2' ? tokens[index + 1].content.trim() || null : null;
      return;
    }
    if (token.type !== 'list_item_open' || !['-', '*', '+'].includes(token.markup) || tokens[index + 1]?.type !== 'paragraph_open') return;
    const paragraph = tokens[index + 1];
    const [first, ...rest] = tokens[index + 2].content.split('\n').map(line => line.trim());
    const candidate = first.match(LID_CANDIDATE);
    if (!candidate) return;
    const [, , mark, label, opening] = candidate;
    const line = paragraph.map[0] + 1;
    const marked = mark !== undefined;
    if (LID_ID.test(label) && (!marked || Object.hasOwn(LID_MARKERS, mark))) {
      entries.push({ id: label, marker: marked ? LID_MARKERS[mark] : 'none', heading, text: [opening ?? '', ...rest].join('\n').trim(), file, line });
    } else if (marked || LID_LOOKS_LIKE_ID.test(label)) {
      const reason = !LID_ID.test(label) ? `${label} is not a linked-intent ID (upper-case letters, digits and hyphens, ending in -<number>)`
        : `[${mark}] is not a status marker ([x], [ ] or [D])`;
      rejected.push({ file, line, id: label, reason });
    }
  });
  return entries;
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The spec files under one directory of the repository, never through a symlink, as
// repository-relative paths; symlinks met on the way are added to skipped.
async function lidFiles(root, directory, recursive, matches, skipped, depth = 0) {
  const path = join(root, directory);
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
  if (info.isSymbolicLink()) { skipped.push({ file: directory, reason: 'symlink' }); return []; }
  if (!info.isDirectory()) return [];
  const files = [];
  for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => byPath(a.name, b.name))) {
    const relative = `${directory}/${item.name}`;
    if (item.isSymbolicLink()) {
      // Reported when it could hold entries: a spec file's name, or (when recursing) a link to a
      // directory. Only the link's target type is looked up; nothing behind it is read.
      const linksDirectory = recursive && await stat(join(root, relative)).then(target => target.isDirectory(), () => false);
      if (matches(item.name) || linksDirectory) skipped.push({ file: relative, reason: 'symlink' });
      continue;
    }
    if (item.isDirectory() && recursive) {
      if (depth + 1 >= LID_MAX_DEPTH) fail('INVALID_SOURCE', `${relative} is nested more than ${LID_MAX_DEPTH} directories deep; linked-intent specs are read to that depth`);
      files.push(...await lidFiles(root, relative, recursive, matches, skipped, depth + 1));
    } else if (item.isFile() && matches(item.name)) files.push(relative);
  }
  return files;
}

// Reads one file without following a symlink at its last component, and only if it is still
// the regular file the walk saw, at the same real path inside the repository.
async function lidRead(root, realRoot, file) {
  const path = join(root, file);
  const vanished = () => fail('SNAPSHOT_CHANGED', `${file} was removed or replaced while it was read; run the command again`);
  const seen = await lstat(path).catch(error => (error.code === 'ENOENT' ? vanished() : Promise.reject(error)));
  if (seen.isSymbolicLink()) return { skipped: 'symlink' };
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ELOOP') return { skipped: 'symlink' };
    if (error.code === 'ENOENT') vanished();
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== seen.dev || info.ino !== seen.ino) vanished();
    if (info.size > MAX_FILE) return { skipped: 'too large' };
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_FILE) return { skipped: 'too large' };
    if (await realpath(path) !== join(realRoot, file)) fail('PATH_ESCAPE', `${file} resolves outside the repository; nothing was read from it`);
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)) }; }
    catch { return { skipped: 'not UTF-8' }; }
  } finally { await handle.close(); }
}

async function lidSource(spec, selection) {
  const { root } = spec;
  let behaviors;
  const skipped = [];
  async function load() {
    if (behaviors) return behaviors;
    const realRoot = await realpath(root);
    // docs/ is checked first: an lstat below it would resolve a symlinked docs/.
    const docs = await lstat(join(root, 'docs')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (docs?.isSymbolicLink()) skipped.push({ file: 'docs', reason: 'symlink' });
    const files = !docs?.isDirectory() ? [] : [
      ...await lidFiles(root, 'docs/intent', true, name => name.endsWith('-specs.md'), skipped),
      ...await lidFiles(root, 'docs/specs', false, name => name.endsWith('.md'), skipped),
    ];
    if (files.length > LID_MAX_FILES) fail('INVALID_SOURCE', `The repository has ${files.length} linked-intent spec files; the lid source reads at most ${LID_MAX_FILES}`);
    const seen = new Map();
    const entries = [];
    for (const file of files.sort(byPath)) {
      const read = await lidRead(root, realRoot, file);
      if (read.skipped) { skipped.push({ file, reason: read.skipped }); continue; }
      for (const entry of parseLidEntries(read.text, file, skipped)) {
        const first = seen.get(entry.id);
        if (first) fail('INVALID_SOURCE', `${entry.id} is defined twice: ${first.file}:${first.line} and ${entry.file}:${entry.line}; a linked-intent ID names one entry`);
        seen.set(entry.id, entry);
        entries.push(entry);
      }
    }
    skipped.sort((a, b) => byPath(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
    behaviors = entries.map(entry => ({ id: entry.id, kind: 'entry', title: entry.heading ? `${entry.heading} / ${entry.id}` : entry.id,
      text: entry.text, file: entry.file, fingerprint: fingerprint(entry.text), marker: entry.marker }));
    return behaviors;
  }
  return {
    name: 'lid',
    describe: () => ({ kind: 'lid' }),
    root,
    get skipped() { return skipped; },
    // One group holds every entry: the files are read once, as a whole, so duplicates are found.
    capabilities: async () => { await load(); return ['']; },
    read: () => load(),
    groupOf: () => '',
    noun: 'linked-intent entry',
    // A scope entry is an ID prefix of whole segments (`AUTH`, `AUTH-UI`) or one ID.
    scoped(entry, groups) {
      const behaviors = (groups.get('') ?? []).filter(behavior => behavior.id === entry || behavior.id.startsWith(`${entry}-`));
      if (!behaviors.length) return { error: `Scope names ${entry}, which is no ID or ID prefix of a linked-intent entry` };
      return { behaviors };
    },
  };
}

const sources = { openspec: openspecSource, lid: lidSource };
export const SOURCE_NAMES = Object.keys(sources);

// specSource is operations' store-rule-checked OpenSpec reader, passed in so the rule that
// decides which stores may be read lives in one place.
export async function openSource(selection, specSource) {
  if (!Object.hasOwn(sources, selection.kind)) fail('INVALID_INPUT', `Unknown behavior source: ${selection.kind} (supported: ${SOURCE_NAMES.join(', ')})`);
  if (selection.kind !== 'openspec' && selection.store !== undefined) fail('INVALID_INPUT', `A store applies only to the openspec source; the ${selection.kind} source reads the workspace repository`);
  return sources[selection.kind](await specSource(selection.store), selection);
}

// Behavior IDs are `<capability> / <title>`; capability IDs never contain " / ".
export const capabilityOf = id => (id.includes(' / ') ? id.slice(0, id.indexOf(' / ')) : id);

export async function listBehaviors(selection, specSource) {
  const source = await openSource(selection, specSource);
  const behaviors = [];
  for (const capability of await source.capabilities()) behaviors.push(...await source.read(capability));
  return { root: source.root, source: source.describe(), behaviors, ...(source.skipped === undefined ? {} : { skipped: source.skipped }) };
}
