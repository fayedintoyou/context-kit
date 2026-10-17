import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFile, inside, readText, fail, MAX_OUTPUT } from './files.mjs';
import { checkBundle, summarize, OKF_VERSION } from './okf.mjs';
export { localFile } from './files.mjs';
export const KIT_ROOT = fileURLToPath(new URL('../', import.meta.url));

const fields = ['version', 'id', 'description', 'documents', 'skills', 'links'];
const optionalFields = ['specStores'];
const storePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export async function skillFile(root, reference) {
  if (reference.startsWith('kit:')) {
    const name = reference.slice(4);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail('INVALID_PATH', 'Invalid bundled skill name');
    return localFile(KIT_ROOT, `skills/${name}/SKILL.md`);
  }
  if (!reference.endsWith('/SKILL.md')) fail('INVALID_PATH', `Expected SKILL.md: ${reference}`);
  return localFile(root, reference);
}

// Strict loading (validation) fails on any OKF problem; lenient loading (reads) fails only
// when a curated document is not a concept, and keeps other problems as warnings.
export async function loadHubs(root, { strict = false } = {}) {
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
    await inside(root, directory);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) fail('PATH_ESCAPE', `Symlinked hub directory: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const path = `${category}/${entry.name}/hub.json`;
      const file = await localFile(root, path);
      let manifest;
      try { manifest = JSON.parse(await readText(file)); }
      catch (error) { fail(['NOT_FOUND', 'TOO_LARGE', 'INVALID_UTF8', 'PATH_ESCAPE'].includes(error.code) ? error.code : 'INVALID_MANIFEST', `${path}: ${error.message}`); }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        fail('INVALID_MANIFEST', `Invalid manifest: ${path}`);
      }
      if (Object.keys(manifest).some(key => !fields.includes(key) && !optionalFields.includes(key)) ||
          fields.some(key => !Object.hasOwn(manifest, key))) {
        fail('INVALID_MANIFEST', `Unexpected or missing fields: ${path}`);
      }
      if (manifest.version !== 1 || typeof manifest.id !== 'string' ||
          !idPattern.test(manifest.id) || typeof manifest.description !== 'string' ||
          !manifest.description.trim()) fail('INVALID_MANIFEST', `Invalid identity/version: ${path}`);
      for (const field of ['documents', 'skills', 'links']) {
        const values = manifest[field];
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value) ||
            new Set(values).size !== values.length) fail('INVALID_MANIFEST', `Invalid ${field}: ${path}`);
      }
      if (Object.hasOwn(manifest, 'specStores')) {
        const stores = manifest.specStores;
        if (!Array.isArray(stores) || stores.some(store => typeof store !== 'string' || store.length > 64 ||
            !storePattern.test(store)) || new Set(stores).size !== stores.length) {
          fail('INVALID_MANIFEST', `Invalid specStores: ${path}`);
        }
      }
      if (!manifest.documents.length) fail('INVALID_MANIFEST', `No documents: ${path}`);
      const hubRoot = resolve(directory, entry.name);
      for (const document of manifest.documents) {
        if (document.split('/').includes('inbox')) fail('INVALID_MANIFEST', 'Inbox notes cannot be curated documents');
        if (!document.endsWith('.md')) fail('INVALID_MANIFEST', `Expected Markdown: ${document}`);
        await localFile(hubRoot, document);
      }
      for (const skill of manifest.skills) {
        await skillFile(root, skill);
      }
      if (hubs.some(hub => hub.manifest.id === manifest.id)) {
        fail('INVALID_MANIFEST', `Duplicate hub ID: ${manifest.id}`);
      }
      // The hub directory is an OKF bundle; hub.json carries only Context Kit fields.
      const { concepts, problems, okfVersion } = await checkBundle(hubRoot);
      const blocking = strict ? problems : problems.filter(problem => manifest.documents.includes(problem.path));
      if (blocking.length) {
        fail('INVALID_OKF', blocking.map(problem => `${category}/${entry.name}/${problem.path}: ${problem.message}`).join('; '));
      }
      const warnings = problems.map(problem => `${problem.path}: ${problem.message}`);
      if (okfVersion !== null && okfVersion !== OKF_VERSION) warnings.push(`index.md declares okf_version ${okfVersion}; read as ${OKF_VERSION}`);
      hubs.push({ manifest, root: hubRoot, concepts, okfVersion, warnings });
    }
  }
  if (!hubs.length) fail('NO_HUBS', 'No hubs found');
  const ids = new Set(hubs.map(hub => hub.manifest.id));
  for (const hub of hubs) {
    for (const link of hub.manifest.links) {
      if (!ids.has(link)) fail('INVALID_MANIFEST', `Unknown linked hub: ${link}`);
    }
  }
  return hubs;
}

export async function context(hubs, id) {
  const hub = hubs.find(item => item.manifest.id === id);
  if (!hub) fail('UNKNOWN_HUB', `Unknown hub: ${id}`);
  const documents = [];
  let bytes = 0;
  for (const path of hub.manifest.documents) {
    const file = await localFile(hub.root, path);
    const content = await readText(file);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_OUTPUT) fail('TOO_LARGE', 'Context exceeds 128 KiB; narrow the hub documents');
    const { summary, warnings } = summarize(hub.concepts.get(path));
    documents.push({ path, okf: summary, content });
    for (const warning of warnings) hub.warnings.push(`${path}: ${warning}`);
  }
  return { manifest: hub.manifest, okfVersion: hub.okfVersion, warnings: hub.warnings, documents };
}
