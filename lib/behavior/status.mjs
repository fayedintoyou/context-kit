// Node status (design decision 11). A map may declare a node `works`, `issue` or `fixed`, always
// with evidence; the kit derives only `tested`, `untested` or `unknown` from the repository's
// `// spec:` test links. A derived status is never promoted to a declared one, and nothing is
// fetched or run: evidence paths are only looked up, never read, and tests are only read for links.
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { testLinks } from '../specs/links.mjs';

export const FOUND_BY = ['model-checker', 'test', 'review', 'user-report', 'other'];
const FOUND_BY_WORDING = {
  'model-checker': 'Problem a model checker found',
  test: 'Problem a test found',
  review: 'Problem found in review',
  'user-report': 'Problem a user reported',
  other: 'Problem found',
};
export const FINDER_MAX = 40;

const oneLine = max => z.string().min(1).max(max).regex(/^[^\r\n]+$/, 'must be one line');
const evidence = z.array(oneLine(500), { error: 'a declared status needs evidence: a list of repository paths, #<pull request> numbers or https:// links' })
  .min(1, 'a declared status needs at least one evidence item: a repository path, #<pull request> or an https:// link').max(20);
const note = oneLine(500).optional();
export const statusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('works'), evidence, note }).strict(),
  z.object({ state: z.literal('fixed'), evidence, note }).strict(),
  z.object({ state: z.literal('issue'), found_by: z.enum(FOUND_BY), finder: oneLine(FINDER_MAX).optional(), note, evidence,
    fixed_by: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'fixed_by names a node ID').max(100).optional() }).strict(),
], { error: 'status.state is works, issue or fixed' });

// The key's wording for a declared issue: who found it, by name when the map gives one.
export const problemWording = status => (status.finder ? `Problem ${status.finder} found` : FOUND_BY_WORDING[status.found_by]);

// Fix edges, issue to fix, in node order; only those naming a node of the map.
export function fixEdges(data) {
  const ids = new Set(data.nodes.map(node => node.id));
  return data.nodes.filter(node => node.status?.state === 'issue' && node.status.fixed_by !== undefined && ids.has(node.status.fixed_by))
    .map(node => ({ from: node.id, to: node.status.fixed_by }));
}

const PULL_REQUEST = /^#[1-9][0-9]{0,9}$/;
// One evidence item as { kind, value }, or { problem } saying why it can't stand as evidence.
// A path is relative to the repository root, has no `.` or `..` segments, and is looked up one
// component at a time without following symlinks, so it can't name anything outside the root.
async function resolveEvidence(root, item) {
  if (item.startsWith('#')) return PULL_REQUEST.test(item) ? { kind: 'pull_request', value: item } : { problem: `${item} is not a pull request number (#<n>)` };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(item)) {
    let url;
    try { url = new URL(item); } catch { url = null; }
    if (!item.startsWith('https://') || !url || url.protocol !== 'https:' || !url.hostname || /\s/.test(item)) return { problem: `${item} is not an https:// link; evidence links must be https` };
    return { kind: 'link', value: item };
  }
  const segments = item.split('/');
  if (item.startsWith('/') || item.includes('\\') || /[\u0000-\u001f]/.test(item) || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return { problem: `${item} is not a repository path; give it relative to the repository root, without . or .. segments` };
  }
  for (let i = 1; i <= segments.length; i++) {
    let info;
    try { info = await lstat(join(root, ...segments.slice(0, i))); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { problem: `${item} does not exist in the repository` };
      throw error;
    }
    if (info.isSymbolicLink()) return { problem: `${item} goes through a symlink (${segments.slice(0, i).join('/')}); cite the file itself` };
    if (i < segments.length && !info.isDirectory()) return { problem: `${item} does not exist in the repository` };
  }
  return { kind: 'path', value: item };
}

// Reads the repository's test links once per run, only when a map needs them.
export function linkReader(root) {
  let links;
  return async () => {
    if (!links) {
      links = new Map();
      for (const link of await testLinks(root)) {
        if (!link.attached) continue;
        links.set(link.key, [...(links.get(link.key) ?? []), { kind: 'test', value: `${link.file}:${link.line}`, scenario: link.key }]);
      }
    }
    return links;
  };
}

// Why a source's nodes are `unknown`, or null when its citations can be matched to test links:
// only the repository's own OpenSpec specs are tested by the repository's own tests.
function unlinkedReason(selection) {
  if (selection.kind !== 'openspec') return `the ${selection.kind} source has no test links to read`;
  if (selection.store !== undefined) return `the store ${selection.store} is tested in its parties, not in this repository`;
  return null;
}

