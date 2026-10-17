import { mkdir, writeFile, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KIT_ROOT, loadHubs, context, skillFile } from './hubs.mjs';
import { fail, inside, localFile, readText, MAX_OUTPUT } from './files.mjs';

const notePattern = /^\d{13}-[0-9a-f-]{36}\.md$/;
export async function initWorkspace(path) {
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
    skills: ['kit:independent-review', 'kit:audit-canonical-specs'], links: [] }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(hub, 'README.md'), '# Personal context\n\nAdd durable context and preferences here. Captures stay in inbox until reviewed.\n', { flag: 'wx' });
  await writeFile(resolve(root, '.gitignore'), '.env\n.env.*\n.state/\n.DS_Store\n', { flag: 'wx' });
  return { root: await realpath(root), id: 'personal/main', initialized: true };
}

export async function selectRoot(value) {
  return { root: await realpath(resolve(value || KIT_ROOT)), explicit: Boolean(value) };
}
function findHub(hubs, id) {
  const hub = hubs.find(item => item.manifest.id === id);
  if (!hub) fail('UNKNOWN_HUB', `Unknown hub: ${id}`);
  return hub;
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
export async function validateWorkspace(root) {
  const hubs = await loadHubs(root);
  for (const hub of hubs) await notePaths(hub);
  return { root, valid: true, hubs: hubs.length };
}
export async function listHubs(root) {
  return { root, hubs: (await loadHubs(root)).map(({ manifest: { id, description } }) => ({ id, description })) };
}
export async function getContext(root, id, includeInbox = false) {
  const hubs = await loadHubs(root);
  const result = { root, ...await context(hubs, id) };
  if (includeInbox) {
    const hub = findHub(hubs, id);
    const paths = await notePaths(hub);
    const notes = [];
    let bytes = Buffer.byteLength(JSON.stringify(result));
    for (const path of paths.slice(0, 20)) {
      const content = await readText(await localFile(hub.root, path));
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_OUTPUT) break;
      notes.push({ path, content });
    }
    result.inbox = { status: 'unreviewed', total: paths.length, truncated: notes.length < paths.length, notes };
  }
  return result;
}
export async function getSkill(root, id, reference) {
  const hub = findHub(await loadHubs(root), id);
  if (!hub.manifest.skills.includes(reference)) fail('UNKNOWN_SKILL', 'Skill is not declared by this hub');
  return { root, id, reference, content: await readText(await skillFile(root, reference)) };
}
export async function search(root, query, includeInbox = false) {
  const results = [];
  let scanned = 0;
  for (const hub of await loadHubs(root)) {
    const paths = [...hub.manifest.documents, ...(includeInbox ? await notePaths(hub) : [])];
    for (const path of paths) {
      const content = await readText(await localFile(hub.root, path));
      scanned += Buffer.byteLength(content);
      if (scanned > 2 * 1024 * 1024) return { root, results, truncated: true };
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const index = lines[i].toLowerCase().indexOf(query.toLowerCase());
        if (index < 0) continue;
        if (results.length === 50) return { root, results, truncated: true };
        const start = Math.max(0, index - 80);
        results.push({ hub: hub.manifest.id, path, line: i + 1,
          status: path.startsWith('inbox/') ? 'unreviewed' : 'curated', snippet: lines[i].slice(start, start + 240) });
      }
    }
  }
  return { root, results, truncated: false };
}
export async function capture(selection, { id, title, body }, source) {
  const { root, explicit } = selection;
  if (!explicit || root === await realpath(KIT_ROOT)) fail('WRITE_DISABLED', 'Capture requires an explicit workspace outside the toolkit checkout');
  if (Buffer.byteLength(body) > 64 * 1024) fail('TOO_LARGE', 'Capture body exceeds 64 KiB');
  const hub = findHub(await loadHubs(root), id);
  const directory = await inboxDirectory(hub, true);
  const name = `${Date.now()}-${randomUUID()}.md`;
  const text = `# ${title}\n\nCreated: ${new Date().toISOString()}\nSource: ${source}\nStatus: unreviewed\n\n${body}\n`;
  await writeFile(resolve(directory, name), text, { flag: 'wx', mode: 0o600 });
  return { root, id, path: relative(root, resolve(directory, name)), status: 'unreviewed' };
}
