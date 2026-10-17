import { z } from 'zod';
import * as workspace from './workspace.mjs';
import { openSpec, storeIdSchema } from './specs/openspec.mjs';
import { loadHubs } from './hubs.mjs';
import { loadAddons, enabledOperations } from './addons.mjs';
import { auditSpecs } from './specs/audit.mjs';
import { fail } from './files.mjs';
import { help } from './help.mjs';
import * as repos from './repos.mjs';
import { refreshGeneratedSkills } from './install.mjs';

const id = z.string().min(1).max(200);
const includeInbox = z.boolean().default(false);
const store = storeIdSchema.optional().describe('Shared OpenSpec store declared by a hub; omit for the workspace repository.');
// Spec commands work on any repository; one without hubs simply declares no stores.
async function hubStores(root) {
  let hubs;
  try { hubs = await loadHubs(root); }
  catch (error) { if (error.code === 'NO_HUBS') return []; throw error; }
  return hubs.flatMap(hub => (hub.manifest.specStores ?? []).map(storeId => ({ storeId, via: 'hub', hub: hub.manifest.id })));
}
// Callers may pick only stores the workspace owner declared in a hub manifest or that
// the workspace repository references in its OpenSpec config.
async function specSource(selection, storeId) {
  if (storeId === undefined) return openSpec(selection.root);
  if (!(await hubStores(selection.root)).some(declared => declared.storeId === storeId)) {
    let references = [];
    try { references = await openSpec(selection.root).references(); } catch { /* Not an OpenSpec repository. */ }
    if (!references.some(reference => reference.storeId === storeId && reference.status === 'available')) {
      fail('UNKNOWN_STORE', `Store is neither declared by a hub nor referenced by the repository: ${storeId}`);
    }
  }
  return openSpec(selection.root, { store: storeId });
}
// Available references become store sources; anything unreadable degrades to a warning.
async function referencedSources(selection, source) {
  const sources = [];
  const warnings = [];
  for (const reference of await source.references()) {
    if (reference.status !== 'available') { warnings.push(reference); continue; }
    const store = openSpec(selection.root, { store: reference.storeId });
    try { await store.list(); sources.push({ storeId: reference.storeId, source: store }); }
    catch (error) {
      warnings.push({ storeId: reference.storeId, status: 'warning',
        issues: [{ severity: 'warning', code: error.code || 'ADAPTER_FAILED', message: error.message }] });
    }
  }
  return Object.assign(sources, { warnings });
}
async function withSource(selection, storeId, read) {
  const source = await specSource(selection, storeId);
  const result = await read(source);
  return { root: source.root, source: source.source, ...result };
}
const definitions = {
  help: { standalone: true, description: 'Context Kit help: with no topic, list topics; with a topic, return it. Start here when unsure how to use Context Kit.',
    schema: z.object({ topic: z.string().regex(/^[a-z0-9-]+$/).max(60).optional() }).strict(), run: (s, a) => help(a.topic) },
  list_hubs: { description: 'List available context hubs.', schema: z.object({}).strict(), run: s => workspace.listHubs(s.root) },
  get_context: { description: 'Read a hub\'s curated starting documents; optionally include separate unreviewed inbox notes. To explore beyond them, use browse_hub.',
    schema: z.object({ id, includeInbox }).strict(), run: (s, a) => workspace.getContext(s.root, a.id, a.includeInbox) },
  search_context: { description: 'Literal case-insensitive text search across every concept, with concept IDs and line references.',
    schema: z.object({ query: z.string().trim().min(1).max(200), includeInbox }).strict(), run: (s, a) => workspace.search(s.root, a.query, a.includeInbox) },
  browse_hub: { description: 'Progressive disclosure, step 1: list one directory of a hub (start with path "") as child concepts with OKF type, title, description and trust, plus subdirectories and the index. Then read_concept on the IDs you need, or browse a subdirectory.',
    schema: z.object({ id, path: z.string().max(500).default(''), offset: z.number().int().min(0).max(100000).default(0), includeInbox }).strict(),
    run: (s, a) => workspace.browseHub(s.root, a.id, a.path, { includeInbox: a.includeInbox, offset: a.offset }) },
  read_concept: { description: 'Progressive disclosure, step 2: read one OKF concept by ID (path without .md) with its trust summary and classified outgoing links; follow concept links with another read_concept.',
    schema: z.object({ id, concept: z.string().min(1).max(500), frontmatter: z.boolean().default(false), includeInbox }).strict(),
    run: (s, a) => workspace.readConcept(s.root, a.id, a.concept, { includeInbox: a.includeInbox, frontmatter: a.frontmatter }) },
  list_addons: { description: 'List Context Kit addons (core plus optional functionality), their skills, and which are enabled in this workspace.',
    schema: z.object({}).strict(), run: async s => {
      // Core also provides the generated skills, such as my-repos when repositories are registered.
      const generated = (await repos.listRepositories(s.root)).repositories.length ? [repos.ROUTING_SKILL] : [];
      return { root: s.root, addons: (await loadAddons(s.root)).map(({ name, description, source, skills, enabled }) =>
        ({ name, description, source, enabled, skills: [...skills.map(skill => skill.name), ...(name === 'core' ? generated : [])],
          ...(name === 'core' && generated.length ? { generated } : {}) })) };
    } },
  list_repos: { description: 'List the user\'s registered repositories (Repository concepts) with upstream, aliases and this machine\'s local checkout path, or missing. Use it to find where to work on a repository instead of searching the filesystem.',
    schema: z.object({}).strict(), run: async s => {
      const { root, repositories, warnings } = await repos.listRepositories(s.root);
      return { root, repositories: repositories.map(({ id, title, upstream, aliases, path, status }) => ({ id, title, upstream, aliases, path, status })), warnings };
    } },
  locate_repo: { cliOnly: true, write: true, description: 'Record where a registered repository is checked out on this machine.',
    schema: z.object({ repository: id, path: z.string().min(1).max(4096) }).strict(),
    run: async (s, a) => ({ ...await repos.locateRepository(s.root, a.repository, a.path), skills: await refreshGeneratedSkills(s.root) }) },
  clone_repo: { cliOnly: true, write: true, description: 'Clone a registered repository and record its checkout.',
    schema: z.object({ repository: id, path: z.string().min(1).max(4096).optional() }).strict(),
    run: async (s, a) => ({ ...await repos.cloneRepository(s.root, a.repository, a.path), skills: await refreshGeneratedSkills(s.root) }) },
  add_repo: { write: true, description: 'Register one of the user\'s repositories in a hub (personal or shared): writes a draft Repository concept with its upstream, title and aliases, and lists it in the hub index. Use when the user asks to add or register a repository.',
    schema: z.object({ id, upstream: z.string().min(1).max(500), title: z.string().trim().min(1).max(160).optional(),
      aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]), description: z.string().trim().min(1).max(500).optional(),
      concept: z.string().min(1).max(200).optional() }).strict(),
    run: async (s, a) => ({ ...await repos.addRepository(s, { hub: a.id, upstream: a.upstream, title: a.title, aliases: a.aliases, description: a.description, concept: a.concept }),
      skills: await refreshGeneratedSkills(s.root) }) },
  add_repo_checkout: { cliOnly: true, write: true, description: 'Register a repository in a hub from a local checkout, recording its path.',
    schema: z.object({ id, path: z.string().min(1).max(4096), upstream: z.string().min(1).max(500).optional(), title: z.string().trim().min(1).max(160).optional(),
      aliases: z.array(z.string().trim().min(1).max(100)).max(20).default([]), description: z.string().trim().min(1).max(500).optional(),
      concept: z.string().min(1).max(200).optional() }).strict(),
    run: async (s, a) => ({ ...await repos.addRepository(s, { hub: a.id, upstream: a.upstream, path: a.path, title: a.title, aliases: a.aliases, description: a.description, concept: a.concept }),
      skills: await refreshGeneratedSkills(s.root) }) },
  sync_repos: { cliOnly: true, write: true, description: 'Rebuild the generated my-repos skill from the Repository concepts and this machine\'s checkouts, and update installed copies.',
    schema: z.object({}).strict(), run: async s => {
      const results = await refreshGeneratedSkills(s.root);
      const [skill] = await repos.generatedSkills(s.root);
      return { root: s.root, skill: skill ? `${skill.path}/SKILL.md` : null, results,
        ...(skill && !results.length ? { next: 'Not installed in any agent yet; run agents install' } : {}) };
    } },
  scan_repos: { cliOnly: true, write: true, description: 'Record checkouts of registered repositories found in a directory or its immediate subdirectories.',
    schema: z.object({ directory: z.string().min(1).max(4096) }).strict(),
    run: async (s, a) => ({ ...await repos.scanRepositories(s.root, a.directory), skills: await refreshGeneratedSkills(s.root) }) },
  list_skills: { description: 'List the skills declared by hubs, each once with its name, description and declaring hubs.',
    schema: z.object({}).strict(), run: s => workspace.listSkills(s.root) },
  read_skill: { description: 'Read a skill declared by a hub: its SKILL.md, or another Markdown file in the skill directory via file (for example references/<name>.md).',
    schema: z.object({ id, reference: z.string().min(1).max(300), file: z.string().min(1).max(300).default('SKILL.md') }).strict(),
    run: (s, a) => workspace.getSkill(s.root, a.id, a.reference, a.file) },
  validate_hubs: { description: 'Validate manifests, links, paths and inbox structure.', schema: z.object({}).strict(), run: s => workspace.validateWorkspace(s.root) },
  capture_note: { description: 'Create a new unreviewed Markdown note. Does not commit or publish. Repeated calls create distinct notes.', write: true,
    schema: z.object({ id, title: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/), body: z.string().trim().min(1).max(65536) }).strict(),
    run: (s, a) => workspace.capture(s, a) },
  list_spec_stores: { group: 'specs', description: 'List shared OpenSpec stores readable here: declared by a hub, or referenced by the workspace repository.',
    schema: z.object({}).strict(), run: async s => {
      const stores = await hubStores(s.root);
      let references = [];
      try { references = await openSpec(s.root).references(); } catch { /* Not an OpenSpec repository. */ }
      for (const { storeId, status, issues } of references) stores.push({ storeId, via: 'reference', status, issues });
      return { root: s.root, stores };
    } },
  list_specs: { group: 'specs', description: 'List canonical specifications from the workspace repository or a shared store. Repository results also list specs from stores it references, kept separate.',
    schema: z.object({ store }).strict(), run: (s, a) => withSource(s, a.store, async source => {
      const specs = await source.list();
      if (a.store !== undefined) return { specs };
      const references = await referencedSources(s, source);
      return { specs, references: [
        ...await Promise.all(references.map(async ({ storeId, source: store }) => ({ storeId, status: 'available', issues: [], specs: await store.list() }))),
        ...references.warnings] };
    }) },
  read_spec: { group: 'specs', description: 'Read one canonical spec, excluding pending change deltas.', schema: z.object({ id, store }).strict(),
    run: (s, a) => withSource(s, a.store, async source => ({ spec: await source.read(a.id) })) },
  audit_specs: { group: 'specs', description: 'Strict structural validation plus a versioned requirement checklist. Semantic compliance remains not_assessed.', schema: z.object({ store }).strict(),
    run: async (s, a) => {
      const source = await specSource(s, a.store);
      return auditSpecs(source, a.store === undefined ? await referencedSources(s, source) : []);
    } },
};
// Operations offered to a caller: writes only when allowed, addon groups only when enabled.
// CLI-only operations (recording checkouts, cloning) are never offered as tools.
export function operations(allowWrite = false, groups = new Set(['core', 'specs'])) {
  return Object.entries(definitions).filter(([, definition]) =>
    !definition.cliOnly && (!definition.write || allowWrite) && groups.has(definition.group ?? 'core'));
}
export async function execute(selection, name, args = {}) {
  const definition = definitions[name];
  if (!definition) fail('UNKNOWN_OPERATION', 'Unknown operation: ' + name);
  if (definition.cliOnly && selection.source !== 'cli') fail('UNKNOWN_OPERATION', 'Unknown operation: ' + name);
  if (definition.write && !selection.allowWrite) fail('WRITE_DISABLED', 'Writes are disabled');
  const group = definition.group ?? 'core';
  // Help works even when a workspace's addon configuration is broken; everything else checks it.
  if (!definition.standalone && !(await enabledOperations(selection.root)).has(group)) {
    fail('ADDON_DISABLED', `${name} needs the ${group} addon; enable it in context-kit.json`);
  }
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) fail('INVALID_INPUT', parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; '));
  return definition.run(selection, parsed.data);
}
