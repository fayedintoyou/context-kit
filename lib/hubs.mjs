import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const fields = ['version', 'id', 'description', 'documents', 'skills', 'links'];
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export async function localFile(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) {
    throw new Error(`Expected a relative file path: ${path}`);
  }
  const base = await realpath(root);
  const file = await realpath(resolve(base, path));
  const offset = relative(base, file);
  if (offset === '..' || offset.startsWith('../') || isAbsolute(offset)) {
    throw new Error(`Path escapes its root: ${path}`);
  }
  if (!(await stat(file)).isFile()) throw new Error(`Not a file: ${path}`);
  return file;
}

export async function loadHubs(root) {
  const hubs = [];
  for (const category of ['hubs', 'examples']) {
    const directory = resolve(root, category);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const path = `${category}/${entry.name}/hub.json`;
      const file = await localFile(root, path);
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`Invalid manifest: ${path}`);
      }
      if (Object.keys(manifest).some(key => !fields.includes(key)) ||
          fields.some(key => !Object.hasOwn(manifest, key))) {
        throw new Error(`Unexpected or missing fields: ${path}`);
      }
      if (manifest.version !== 1 || typeof manifest.id !== 'string' ||
          !idPattern.test(manifest.id) || typeof manifest.description !== 'string' ||
          !manifest.description.trim()) throw new Error(`Invalid identity/version: ${path}`);
      for (const field of ['documents', 'skills', 'links']) {
        const values = manifest[field];
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value) ||
            new Set(values).size !== values.length) throw new Error(`Invalid ${field}: ${path}`);
      }
      if (!manifest.documents.length) throw new Error(`No documents: ${path}`);
      const hubRoot = resolve(directory, entry.name);
      for (const document of manifest.documents) {
        if (!document.endsWith('.md')) throw new Error(`Expected Markdown: ${document}`);
        await localFile(hubRoot, document);
      }
      for (const skill of manifest.skills) {
        if (!skill.endsWith('/SKILL.md')) throw new Error(`Expected SKILL.md: ${skill}`);
        await localFile(root, skill);
      }
      if (hubs.some(hub => hub.manifest.id === manifest.id)) {
        throw new Error(`Duplicate hub ID: ${manifest.id}`);
      }
      hubs.push({ manifest, root: hubRoot });
    }
  }
  if (!hubs.length) throw new Error('No hubs found');
  const ids = new Set(hubs.map(hub => hub.manifest.id));
  for (const hub of hubs) {
    for (const link of hub.manifest.links) {
      if (!ids.has(link)) throw new Error(`Unknown linked hub: ${link}`);
    }
  }
  return hubs;
}

export async function context(hubs, id) {
  const hub = hubs.find(item => item.manifest.id === id);
  if (!hub) throw new Error(`Unknown hub: ${id}`);
  const documents = [];
  for (const path of hub.manifest.documents) {
    const file = await localFile(hub.root, path);
    documents.push({ path, content: await readFile(file, 'utf8') });
  }
  return { manifest: hub.manifest, documents };
}
