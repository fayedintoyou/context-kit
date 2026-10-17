import { fail } from '../files.mjs';
import { snapshot, requirementKey } from './snapshot.mjs';

function checklist(specs, prefix = '', extra = {}) {
  const items = specs.flatMap(spec => spec.requirements.map(requirement => ({
    key: prefix + requirementKey(spec.id, requirement.name),
    spec: spec.id, requirement: requirement.name, text: requirement.text,
    scenarios: requirement.scenarios, ...extra, semantic: 'not_assessed', evidence: [],
  })));
  if (new Set(items.map(item => item.key)).size !== items.length) {
    fail('DUPLICATE_REQUIREMENT', 'Requirement names must be unique within a canonical spec');
  }
  return items;
}
// A repository audit may include stores it references; their requirements are listed
// separately because whether a shared requirement applies here is itself unassessed.
export async function auditSpecs(source, references = []) {
  // Resolve first: a store's root comes from the OpenSpec registry, not the workspace.
  await source.list();
  for (const reference of references) await reference.source.list();
  const sources = [source, ...references.map(reference => reference.source)];
  const first = await snapshot(sources);
  const validate = (state, from) => state.specs.length ? from.validate() : { strict: true, valid: false, items: [] };
  const structural = await validate(first[0], source);
  const referencedStructural = [];
  for (let i = 0; i < references.length; i++) referencedStructural.push(await validate(first[i + 1], references[i].source));
  const second = await snapshot(sources);
  if (first.some((state, i) => JSON.stringify(state.git) !== JSON.stringify(second[i].git) ||
      state.contentHash !== second[i].contentHash)) {
    fail('SNAPSHOT_CHANGED', 'Repository or specs changed during audit; retry on a stable tree');
  }
  const [own, ...referenced] = second;
  const report = { root: source.root, source: source.source, adapter: { name: source.name, version: source.version },
    status: own.specs.length ? (structural.valid ? 'structurally_valid' : 'structurally_invalid') : 'no_canonical_specs',
    semantic: 'not_assessed', snapshot: { ...own.git, canonicalHash: own.contentHash,
      implementationEvidence: 'not_collected' }, structural, checklist: checklist(own.specs) };
  if (source.source.kind === 'store') {
    report.scope = { semantic: 'not_assessed', review: 'Assess implementation evidence from audits of each repository that references this store.' };
  } else {
    report.referenced = references.map((reference, i) => ({ storeId: reference.storeId,
      status: referenced[i].specs.length ? (referencedStructural[i].valid ? 'structurally_valid' : 'structurally_invalid') : 'no_canonical_specs',
      structural: referencedStructural[i], snapshot: { ...referenced[i].git, canonicalHash: referenced[i].contentHash },
      checklist: checklist(referenced[i].specs, `store:${reference.storeId}/`, { applicability: 'not_assessed' }) }));
    report.referenceWarnings = references.warnings ?? [];
  }
  return report;
}
