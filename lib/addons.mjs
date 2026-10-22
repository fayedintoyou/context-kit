// Addons group Context Kit functionality. `core` is always on; kit addons add operations
// and skills; workspace addons (addons/<name>/addon.json in a workspace) carry skills only.
// A workspace's context-kit.json names the enabled addons.
import { readdir, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KIT_ROOT } from './hubs.mjs';
import { fail, inside, localFile } from './files.mjs';
import { mountProblems } from './mounts.mjs';

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const kitFields = ['name', 'description', 'skills', 'operations'];
const workspaceFields = ['name', 'description', 'skills'];

async function readJson(path, code) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    fail(code, `${path}: ${error.message}`);
  }
}

async function scan(base, source) {
  let entries;
  try { entries = await readdir(resolve(base, 'addons'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const addons = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const where = `addons/${entry.name}/addon.json`;
    const manifest = await readJson(resolve(base, where), 'INVALID_CONFIG');
    if (manifest === undefined) continue;
    const invalid = message => fail('INVALID_CONFIG', `${source === 'kit' ? 'Kit' : 'Workspace'} ${where}: ${message}`);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) invalid('expected an object');
    const allowed = source === 'kit' ? kitFields : workspaceFields;
    const unknown = Object.keys(manifest).filter(key => !allowed.includes(key));
    if (unknown.includes('operations')) invalid('workspace addons may only carry skills, not operations');
    if (unknown.length) invalid(`unknown fields: ${unknown.join(', ')}`);
    if (manifest.name !== entry.name || !namePattern.test(manifest.name)) invalid('name must match the directory and be kebab-case');
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) invalid('description is required');
    if (!Array.isArray(manifest.skills) || manifest.skills.some(skill => typeof skill !== 'string' || !namePattern.test(skill))) invalid('skills must be skill names');
    const skills = [];
    for (const skill of manifest.skills) {
      // Kit addons name skills bundled under skills/; workspace addons carry their own.
      const path = source === 'kit' ? `skills/${skill}` : `addons/${entry.name}/skills/${skill}`;
      await localFile(base, `${path}/SKILL.md`).catch(() => invalid(`missing ${path}/SKILL.md`));
      skills.push({ name: skill, path: await inside(base, resolve(base, path)) });
    }
    addons.push({ name: manifest.name, description: manifest.description, source, operations: manifest.operations ?? null, skills });
  }
  return addons;
}

export async function loadAddons(root) {
  const kit = await scan(KIT_ROOT, 'kit');
  // The toolkit checkout's own addons/ are the kit addons, not workspace addons.
  const workspace = await realpath(root) === await realpath(KIT_ROOT) ? [] : await scan(root, 'workspace');
  for (const addon of workspace) {
    if (kit.some(item => item.name === addon.name)) fail('INVALID_CONFIG', `Workspace addon ${addon.name} shadows a kit addon`);
  }
  const all = [...kit, ...workspace];
  const config = await readJson(resolve(root, 'context-kit.json'), 'INVALID_CONFIG');
  let enabled;
  if (config === undefined) {
    enabled = new Set(all.map(addon => addon.name));
  } else {
    if (!config || typeof config !== 'object' || config.version !== 1 || !Array.isArray(config.addons) ||
        Object.keys(config).some(key => !['version', 'addons', 'mounts'].includes(key))) {
      fail('INVALID_CONFIG', 'context-kit.json must be {"version": 1, "addons": [...], "mounts": {...}}');
    }
    // Mounts are checked wherever the config is, so a bad one is loud and never used.
    const problems = Object.hasOwn(config, 'mounts') ? mountProblems(config.mounts) : [];
    if (problems.length) fail('INVALID_CONFIG', `context-kit.json: ${problems.join('; ')}`);
    for (const name of config.addons) {
      if (!all.some(addon => addon.name === name)) fail('INVALID_CONFIG', `context-kit.json enables unknown addon: ${name}`);
    }
    enabled = new Set(['core', ...config.addons]);
  }
  return all.map(addon => ({ ...addon, enabled: addon.name === 'core' || enabled.has(addon.name) }));
}

// Operation groups (`core`, `specs`) provided by the enabled addons.
export async function enabledOperations(root) {
  return new Set((await loadAddons(root)).filter(addon => addon.enabled && addon.operations).map(addon => addon.operations));
}
