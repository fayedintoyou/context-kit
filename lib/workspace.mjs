import { mkdir, writeFile, realpath, lstat, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KIT_ROOT, loadHubs, context, skillFile, hubFile, conceptRef, parseRef, short } from './hubs.mjs';
import { loadMounts, unavailable, mountWarnings, refuseMountWrite } from './mounts.mjs';
import { fail, inside, readText, MAX_OUTPUT } from './files.mjs';
import { OKF_VERSION, concept, summarize, freshness, timestamp, isActor, splitFrontmatter } from './okf.mjs';
import * as navigate from './navigate.mjs';
import { loadAddons } from './addons.mjs';
import { registry } from './repos.mjs';
import { contextProblems, contextWarnings } from './repo-context.mjs';
import { git as runGit } from './git-env.mjs';
export const KIT_ACTOR = `context-kit/${JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version}`;

const notePattern = /^\d{13}-[0-9a-f-]{36}\.md$/;
// The core source a new instance pins: its repository at the current commit when this
// core is a clean git checkout, otherwise the repository's default branch, unpinned.
export async function coreSpec() {
  const { repository } = JSON.parse(await readFile(resolve(KIT_ROOT, 'package.json'), 'utf8'));
  const git = async args => (await runGit(KIT_ROOT, args, { timeout: 10000 })).stdout.trim();
  try {
    if (await realpath(await git(['rev-parse', '--show-toplevel'])) === await realpath(KIT_ROOT) &&
        !await git(['status', '--porcelain', '--untracked-files=no'])) {
      return { spec: `${repository}#${await git(['rev-parse', 'HEAD'])}`, pinned: true };
    }
  } catch { /* Not a git checkout, e.g. an installed copy. */ }
  return { spec: repository, pinned: false };
}
// Like coreSpec, but resolves the repository's current commit when not in a clean checkout.
export async function pinnedCoreSpec() {
  const core = await coreSpec();
  if (core.pinned) return core;
  const url = core.spec.replace(/^github:/, 'https://github.com/') + '.git';
  const { stdout } = await runGit(null, ['ls-remote', url, 'HEAD'], { timeout: 30000 });
  const sha = stdout.split(/\s/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) fail('ADAPTER_FAILED', `Could not resolve the core commit from ${url}`);
  return { spec: `${core.spec}#${sha}`, pinned: true };
}
export async function initWorkspace(path, { kit, addons } = {}) {
  if (kit !== undefined && (typeof kit !== 'string' || !/^\S{1,500}$/.test(kit))) fail('INVALID_INPUT', '--kit requires an npm dependency spec');
  const core = kit === undefined ? await coreSpec() : { spec: kit, pinned: true };
  const all = await loadAddons(KIT_ROOT);
  const catalog = all.filter(addon => addon.name !== 'core');
  const kitAddons = catalog.map(addon => addon.name);
  const enabled = addons ?? catalog.filter(addon => !addon.optIn).map(addon => addon.name);
  const unknown = enabled.filter(name => !kitAddons.includes(name));
  if (unknown.length) fail('INVALID_INPUT', `Unknown addons: ${unknown.join(', ')} (available: ${kitAddons.join(', ')})`);
  const root = resolve(path);
  try { await mkdir(root, { recursive: false }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('WORKSPACE_EXISTS', `Refusing to initialize an existing path: ${root}`);
    if (error.code === 'ENOENT') fail('INVALID_PATH', `Parent directory does not exist: ${root}`);
    throw error;
  }
  const hub = resolve(root, 'hubs', 'personal');
  await mkdir(hub, { recursive: true });
  await writeFile(resolve(hub, 'hub.json'), JSON.stringify({ version: 1, id: 'personal/main',
    description: 'My context, preferences and current projects.', documents: ['README.md'],
    skills: all.filter(addon => addon.name === 'core' || enabled.includes(addon.name)).flatMap(addon => addon.skills.map(skill => `kit:${skill.name}`)), links: [] }, null, 2) + '\n', { flag: 'wx' });
  const generated = { by: KIT_ACTOR, at: timestamp() };
  await writeFile(resolve(hub, 'README.md'), concept({ type: 'Guide', title: 'Personal context',
    description: 'Durable context and preferences for this workspace.', generated },
  '# Personal context\n\nAdd durable context and preferences here. Captures stay in inbox until reviewed.\n'), { flag: 'wx' });
  await writeFile(resolve(hub, 'index.md'), `---\nokf_version: "${OKF_VERSION}"\n---\n\n# Personal context\n\n* [Personal context](README.md) - Durable context and preferences for this workspace.\n`, { flag: 'wx' });
  await writeFile(resolve(root, '.gitignore'), 'node_modules/\n.env\n.env.*\n.state/\n.DS_Store\n', { flag: 'wx' });
  // The workspace is an instance of the core: it pins a core version and runs it against itself.
  const name = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'context';
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name, private: true, type: 'module',
    scripts: { hub: 'context-kit --root .', mcp: 'context-kit-mcp --root .', validate: 'context-kit --root . validate', agents: 'context-kit --root . agents' },
    dependencies: { 'context-kit': core.spec } }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(root, 'context-kit.json'), JSON.stringify({ version: 1, addons: enabled }, null, 2) + '\n', { flag: 'wx' });
  return { root: await realpath(root), id: 'personal/main', initialized: true, core, addons: enabled,
    next: 'Run npm install in the workspace, then npm run agents -- install' };
}

