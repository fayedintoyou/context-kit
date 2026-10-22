import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFile, realFile, inside, readText, fail, MAX_OUTPUT } from './files.mjs';
import { checkBundle, summarize, freshness, isDuration, OKF_VERSION } from './okf.mjs';
export { localFile } from './files.mjs';
export const KIT_ROOT = fileURLToPath(new URL('../', import.meta.url));

const fields = ['version', 'id', 'description', 'documents', 'skills', 'links'];
const optionalFields = ['specStores', 'freshness'];
const storePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

// A skill's SKILL.md, or another Markdown file inside the skill's own directory.
export async function skillFile(root, reference, file = 'SKILL.md') {
  if (typeof file !== 'string' || !file.endsWith('.md') || file.split('/').some(part => !part || part.startsWith('.') || /[\\\0]/.test(part))) {
    fail('INVALID_PATH', `Skill files are Markdown paths inside the skill directory: ${file}`);
  }
  let directory;
  if (reference.startsWith('kit:')) {
    const name = reference.slice(4);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail('INVALID_PATH', 'Invalid bundled skill name');
    directory = await localDirectory(KIT_ROOT, `skills/${name}`);
  } else {
    if (!reference.endsWith('/SKILL.md')) fail('INVALID_PATH', `Expected SKILL.md: ${reference}`);
    directory = await localDirectory(root, reference.slice(0, -'/SKILL.md'.length));
  }
  return localFile(directory, file);
}
async function localDirectory(root, path) {
  await localFile(root, `${path}/SKILL.md`);
  return inside(root, resolve(root, path));
}

// A manifest's Context Kit fields; INVALID_MANIFEST naming path otherwise.
function checkManifest(manifest, path) {
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
  if (Object.hasOwn(manifest, 'freshness')) {
    const policy = manifest.freshness;
    const invalid = message => fail('INVALID_MANIFEST', `Invalid freshness in ${path}: ${message}`);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) invalid('expected an object');
    const unknown = Object.keys(policy).filter(key => !['default', 'types'].includes(key));
    if (unknown.length) invalid(`unknown keys ${unknown.join(', ')}`);
    if (policy.default !== undefined && !isDuration(policy.default)) invalid(`default ${JSON.stringify(policy.default)} is not an ISO 8601 duration`);
    if (policy.types !== undefined) {
      if (!policy.types || typeof policy.types !== 'object' || Array.isArray(policy.types)) invalid('types must map OKF types to durations');
      for (const [type, age] of Object.entries(policy.types)) if (!isDuration(age)) invalid(`${type}: ${JSON.stringify(age)} is not an ISO 8601 duration`);
    }
  }
  if (!manifest.documents.length) fail('INVALID_MANIFEST', `No documents: ${path}`);
  for (const document of manifest.documents) {
    if (document.split('/').includes('inbox')) fail('INVALID_MANIFEST', 'Inbox notes cannot be curated documents');
    if (!document.endsWith('.md')) fail('INVALID_MANIFEST', `Expected Markdown: ${document}`);
  }
}
const okfWarnings = (problems, okfVersion) => [...problems.map(problem => `${problem.path}: ${problem.message}`),
  ...(okfVersion !== null && okfVersion !== OKF_VERSION ? [`index.md declares okf_version ${okfVersion}; read as ${OKF_VERSION}`] : [])];

// Workspace hubs, from the workspace's own hubs/ and examples/. Strict loading (validation)
// fails on any OKF problem; lenient loading (reads) fails only when a curated document is not
// a concept, and keeps other problems as warnings. Mounted hubs load separately (loadMountedHub).
export async function loadHubs(root, { strict = false, allowEmpty = false } = {}) {
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
      checkManifest(manifest, path);
      const hubRoot = resolve(directory, entry.name);
      for (const document of manifest.documents) await localFile(hubRoot, document);
      for (const skill of manifest.skills) {
        await skillFile(root, skill);
      }
      if (hubs.some(hub => hub.manifest.id === manifest.id)) {
        fail('INVALID_MANIFEST', `Duplicate hub ID: ${manifest.id}`);
      }
      // The hub directory is an OKF bundle; hub.json carries only Context Kit fields.
      const { concepts, problems, okfVersion, files, directories } = await checkBundle(hubRoot);
      const blocking = strict ? problems : problems.filter(problem => manifest.documents.includes(problem.path));
      if (blocking.length) {
        fail('INVALID_OKF', blocking.map(problem => `${category}/${entry.name}/${problem.path}: ${problem.message}`).join('; '));
      }
      hubs.push({ manifest, root: hubRoot, concepts, okfVersion, warnings: okfWarnings(problems, okfVersion), files, directories });
    }
  }
  if (!hubs.length && !allowEmpty) fail('NO_HUBS', 'No hubs found');
  const ids = new Set(hubs.map(hub => hub.manifest.id));
  for (const hub of hubs) {
    for (const link of hub.manifest.links) {
      if (!ids.has(link)) fail('INVALID_MANIFEST', `Unknown linked hub: ${link}`);
    }
  }
  return hubs;
}

