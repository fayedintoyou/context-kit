import { z } from 'zod';
import * as workspace from './workspace.mjs';
import { openSpec, storeIdSchema } from './specs/openspec.mjs';
import { loadHubs } from './hubs.mjs';
import { loadAddons, enabledOperations } from './addons.mjs';
import { gardenSpecs } from './specs/garden.mjs';
import { auditSpecs } from './specs/audit.mjs';
import { archivable, archiveReady } from './specs/archival.mjs';
import { changeStatus, nextSlices, readSlice, reconcileChange } from './specs/progress.mjs';
import { loadParties, labelContracts } from './specs/parties.mjs';
import { fail } from './files.mjs';
import { help } from './help.mjs';
import * as repos from './repos.mjs';
import { refreshGeneratedSkills } from './install.mjs';

const id = z.string().min(1).max(200);
const includeInbox = z.boolean().default(false);
const change = storeIdSchema.describe('Active OpenSpec change in the workspace repository, or in the store when one is given.');
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
// Available references become store sources with what read returns (their specs by default);
// anything unreadable degrades to a warning.
async function referencedSources(selection, source, read = store => store.list()) {
  const sources = [];
  const warnings = [];
  for (const reference of await source.references()) {
    if (reference.status !== 'available') { warnings.push(reference); continue; }
    const store = openSpec(selection.root, { store: reference.storeId });
    try { sources.push({ storeId: reference.storeId, source: store, specs: await read(store) }); }
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
// Delivery runs where a change is planned: the workspace repository, or the root of a store
// chosen under the same declared-or-referenced rule as spec reads. That root is the plan root;
// the workspace root, whose registry records the party checkouts, is passed on as well. A store's
// results name it as their source.
async function withPlan(selection, storeId, run) {
  if (storeId === undefined) return run(selection.root, openSpec(selection.root), selection.root);
  const source = await specSource(selection, storeId);
  await source.changes(); // A store's root is known once OpenSpec has resolved it.
  const { root, ...result } = await run(source.root, source, selection.root);
  return { root, source: source.source, ...result };
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
  list_specs: { group: 'specs', description: 'List canonical specifications from the workspace repository or a shared store. Repository results also list specs from stores it references, kept separate. Store specs carry contract (its parties, or null); referenced ones also carry party, the party this repository plays in that contract, or null.',
    schema: z.object({ store }).strict(), run: (s, a) => withSource(s, a.store, async source => {
      const specs = await source.list();
      // A store's parties file is validated wherever its specs are listed, so a broken one is loud.
      if (a.store !== undefined) return { specs: labelContracts(specs, await loadParties(source.root, specs)) };
      // Referenced contracts name the party this repository plays; a referenced store's broken
      // parties file is a warning about that store, like any other unreadable reference.
      const remotes = await repos.remoteKeys(source.root);
      const references = await referencedSources(s, source, async store => {
        const specs = await store.list();
        return labelContracts(specs, await loadParties(store.root, specs), remotes);
      });
      return { specs, references: [
        ...references.map(({ storeId, specs }) => ({ storeId, status: 'available', issues: [], specs })),
        ...references.warnings] };
    }) },
  read_spec: { group: 'specs', description: 'Read one canonical spec, excluding pending change deltas. A store spec carries contract: its parties, or null.', schema: z.object({ id, store }).strict(),
    run: (s, a) => withSource(s, a.store, async source => {
      if (a.store === undefined) return { spec: await source.read(a.id) };
      const specs = await source.list();
      const parties = await loadParties(source.root, specs);
      return { spec: labelContracts([await source.read(a.id)], parties)[0] };
    }) },
  list_parties: { group: 'specs', description: 'A shared store\'s parties (repository upstreams) and contracts (specs binding two or more parties, canonical or proposed) from its openspec/parties.yaml.',
    schema: z.object({ store: storeIdSchema.optional().describe('Shared OpenSpec store declared by a hub or referenced by the workspace repository; required, since only stores declare parties.') }).strict(),
    run: (s, a) => {
      if (a.store === undefined) fail('INVALID_INPUT', 'Parties are declared by stores, not repositories; pass a store (--store <id>)');
      return withSource(s, a.store, async source => {
        const specs = await source.list();
        return loadParties(source.root, specs);
      });
    } },
  garden_specs: { group: 'specs', description: 'Read-only spec gardening signals: size, history, locks, lexical overlap, trace and taxonomy.',
    schema: z.object({ store }).strict(), run: async (s, a) => gardenSpecs(await specSource(s, a.store)) },
  change_status: { group: 'specs', description: 'Derived progress of an active change, in the workspace repository or a shared store: each slice in its slices.yaml is landed, in_progress, ready, blocked or unknown from commits carrying OpenSpec-Change/OpenSpec-Slice trailers (and pull requests when gh is available); each requirement is landed, partial, in_progress, unknown, unstarted or unplanned. A store change\'s slices are judged in their party\'s recorded checkout, by OpenSpec-Change: <store-id>:<change>; a party with no recorded checkout makes its slices unknown.',
    schema: z.object({ change, store }).strict(), run: (s, a) => withPlan(s, a.store, (root, source, workspace) => changeStatus(root, a.change, source, workspace)) },
  next_slices: { group: 'specs', description: 'Work packets for the slices of a change that are ready to start: dependencies landed, nobody working on them. Each packet carries the requirements, landed dependencies, paths and the commit trailers to use. Does not claim slices.',
    schema: z.object({ change, store }).strict(), run: (s, a) => withPlan(s, a.store, (root, source, workspace) => nextSlices(root, a.change, source, workspace)) },
  read_slice: { group: 'specs', description: 'The work packet for one slice of a change; for a landed or in-progress slice it also lists the commits, branches, pull requests and linked tests to review.',
    schema: z.object({ change, slice: storeIdSchema, store }).strict(), run: (s, a) => withPlan(s, a.store, (root, source, workspace) => readSlice(root, a.change, a.slice, source, workspace)) },
  reconcile_change: { group: 'specs', description: 'Facts for checking a change against what was built: files outside each slice\'s paths, files shared by slices, stray trailers, uncovered requirements and unlinked scenarios, with status. Judgment stays with the reconcile-change skill.',
    schema: z.object({ change, store }).strict(), run: (s, a) => withPlan(s, a.store, (root, source, workspace) => reconcileChange(root, a.change, source, workspace)) },
  archivable_changes: { group: 'specs', description: 'Which active changes of the workspace repository or a shared store are ready to archive: every task ticked and, with a slice plan, every slice landed. Lists blockers (no_tasks, tasks_incomplete, slices_unlanded) otherwise.',
    schema: z.object({ store }).strict(), run: (s, a) => withPlan(s, a.store, archivable) },
  archive_ready: { group: 'specs', cliOnly: true, write: true, description: 'Archive every ready change of the workspace repository or a store through OpenSpec and validate its canonical specs strictly. Does not commit.',
    schema: z.object({ store }).strict(), run: (s, a) => withPlan(s, a.store, archiveReady) },
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
