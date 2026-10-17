import { z } from 'zod';
import * as workspace from './workspace.mjs';
import { openSpec, storeIdSchema } from './specs/openspec.mjs';
import { loadHubs } from './hubs.mjs';
import { auditSpecs } from './specs/audit.mjs';
import { fail } from './files.mjs';

const id = z.string().min(1).max(200);
const includeInbox = z.boolean().default(false);
const store = storeIdSchema.optional().describe('Shared OpenSpec store declared by a hub; omit for the workspace repository.');
// Callers may pick only stores the workspace owner declared in a hub manifest.
async function specSource(selection, storeId) {
  if (storeId === undefined) return openSpec(selection.root);
  const declared = (await loadHubs(selection.root)).flatMap(hub => hub.manifest.specStores ?? []);
  if (!declared.includes(storeId)) fail('UNKNOWN_STORE', `Store is not declared by any hub: ${storeId}`);
  return openSpec(selection.root, { store: storeId });
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
  list_specs: { description: 'List canonical specifications from the workspace repository or a declared shared store.', schema: z.object({ store }).strict(),
    run: (s, a) => withSource(s, a.store, async source => ({ specs: await source.list() })) },
  read_spec: { description: 'Read one canonical spec, excluding pending change deltas.', schema: z.object({ id, store }).strict(),
    run: (s, a) => withSource(s, a.store, async source => ({ spec: await source.read(a.id) })) },
  audit_specs: { description: 'Strict structural validation plus a versioned requirement checklist. Semantic compliance remains not_assessed.', schema: z.object({ store }).strict(),
    run: async (s, a) => auditSpecs(await specSource(s, a.store)) },
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