// A mounted hub: an exported tree that is someone else's bundle, loaded only leniently, since
// the workspace cannot fix it. Its hub ID is the mount name (the manifest's own id is
// manifestId); its skills and spec stores are never offered and its links are resolved by the
// caller, so all three become warnings. Not a loadable hub (no or invalid hub.json, a curated
// document that is not a concept): MOUNT_BROKEN with the reason. Skipped names entries the
// export left out (symlinks, submodules), which are warned about too.
export async function loadMountedHub(directory, mount, skipped = []) {
  // Reasons may quote the mounted manifest, which is someone else's: keep them short.
  const broken = reason => fail('MOUNT_BROKEN', reason.length > 300 ? reason.slice(0, 299) + '…' : reason);
  let manifest;
  try { manifest = JSON.parse(await readText(await realFile(directory, 'hub.json'))); }
  catch (error) { broken(error.code === 'NOT_FOUND' ? 'no hub.json at the mounted path' : 'hub.json is not a readable JSON manifest'); }
  try { checkManifest(manifest, 'hub.json'); } catch (error) { broken(error.message); }
  let bundle;
  try { bundle = await checkBundle(directory, { tolerant: true }); }
  catch (error) { broken(error.code === 'TOO_LARGE' ? error.message.replace(/: \/.*$/, '') : 'the bundle could not be read'); }
  const { concepts, problems, okfVersion, files, directories } = bundle;
  for (const document of manifest.documents) {
    if (concepts.has(document)) continue;
    const problem = problems.find(item => item.path === document);
    broken(`${document.slice(0, 200)}: curated document is not an OKF concept${problem ? ` (${problem.message})` : files.has(document) ? '' : ' (missing)'}`);
  }
  const warnings = okfWarnings(problems, okfVersion);
  for (const path of skipped) warnings.push(`${path}: not exported (a symlink, a submodule or a top-level .mount.json in the source repository)`);
  for (const skill of manifest.skills) warnings.push(`hub.json: skill ${short(skill)} is not offered from a mount`);
  for (const store of manifest.specStores ?? []) warnings.push(`hub.json: spec store ${store} is not offered from a mount`);
  return { manifest: { ...manifest, id: mount.name, skills: [], links: [], specStores: [] }, manifestId: manifest.id, links: manifest.links,
    mount: { name: mount.name, source: mount.source, path: mount.path, commit: mount.commit },
    root: directory, concepts, okfVersion, warnings, files, directories };
}

// A value quoted from someone else's manifest, kept short.
export const short = value => value.length > 200 ? value.slice(0, 199) + '…' : value;
// A file of a hub, confined to it; a mounted hub's path may hold no symlink at all.
export const hubFile = (hub, path) => (hub.mount ? realFile : localFile)(hub.root, path);
export const conceptRef = (hub, path) => `${hub.manifest.id}:/${path.slice(0, -3)}`;
// <hub-id>:/<concept-id>, split at the first ':/' (hub IDs never hold ':'); null otherwise.
export function parseRef(value) {
  const at = typeof value === 'string' ? value.indexOf(':/') : -1;
  if (at <= 0 || !idPattern.test(value.slice(0, at))) return null;
  return { hub: value.slice(0, at), concept: value.slice(at + 2) };
}

export async function context(hub) {
  const documents = [];
  let bytes = 0;
  for (const path of hub.manifest.documents) {
    const file = await hubFile(hub, path);
    const content = await readText(file);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_OUTPUT) fail('TOO_LARGE', 'Context exceeds 128 KiB; narrow the hub documents');
    const { summary, warnings } = summarize(hub.concepts.get(path));
    documents.push({ path, ref: conceptRef(hub, path), okf: summary, freshness: freshness(hub.concepts.get(path), hub.manifest.freshness), content });
    for (const warning of warnings) hub.warnings.push(`${path}: ${warning}`);
  }
  return { manifest: hub.manifest, ...(hub.mount ? { manifestId: hub.manifestId, mount: hub.mount } : {}), okfVersion: hub.okfVersion, warnings: hub.warnings,
    browse: { hub: hub.manifest.id, path: '' }, documents };
}
