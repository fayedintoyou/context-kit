// Progressive disclosure over a hub's OKF bundle: browse one directory at a time and
// read one concept by its OKF ID (bundle-relative path without `.md`, OKF §2).
// Everything is answered from the file and directory sets collected while loading the
// hub; only the requested directory or concept is touched on disk.
import { lstat } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import { fail, readText } from './files.mjs';
import { hubFile, conceptRef } from './hubs.mjs';
import { splitFrontmatter, summarize, freshness } from './okf.mjs';
import { normalizeUpstream } from './repos.mjs';

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
  const text = await readText(await hubFile(hub, path));
  return (splitFrontmatter(text)?.body ?? text).trim();
}

function conceptEntry(hub, path) {
  const { summary } = summarize(hub.concepts.get(path));
  const description = summary.description?.length > DESCRIPTION ? summary.description.slice(0, DESCRIPTION - 1) + '…' : summary.description;
  return { id: path.slice(0, -3), ref: conceptRef(hub, path), ...summary, description, freshness: freshness(hub.concepts.get(path), hub.manifest.freshness),
    curated: hub.manifest.documents.includes(path), inbox: isInbox(path) };
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

// A path inside one hub, already normalized and confined: concept, directory, file or missing.
function within(hub, path) {
  if (hub.concepts.has(path)) return { kind: 'concept', hub: hub.manifest.id, id: path.slice(0, -3), ref: conceptRef(hub, path) };
  if (path === '' || hub.directories.has(path)) return { kind: 'directory', id: path };
  if (hub.files.has(path) && !path.endsWith('.md')) return { kind: 'file', path };
  return { kind: 'missing' };
}
const MOUNT_LINK = /^([a-z0-9]+(?:-[a-z0-9]+)*):\/(?!\/)(.*)$/;
const decoded = value => { try { return decodeURIComponent(value); } catch { return value; } };
// <mount>:/<concept-id>, with or without .md, in a declared mount. Only the loaded file set is
// consulted, so an unfetched, broken or shadowed mount is missing with a reason, never probed.
function mountLink(view, name, target) {
  const declared = view.mounts.find(mount => mount.name === name);
  const hub = view.hubs.find(item => item.mount?.name === name);
  if (!hub) return { kind: 'missing', mount: name, reason: declared.status === 'fetched' ? 'name-conflict' : declared.status };
  const id = decoded(target.replace(/[#?].*$/, '')).replace(/\.md$/, '');
  const parts = id.split('/');
  if (!id || parts.some(part => !part || part.startsWith('.') || /[\\\0]/.test(part))) return { kind: 'missing', mount: name, reason: 'invalid-id' };
  const found = within(hub, id + '.md');
  return found.kind === 'concept' ? found : { kind: 'missing', mount: name };
}
// A mounted link that leaves its bundle, resolved in its source repository from the mount's
// path: in the loaded mount of the same source whose path covers it (the deepest), else null.
function covered(view, hub, path) {
  const full = posix.normalize(posix.join(hub.mount.path, path));
  if (full === '..' || full.startsWith('../') || posix.isAbsolute(full)) return null;
  const source = normalizeUpstream(hub.mount.source);
  const covering = view.hubs.filter(item => item.mount && item !== hub && normalizeUpstream(item.mount.source) === source &&
    (!item.mount.path || full === item.mount.path || full.startsWith(item.mount.path + '/')))
    .sort((a, b) => b.mount.path.length - a.mount.path.length || byCodePoint(a.mount.name, b.mount.name))[0];
  if (!covering) return null;
  const found = within(covering, (covering.mount.path ? full.slice(covering.mount.path.length) : full).replace(/^\/+|\/$/g, ''));
  return { ...found, hub: covering.manifest.id, ...(found.kind === 'missing' ? { mount: covering.mount.name } : {}) };
}

// Kinds are fixed so federation only adds values: concept (with hub), directory, file,
// external, outside, missing. view ({ hubs, mounts }) resolves links into mounts.
function classify(hub, from, target, view) {
  const mount = target.match(MOUNT_LINK);
  if (mount && view?.mounts.some(item => item.name === mount[1])) return mountLink(view, mount[1], mount[2]);
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return { kind: 'external', url: target };
  let path = decoded(target.replace(/[#?].*$/, ''));
  path = path.startsWith('/') ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(parent(from), path));
  if (path === '..' || path.startsWith('../') || posix.isAbsolute(path)) return (hub.mount && view && covered(view, hub, path)) || { kind: 'outside' };
  return within(hub, path.replace(/\/$/, '').replace(/^\.$/, ''));
}

export async function read(hub, id, { includeInbox = false, frontmatter = false } = {}, view) {
  const concept = segments(id, 'concept ID');
  if (!concept) fail('INVALID_INPUT', 'Concept ID is empty');
  if (concept.endsWith('.md')) fail('INVALID_INPUT', `Concept IDs omit .md: ${concept.slice(0, -3)}`);
  const path = concept + '.md';
  if (isInbox(concept) && !includeInbox) fail('UNKNOWN_CONCEPT', 'Inbox notes are opt-in; request the inbox to read them');
  if (!hub.concepts.has(path)) {
    if (hub.files.has(path)) fail('NOT_A_CONCEPT', `Not an OKF concept: ${concept}`);
    fail('UNKNOWN_CONCEPT', `No concept: ${concept}`);
  }
  const { body } = splitFrontmatter(await readText(await hubFile(hub, path)));
  const { summary, warnings } = summarize(hub.concepts.get(path));
  return { id: concept, ref: conceptRef(hub, path), okf: summary, freshness: freshness(hub.concepts.get(path), hub.manifest.freshness), curated: hub.manifest.documents.includes(path), inbox: isInbox(path),
    ...(frontmatter ? { frontmatter: hub.concepts.get(path) } : {}),
    links: links(body).map(link => ({ ...link, ...classify(hub, path, link.target, view) })),
    warnings, content: body.replace(/^\n+/, '') };
}
