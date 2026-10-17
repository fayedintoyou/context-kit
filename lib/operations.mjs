import { z } from 'zod';
import * as workspace from './workspace.mjs';
import { openSpec, storeIdSchema } from './specs/openspec.mjs';
import { loadHubs } from './hubs.mjs';
import { auditSpecs } from './specs/audit.mjs';
import { fail } from './files.mjs';

const id = z.string().min(1).max(200);
const includeInbox = z.boolean().default(false);
const store = storeIdSchema.optional().describe('Shared OpenSpec store declared by a hub; omit for the workspace repository.');
// Callers may pick only stores the workspace owner declared in a hub manifest or that
// the workspace repository references in its OpenSpec config.
async function specSource(selection, storeId) {
  if (storeId === undefined) return openSpec(selection.root);
  const declared = (await loadHubs(selection.root)).flatMap(hub => hub.manifest.specStores ?? []);
  if (!declared.includes(storeId)) {
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
  list_hubs: { description: 'List available context hubs.', schema: z.object({}).strict(), run: s => workspace.listHubs(s.root) },
  get_context: { description: 'Read maintained context; optionally include separate unreviewed inbox notes.',
    schema: z.object({ id, includeInbox }).strict(), run: (s, a) => workspace.getContext(s.root, a.id, a.includeInbox) },
  search_context: { description: 'Literal case-insensitive text search with line references.',
    schema: z.object({ query: z.string().trim().min(1).max(200), includeInbox }).strict(), run: (s, a) => workspace.search(s.root, a.query, a.includeInbox) },
  read_skill: { description: 'Read a skill explicitly declared by a hub.',
    schema: z.object({ id, reference: z.string().min(1).max(300) }).strict(), run: (s, a) => workspace.getSkill(s.root, a.id, a.reference) },
  validate_hubs: { description: 'Validate manifests, links, paths and inbox structure.', schema: z.object({}).strict(), run: s => workspace.validateWorkspace(s.root) },
  capture_note: { description: 'Create a new unreviewed Markdown note. Does not commit or publish. Repeated calls create distinct notes.', write: true,
    schema: z.object({ id, title: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/), body: z.string().trim().min(1).max(65536) }).strict(),
    run: (s, a) => workspace.capture(s, a, s.source) },
  list_spec_stores: { description: 'List shared OpenSpec stores declared by hubs, separate from specs that live in the workspace repository.',
    schema: z.object({}).strict(), run: async s => ({ root: s.root, stores: (await loadHubs(s.root))
      .flatMap(hub => (hub.manifest.specStores ?? []).map(storeId => ({ storeId, hub: hub.manifest.id }))) }) },
  list_specs: { description: 'List canonical specifications from the workspace repository or a shared store. Repository results also list specs from stores it references, kept separate.',
    schema: z.object({ store }).strict(), run: (s, a) => withSource(s, a.store, async source => {
      const specs = await source.list();
      if (a.store !== undefined) return { specs };
      const references = await referencedSources(s, source);
      return { specs, references: [
        ...await Promise.all(references.map(async ({ storeId, source: store }) => ({ storeId, status: 'available', issues: [], specs: await store.list() }))),
        ...references.warnings] };
    }) },
  read_spec: { description: 'Read one canonical spec, excluding pending change deltas.', schema: z.object({ id, store }).strict(),
    run: (s, a) => withSource(s, a.store, async source => ({ spec: await source.read(a.id) })) },
  audit_specs: { description: 'Strict structural validation plus a versioned requirement checklist. Semantic compliance remains not_assessed.', schema: z.object({ store }).strict(),
    run: async (s, a) => {
      const source = await specSource(s, a.store);
      return auditSpecs(source, a.store === undefined ? await referencedSources(s, source) : []);
    } },
};
export function operations(allowWrite = false) {
  return Object.entries(definitions).filter(([, definition]) => !definition.write || allowWrite);
}
export async function execute(selection, name, args = {}) {
  const definition = definitions[name];
  if (!definition) fail('UNKNOWN_OPERATION', 'Unknown operation: ' + name);
  if (definition.write && !selection.allowWrite) fail('WRITE_DISABLED', 'Writes are disabled');
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) fail('INVALID_INPUT', parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; '));
  return definition.run(selection, parsed.data);
}
