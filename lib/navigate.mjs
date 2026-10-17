// Progressive disclosure over a hub's OKF bundle: browse one directory at a time and
// read one concept by its OKF ID (bundle-relative path without `.md`, OKF §2).
// Everything is answered from the file and directory sets collected while loading the
// hub; only the requested directory or concept is touched on disk.
import { lstat } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import { fail, localFile, readText } from './files.mjs';
import { splitFrontmatter, summarize } from './okf.mjs';

const PAGE = 200;
const DESCRIPTION = 300;
const INDEX = 16 * 1024;
const isInbox = path => path === 'inbox' || path.startsWith('inbox/');
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const parent = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// '' for the hub root, otherwise 'a/b'; no dot segments, no traversal.
function segments(value, label) {
  if (typeof value !== 'string' || value.length > 500) fail('INVALID_INPUT', `Invalid ${label}`);
  const clean = value.replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  const parts = clean.split('/');
  if (parts.some(part => !part || part.startsWith('.') || /[\\\0]/.test(part))) fail('INVALID_PATH', `Invalid ${label}: ${value}`);
  return parts.join('/');
}

async function indexOf(hub, directory) {
  const path = (directory ? directory + '/' : '') + 'index.md';
  if (!hub.files.has(path)) return null;
  const text = await readText(await localFile(hub.root, path));
  return (splitFrontmatter(text)?.body ?? text).trim();
}

function conceptEntry(hub, path) {
  const { summary } = summarize(hub.concepts.get(path));
  const description = summary.description?.length > DESCRIPTION ? summary.description.slice(0, DESCRIPTION - 1) + '…' : summary.description;
  return { id: path.slice(0, -3), ...summary, description, curated: hub.manifest.documents.includes(path), inbox: isInbox(path) };
}

export async function browse(hub, path = '', { includeInbox = false, offset = 0 } = {}) {
  const directory = segments(path, 'directory');
  if (isInbox(directory) && !includeInbox) fail('UNKNOWN_PATH', 'Inbox notes are opt-in; request the inbox to browse it');
  if (directory && !hub.directories.has(directory)) {
    let info;
    try { info = await lstat(resolve(hub.root, directory)); } catch { /* Missing. */ }
    if (info?.isSymbolicLink()) fail('PATH_ESCAPE', `Symlinked directory: ${directory}`);
    fail('UNKNOWN_PATH', info ? `Not a directory: ${directory}` : `No such directory: ${directory}`);
  }
  const visible = path => includeInbox || !isInbox(path);
  const children = [...hub.directories].filter(path => parent(path) === directory && visible(path)).sort(byCodePoint);
  const concepts = [...hub.concepts.keys()].filter(path => parent(path) === directory && visible(path)).sort(byCodePoint);
  const directories = [];
  for (const id of children.slice(offset, offset + PAGE)) {
    const index = await indexOf(hub, id);
    directories.push({ id, concepts: [...hub.concepts.keys()].filter(path => path.startsWith(id + '/')).length,
      title: index?.match(/^#\s+(.+)$/m)?.[1] ?? null, inbox: isInbox(id) });
  }
  let index = await indexOf(hub, directory);
  const indexTruncated = index !== null && Buffer.byteLength(index) > INDEX;
  if (indexTruncated) index = Buffer.from(index).subarray(0, INDEX).toString('utf8').replace(/�$/, '');
  return { path: directory, index, indexTruncated,
    directories, concepts: concepts.slice(offset, offset + PAGE).map(path => conceptEntry(hub, path)),
    totals: { directories: children.length, concepts: concepts.length }, offset,
    truncated: Math.max(children.length, concepts.length) > offset + PAGE,
    warnings: hub.warnings.filter(warning => parent(warning.slice(0, warning.indexOf(':'))) === directory) };
}

// Inline Markdown links outside code; images and same-document anchors are skipped.
function links(body) {
  const prose = body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
  const found = new Map();
  for (const match of prose.matchAll(/(?<!!)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (!match[2].startsWith('#') && !found.has(match[2])) found.set(match[2], match[1]);
  }
  return [...found].map(([target, text]) => ({ text, target }));
}

// Kinds are fixed so federation only adds values: concept (with hub), directory, file,
// external, outside, missing.
function classify(hub, from, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return { kind: 'external', url: target };
  let path = target.replace(/[#?].*$/, '');
  try { path = decodeURIComponent(path); } catch { /* Keep the raw target. */ }
  path = path.startsWith('/') ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(parent(from), path));
  if (path === '..' || path.startsWith('../') || posix.isAbsolute(path)) return { kind: 'outside' };
  path = path.replace(/\/$/, '').replace(/^\.$/, '');
  if (hub.concepts.has(path)) return { kind: 'concept', hub: hub.manifest.id, id: path.slice(0, -3) };
  if (path === '' || hub.directories.has(path)) return { kind: 'directory', id: path };
  if (hub.files.has(path) && !path.endsWith('.md')) return { kind: 'file', path };
  return { kind: 'missing' };
}

export async function read(hub, id, { includeInbox = false, frontmatter = false } = {}) {
  const concept = segments(id, 'concept ID');
  if (!concept) fail('INVALID_INPUT', 'Concept ID is empty');
  if (concept.endsWith('.md')) fail('INVALID_INPUT', `Concept IDs omit .md: ${concept.slice(0, -3)}`);
  const path = concept + '.md';
  if (isInbox(concept) && !includeInbox) fail('UNKNOWN_CONCEPT', 'Inbox notes are opt-in; request the inbox to read them');
  if (!hub.concepts.has(path)) {
    if (hub.files.has(path)) fail('NOT_A_CONCEPT', `Not an OKF concept: ${concept}`);
    fail('UNKNOWN_CONCEPT', `No concept: ${concept}`);
  }
  const { body } = splitFrontmatter(await readText(await localFile(hub.root, path)));
  const { summary, warnings } = summarize(hub.concepts.get(path));
  return { id: concept, okf: summary, curated: hub.manifest.documents.includes(path), inbox: isInbox(path),
    ...(frontmatter ? { frontmatter: hub.concepts.get(path) } : {}),
    links: links(body).map(link => ({ ...link, ...classify(hub, path, link.target) })),
    warnings, content: body.replace(/^\n+/, '') };
}