// The scenarios a node's citations stand for: a cited scenario, or each scenario of a cited requirement.
function citedScenarios(cites, resolved, groups) {
  const scenarios = [];
  const empty = [];
  for (const id of cites) {
    const behavior = resolved.get(id);
    if (!behavior) continue;
    if (behavior.kind === 'scenario') scenarios.push(behavior.id);
    else if (behavior.kind === 'requirement') {
      const children = [...groups.values()].flat().filter(item => item.kind === 'scenario' && item.parent === behavior.id).map(item => item.id);
      if (!children.length) empty.push(behavior.id);
      scenarios.push(...children);
    }
  }
  return { scenarios: [...new Set(scenarios)], empty };
}

// Errors (evidence_missing, fix_target) and each node's statuses: { declared?, derived }, each with
// its origin, reason and evidence. groups holds what the source read, by group, for requirements'
// scenarios; links reads the repository's test links.
export async function nodeStatuses(root, data, resolved, groups, links) {
  const errors = [];
  const statuses = {};
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  const unlinked = unlinkedReason(data.source);
  for (const node of data.nodes) {
    if (Object.hasOwn(statuses, node.id)) continue; // a duplicate ID, reported by the structure check
    const entry = {};
    const declared = node.status;
    if (declared) {
      const items = [];
      for (const item of declared.evidence) {
        const resolvedItem = await resolveEvidence(root, item);
        if (resolvedItem.problem) errors.push({ code: 'evidence_missing', element: node.id, message: `${node.id} declares ${declared.state} with evidence ${resolvedItem.problem}` });
        else items.push(resolvedItem);
      }
      if (declared.state === 'issue' && declared.fixed_by !== undefined) {
        const target = nodes.get(declared.fixed_by);
        if (!target) errors.push({ code: 'fix_target', element: node.id, message: `${node.id} is fixed_by ${declared.fixed_by}, which is no node of the map` });
        else if (target.status?.state !== 'fixed') errors.push({ code: 'fix_target', element: node.id, message: `${node.id} is fixed_by ${declared.fixed_by}, which does not declare fixed; declare it fixed with the fixing pull request` });
      }
      const fixes = data.nodes.filter(other => other.status?.state === 'issue' && other.status.fixed_by === node.id).map(other => other.id);
      const reason = declared.state === 'works' ? 'declared working in the map'
        : declared.state === 'issue' ? `declared in the map: ${problemWording(declared).replace(/^Problem/, 'a problem')}`
          : `declared fixed in the map${fixes.length ? `, fixing ${fixes.join(', ')}` : ''}`;
      entry.declared = { state: declared.state, origin: 'declared', reason, evidence: items,
        ...(declared.found_by === undefined ? {} : { found_by: declared.found_by }), ...(declared.finder === undefined ? {} : { finder: declared.finder }),
        ...(declared.fixed_by === undefined ? {} : { fixed_by: declared.fixed_by }), ...(declared.note === undefined ? {} : { note: declared.note }) };
    }
    const cites = node.cites ?? [];
    if (!cites.length) entry.derived = { state: 'unknown', origin: 'derived', reason: `${node.id} cites no behavior`, evidence: [] };
    else if (unlinked) entry.derived = { state: 'unknown', origin: 'derived', reason: unlinked, evidence: [] };
    else {
      const { scenarios, empty } = citedScenarios(cites, resolved, groups);
      const byScenario = await links();
      if (!scenarios.length && !empty.length) { statuses[node.id] = { ...entry, derived: { state: 'unknown', origin: 'derived', reason: `${node.id}'s citations name no behavior`, evidence: [] } }; continue; }
      const untested = scenarios.filter(id => !byScenario.has(id));
      const evidenceItems = scenarios.flatMap(id => byScenario.get(id) ?? []);
      if (untested.length || empty.length) {
        const parts = [...(untested.length ? [`no linked test for ${untested.join(', ')}`] : []),
          ...empty.map(id => `the requirement ${id} has no scenarios to link a test to`)];
        entry.derived = { state: 'untested', origin: 'derived', reason: parts.join('; '), evidence: evidenceItems, untested: [...untested, ...empty] };
      } else entry.derived = { state: 'tested', origin: 'derived', reason: `every cited scenario has a linked test (${scenarios.length})`, evidence: evidenceItems };
    }
    statuses[node.id] = entry;
  }
  return { errors, statuses };
}
