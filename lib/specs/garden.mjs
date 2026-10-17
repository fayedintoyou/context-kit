import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { fail, MAX_OUTPUT } from '../files.mjs';
import { storeIdSchema } from './openspec.mjs';
import { snapshot, requirementKey } from './snapshot.mjs';
import { deltas } from './deltas.mjs';
import { testLinks } from './links.mjs';

export const DEFAULT_LIMITS = { maxRequirements: 12, maxLines: 300, overlapThreshold: 0.35 };
const limitsSchema = z.object({ maxRequirements: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(), overlapThreshold: z.number().min(0).max(1).optional() }).strict();
const taxonomySchema = z.object({ limits: limitsSchema.optional(),
  domains: z.record(storeIdSchema, z.object({ purpose: z.string().trim().min(1), limits: limitsSchema.optional() }).strict()),
  retired: z.array(storeIdSchema).optional() }).strict();
async function taxonomy(root) {
  const path = join(root, 'openspec/taxonomy.yaml');
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return taxonomySchema.parse(parse(content)); }
  catch (error) { fail('INVALID_CONFIG', `${path}: ${error.message}`); }
}
const stop = new Set('shall must should may will required recommended optional the a an and or of to in for with by is are be as that this it when then system scenario requirement not'.split(' '));
function shingles(item) {
  const words = [item.requirement, item.text, ...item.scenarios.map(s => s.rawText)].join(' ')
    .normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const normalized = words.filter(word => !stop.has(word)).map(word => word.replace(/(ing|ed|es|s)$/, ''));
  return new Set(normalized.slice(2).map((word, i) => normalized.slice(i, i + 3).join(' ')));
}
export async function gardenSpecs(source) {
  await source.list();
  const [first] = await snapshot([source]);
  const config = await taxonomy(source.root);
  const changes = await deltas(source.root);
  const links = source.source.kind === 'store' ? [] : (await testLinks(source.root))
    .filter(link => link.attached && (link.kind === 'e2e' || link.kind === 'manual' || (link.kind === 'unit' && link.justified)));
  const linked = new Set(links.map(link => link.key));
  const limits = { ...DEFAULT_LIMITS, ...config?.limits };
  const archived = new Map();
  const order = { ADDED: 0, RENAMED: 1, MODIFIED: 2 };
  for (const delta of changes.filter(delta => delta.date)) {
    for (const operation of delta.operations.filter(operation => operation.op !== 'REMOVED')) {
      const key = requirementKey(delta.spec, operation.requirement);
      const event = { change: delta.change, date: delta.date, op: operation.op,
        from: operation.from && requirementKey(delta.spec, operation.from) };
      archived.set(key, [...(archived.get(key) ?? []), event]);
    }
  }
  function historyFor(key) {
    const found = new Set();
    const history = [];
    const ambiguities = [];
    function visit(name, through = '9999-99-99') {
      const events = (archived.get(name) ?? []).filter(event => event.date <= through)
        .sort((a, b) => a.date.localeCompare(b.date) || order[a.op] - order[b.op] || a.change.localeCompare(b.change));
      const starts = events.filter(event => event.op === 'ADDED' || event.op === 'RENAMED');
      const since = starts.at(-1)?.date ?? '';
      const candidates = starts.filter(event => event.date === since);
      if (candidates.length > 1) {
        ambiguities.push({ key: name, date: since, reason: 'same_day_name_reuse',
          changes: [...new Set(candidates.map(event => event.change))].sort() });
      }
      for (const event of events.filter(event => event.date >= since &&
          !(candidates.length > 1 && event.date === since))) {
        if (found.has(event)) continue;
        found.add(event);
        if (event.from) visit(event.from, event.date);
        const { from, ...entry } = event;
        history.push(entry);
      }
    }
    visit(key);
    return { entries: history.sort((a, b) => a.date.localeCompare(b.date)), ambiguities };
  }
  const active = changes.filter(delta => !delta.date);
  const specs = first.specs.map(spec => {
    const applied = { ...limits, ...config?.domains[spec.id]?.limits };
    const lines = spec.content.split('\n').length - Number(spec.content.endsWith('\n'));
    return { id: spec.id, lines, requirements: spec.requirements.length,
      scenarios: spec.requirements.reduce((n, req) => n + req.scenarios.length, 0), limits: applied,
      flags: spec.requirements.length > applied.maxRequirements || lines > applied.maxLines ? ['oversized'] : [],
      requirementsWithoutScenarios: spec.requirements.filter(req => !req.scenarios.length).map(req => req.name),
      lockedBy: [...new Set(active.filter(delta => delta.spec === spec.id).map(delta => delta.change))],
      domain: config ? (Object.hasOwn(config.domains, spec.id) ? 'declared' : 'undeclared') : 'unchecked' };
  });
  const items = first.specs.flatMap(spec => spec.requirements.map(req => {
    const key = requirementKey(spec.id, req.name);
    const { entries, ambiguities } = historyFor(key);
    return { key, spec: spec.id, requirement: req.name, text: req.text, scenarios: req.scenarios,
      history: entries, historyAmbiguities: ambiguities, lastChanged: entries.at(-1)?.date ?? null,
      lockedBy: [...new Set(active.filter(delta => delta.spec === spec.id && delta.operations.some(op =>
        ['MODIFIED', 'REMOVED', 'RENAMED'].includes(op.op) &&
        [op.requirement, op.from].filter(Boolean).some(name => requirementKey(spec.id, name) === key))).map(delta => delta.change))],
      untested: links.length ? req.scenarios.filter(s => !linked.has(`${spec.id} / ${s.name}`)).map(s => s.name) : null };
  }));
  if (new Set(items.map(item => item.key)).size !== items.length) fail('DUPLICATE_REQUIREMENT', 'Requirement names must be unique within a canonical spec');
  const sets = items.map(shingles);
  const overlap = [];
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const intersection = [...sets[a]].filter(word => sets[b].has(word)).length;
    const union = sets[a].size + sets[b].size - intersection;
    const score = union ? intersection / union : 0;
    const threshold = Math.min(specs.find(spec => spec.id === items[a].spec).limits.overlapThreshold,
      specs.find(spec => spec.id === items[b].spec).limits.overlapThreshold);
    if (union && score >= threshold) overlap.push({ a: items[a].key, b: items[b].key, score, method: 'lexical' });
  }
  overlap.sort((a, b) => b.score - a.score || a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
  const [second] = await snapshot([source]);
  if (JSON.stringify(first.git) !== JSON.stringify(second.git) || first.contentHash !== second.contentHash) {
    fail('SNAPSHOT_CHANGED', 'Repository or specs changed during gardening; retry on a stable tree');
  }
  const ids = specs.map(spec => spec.id);
  const report = { root: source.root, source: source.source, adapter: { name: source.name, version: source.version },
    snapshot: { ...first.git, canonicalHash: first.contentHash }, status: specs.length ? 'ok' : 'no_canonical_specs',
    limits, specs, requirements: items.map(({ text, ...item }) => item), overlap, truncated: false,
    trace: { convention: links.length ? 'spec-links' : null, status: links.length ? 'collected' : 'not_collected' },
    taxonomy: { status: config ? 'checked' : 'absent', undeclared: config ? ids.filter(id => !Object.hasOwn(config.domains, id)) : [],
      empty: config ? Object.keys(config.domains).filter(id => !ids.includes(id)).sort() : [],
      retiredInUse: (config?.retired ?? []).filter(id => ids.includes(id)).sort() } };
  while (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_OUTPUT && overlap.length) { overlap.pop(); report.truncated = true; }
  if (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_OUTPUT) fail('TOO_LARGE', 'Garden report exceeds the output budget');
  return report;
}