export async function selectRoot(value) {
  return { root: await realpath(resolve(value || KIT_ROOT)), explicit: Boolean(value) };
}
// Workspace hubs, then fetched mounts by name, side by side and never merged: each keeps its
// own bundle (index, log, okf_version, concept IDs). A mount that is not loaded, or is named
// like a workspace hub, is left out with a warning, so it never breaks the other hubs.
export async function loadView(root) {
  const hubs = await loadHubs(root, { allowEmpty: true });
  const ids = new Set(hubs.map(hub => hub.manifest.id));
  const mounts = await loadMounts(root);
  const warnings = mountWarnings(mounts);
  for (const mount of mounts.filter(item => item.hub)) {
    if (ids.has(mount.name)) warnings.push(`mount ${mount.name} is named like a workspace hub and is not read; run mounts remove ${mount.name}, then mounts add it under another name`);
    else hubs.push(mount.hub);
  }
  if (!hubs.length) fail('NO_HUBS', 'No hubs found');
  // A mounted manifest's links are offered only to hubs present here.
  const present = new Set(hubs.map(hub => hub.manifest.id));
  for (const hub of hubs.filter(item => item.mount)) {
    hub.manifest.links = hub.links.filter(link => present.has(link));
    for (const link of hub.links.filter(item => !present.has(item))) hub.warnings.push(`hub.json: linked hub ${short(link)} is not a hub here; ignored`);
  }
  return { hubs, mounts, warnings };
}
const provenance = hub => hub.mount ? { mount: hub.mount } : {};
const withWarnings = warnings => warnings.length ? { warnings } : {};
function findHub({ hubs, mounts }, id) {
  const hub = hubs.find(item => item.manifest.id === id);
  if (hub) return hub;
  const mount = mounts.find(item => item.name === id);
  if (mount) unavailable(mount);
  fail('UNKNOWN_HUB', `Unknown hub: ${id}`);
}
async function inboxDirectory(hub, create = false) {
  const path = resolve(hub.root, 'inbox');
  if (create) {
    try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) fail('PATH_ESCAPE', 'Inbox must be a real directory');
  return inside(hub.root, path);
}
async function notePaths(hub) {
  const directory = await inboxDirectory(hub);
  if (!directory) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !notePattern.test(entry.name)) fail('INVALID_INBOX', `Invalid inbox entry: ${entry.name}`);
  }
  return entries.map(entry => `inbox/${entry.name}`).sort().reverse();
}
// A hub's inbox note paths. A mount's inbox is someone else's: one that is not a real
// directory of notes is skipped with a warning naming only the mount.
async function readableNotes(hub, warnings) {
  if (!hub.mount) return notePaths(hub);
  try { return await notePaths(hub); }
  catch { warnings.push(`mount ${hub.mount.name}: inbox skipped: it is not a directory holding only inbox notes`); return []; }
}
// A file's text, or, in a mount, null with a warning when it cannot be read (too large, not
// UTF-8, gone), so one bad file never fails the read of every hub.
async function noteText(hub, path, warnings) {
  try { return await readText(await hubFile(hub, path)); }
  catch (error) {
    if (!hub.mount) throw error;
    warnings.push(`mount ${hub.mount.name}: ${path} skipped: not a readable file`);
    return null;
  }
}
// Workspace hubs strictly, since the person can fix them; mounts leniently, their problems
// (and unfetched or broken mounts) as warnings naming the mount, never failures.
export async function validateWorkspace(root) {
  const hubs = await loadHubs(root, { strict: true });
  for (const hub of hubs) await notePaths(hub);
  const { problems } = registry(hubs);
  if (problems.length) fail('INVALID_REPOSITORY', problems.join('; '));
  // A Repository's `context`: its closed schema, bounds and references (repository-context).
  const context = await contextProblems(root, hubs);
  if (context.length) fail('INVALID_CONTEXT', context.join('; '));
  const mounts = await loadMounts(root);
  const warnings = [...mountWarnings(mounts), ...mounts.filter(mount => mount.hub).flatMap(mount => mount.hub.warnings.map(warning => `${mount.name}: ${warning}`)),
    ...await contextWarnings(root, hubs)];
  return { root, valid: true, hubs: hubs.length, ...withWarnings(warnings) };
}
export async function listHubs(root) {
  const { hubs, warnings } = await loadView(root);
  return { root, hubs: hubs.map(({ manifest: { id, description }, manifestId, mount }) => ({ id, description, ...(mount ? { manifestId, mount } : {}) })),
    ...withWarnings(warnings) };
}
export async function getContext(root, id, includeInbox = false) {
  const hub = findHub(await loadView(root), id);
  const result = { root, ...await context(hub) };
  if (includeInbox) {
    const paths = await readableNotes(hub, result.warnings);
    const notes = [];
    let bytes = Buffer.byteLength(JSON.stringify(result));
    for (const path of paths.slice(0, 20)) {
      const content = await noteText(hub, path, result.warnings);
      if (content === null) continue;
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_OUTPUT) break;
      notes.push({ path, ref: conceptRef(hub, path), okf: hub.concepts.has(path) ? summarize(hub.concepts.get(path)).summary : null, content });
    }
    result.inbox = { status: 'unreviewed', total: paths.length, truncated: notes.length < paths.length, notes };
  }
  return result;
}
export async function browseHub(root, id, path, options) {
  const hub = findHub(await loadView(root), id);
  return { root, hub: id, ...provenance(hub), ...await navigate.browse(hub, path, options) };
}
// concept may be a reference, <hub-id>:/<concept-id>, in place of the hub and concept.
export async function readConcept(root, id, concept, options) {
  const ref = parseRef(concept);
  if (ref) {
    if (id !== undefined && id !== ref.hub) fail('INVALID_INPUT', `Hub ${id} differs from the reference's hub ${ref.hub}; give the reference alone`);
    [id, concept] = [ref.hub, ref.concept];
  } else if (id === undefined) fail('INVALID_INPUT', 'Give a hub and a concept ID, or a reference <hub-id>:/<concept-id>');
  const view = await loadView(root);
  const hub = findHub(view, id);
  return { root, hub: id, ...provenance(hub), ...await navigate.read(hub, concept, options, view) };
}
export async function getSkill(root, id, reference, file = 'SKILL.md') {
  const hub = findHub(await loadView(root), id);
  if (!hub.manifest.skills.includes(reference)) fail('UNKNOWN_SKILL', 'Skill is not declared by this hub');
  return { root, id, reference, file, content: await readText(await skillFile(root, reference, file)) };
}
// Each declared skill once, with its Agent Skills name and description.
export async function listSkills(root) {
  const skills = new Map();
  // Bundled skills are listed only when an enabled addon provides them.
  const provided = new Set((await loadAddons(root)).filter(addon => addon.enabled && addon.source === 'kit').flatMap(addon => addon.skills.map(skill => `kit:${skill.name}`)));
  for (const hub of await loadHubs(root)) {
    for (const reference of hub.manifest.skills.filter(item => !item.startsWith('kit:') || provided.has(item))) {
      if (!skills.has(reference)) {
        const front = splitFrontmatter(await readText(await skillFile(root, reference)));
        const data = front && !front.error ? front.data : {};
        skills.set(reference, { reference, name: typeof data.name === 'string' ? data.name : reference.replace(/^kit:|\/SKILL\.md$/g, '').split('/').pop(),
          description: typeof data.description === 'string' ? data.description : '', hubs: [] });
      }
      skills.get(reference).hubs.push(hub.manifest.id);
    }
  }
  return { root, skills: [...skills.values()] };
}
// Workspace hubs, then mounts, within one scan budget and result limit.
export async function search(root, query, includeInbox = false) {
  const results = [];
  let scanned = 0;
  const { hubs, warnings } = await loadView(root);
  const done = truncated => ({ root, results, truncated, ...withWarnings(warnings) });
  for (const hub of hubs) {
    // Every concept, curated documents first; inbox notes only on request.
    const others = [...hub.concepts.keys()].filter(path => !hub.manifest.documents.includes(path) && !path.startsWith('inbox/')).sort();
    const notes = includeInbox ? await readableNotes(hub, warnings) : [];
    const paths = [...hub.manifest.documents, ...others, ...notes];
    for (const path of paths) {
      const content = await noteText(hub, path, warnings);
      if (content === null) continue;
      scanned += Buffer.byteLength(content);
      if (scanned > 2 * 1024 * 1024) return done(true);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const index = lines[i].toLowerCase().indexOf(query.toLowerCase());
        if (index < 0) continue;
        if (results.length === 50) return done(true);
        const start = Math.max(0, index - 80);
        results.push({ hub: hub.manifest.id, ...provenance(hub), id: path.slice(0, -3), ref: conceptRef(hub, path), path, line: i + 1,
          curated: hub.manifest.documents.includes(path), inbox: path.startsWith('inbox/'),
          okf: hub.concepts.has(path) ? summarize(hub.concepts.get(path)).summary : null,
          freshness: hub.concepts.has(path) ? freshness(hub.concepts.get(path), hub.manifest.freshness) : null, snippet: lines[i].slice(start, start + 240) });
      }
    }
  }
  return done(false);
}
export async function capture(selection, { id, title, body }) {
  const { root, explicit, actor } = selection;
  if (!isActor(actor)) fail('INVALID_INPUT', 'Capture needs an actor such as human:<id>, process:<id> or <producer>/<version>');
  const offset = relative(await realpath(KIT_ROOT), root);
  const inKit = !offset || (offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset));
  if (!explicit || inKit) fail('WRITE_DISABLED', 'Capture requires an explicit workspace outside the toolkit checkout');
  if (Buffer.byteLength(body) > 64 * 1024) fail('TOO_LARGE', 'Capture body exceeds 64 KiB');
  await refuseMountWrite(root, id); // Before anything else, so a mount is always READ_ONLY_MOUNT.
  const hub = findHub({ hubs: await loadHubs(root), mounts: [] }, id);
  const directory = await inboxDirectory(hub, true);
  const name = `${Date.now()}-${randomUUID()}.md`;
  // An OKF draft concept with no verification: the inbox is the review boundary.
  const text = concept({ type: 'Note', title, status: 'draft', generated: { by: actor, at: timestamp() } }, `# ${title}\n\n${body}\n`);
  await writeFile(resolve(directory, name), text, { flag: 'wx', mode: 0o600 });
  return { root, id, path: relative(root, resolve(directory, name)), status: 'unreviewed' };
}
