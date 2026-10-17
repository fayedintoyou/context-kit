import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { fail } from '../files.mjs';
import { openSpec, storeIdSchema } from './openspec.mjs';
import { requirementKey } from './snapshot.mjs';
import { deltas } from './deltas.mjs';
import { loadParties, PARTIES_FILE } from './parties.mjs';

const refSchema = z.string().regex(/^(?!.*\.\.)(?!-)[A-Za-z0-9._/-]+$/).max(200);
const planSchema = z.object({ base: refSchema.optional(),
  slices: z.array(z.object({ id: storeIdSchema, title: z.string().trim().min(1).max(200).optional(),
    repo: storeIdSchema.optional(), implements: z.array(z.string().trim().min(1)).min(1), depends_on: z.array(storeIdSchema).optional(),
    paths: z.array(z.string().trim().min(1).max(300)).optional() }).strict()) }).strict();
export const requirementId = (spec, name) => `${spec} / ${name}`;
// A root is a store's when it was selected as one, or when it carries OpenSpec's store
// identity file, as a store maintained in place (`--root <store>`) does.
export async function storeIdentity(root, source) {
  if (source?.source.kind === 'store') return source.source.storeId;
  const metadata = await readFile(join(root, '.openspec-store/store.yaml'), 'utf8').catch(() => null);
  if (metadata === null) return null;
  let id;
  try { id = parse(metadata)?.id; } catch { id = undefined; }
  if (!storeIdSchema.safeParse(id).success) fail('INVALID_CONFIG', '.openspec-store/store.yaml: expected the store id as id');
  return id;
}
// A change's requirements are the targets of its deltas: removals and renames need implementing too.
async function changeRequirements(root, change) {
  const found = new Map();
  for (const delta of (await deltas(root)).filter(delta => !delta.date && delta.change === change)) {
    for (const operation of delta.operations) {
      const id = requirementId(delta.spec, operation.requirement);
      const entry = found.get(id) ?? { id, spec: delta.spec, requirement: operation.requirement,
        key: requirementKey(delta.spec, operation.requirement), ops: [] };
      entry.ops.push(operation.op);
      if (operation.text !== undefined) Object.assign(entry, { text: operation.text, scenarios: operation.scenarios });
      if (operation.from) entry.from = operation.from;
      found.set(id, entry);
    }
  }
  return [...found.values()];
}
function cycle(slices) {
  const byId = new Map(slices.map(slice => [slice.id, slice]));
  const state = new Map();
  function visit(id, path) {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    for (const next of byId.get(id).depends_on ?? []) {
      const found = visit(next, [...path, id]);
      if (found) return found;
    }
    state.set(id, 'done');
    return null;
  }
  for (const slice of slices) {
    const found = visit(slice.id, []);
    if (found) return found;
  }
  return null;
}
// A store holds no code, so each of its slices lands in a party the store declares; a
// repository's slices land in the repository itself and name none. The source decides which.
export async function loadPlan(root, change, source = null) {
  if (!storeIdSchema.safeParse(change).success || change === 'archive') fail('INVALID_INPUT', `Invalid change name: ${change}`);
  const directory = join(root, 'openspec/changes', change);
  if (!(await stat(directory).catch(() => null))?.isDirectory()) fail('NOT_FOUND', `No active change: ${change}`);
  const requirements = await changeRequirements(root, change);
  const file = `openspec/changes/${change}/slices.yaml`;
  let content;
  try { content = await readFile(join(root, file), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { change, file, plan: null, requirements, parties: null }; throw error; }
  const invalid = message => fail('INVALID_CONFIG', `${file}: ${message}`);
  let plan;
  let raw;
  try { raw = parse(content); } catch (error) { invalid(`not valid YAML: ${error.message}`); }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    // Name the slice a schema problem is in, not only its index.
    const [issue] = parsed.error.issues;
    const [top, index, ...field] = issue.path;
    const where = top === 'slices' && typeof index === 'number'
      ? `slice ${typeof raw.slices[index]?.id === 'string' ? raw.slices[index].id : `#${index + 1}`}${field.length ? ` ${field.join('.')}` : ''}`
      : issue.path.join('.') || 'plan';
    invalid(`${where}: ${issue.message}`);
  }
  plan = parsed.data;
  const ids = plan.slices.map(slice => slice.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) invalid(`duplicate slice id ${duplicate}`);
  for (const slice of plan.slices) {
    const unknown = (slice.depends_on ?? []).find(id => !ids.includes(id));
    if (unknown) invalid(`slice ${slice.id} depends on unknown slice ${unknown}`);
    const missing = slice.implements.find(id => !requirements.some(requirement => requirement.id === id));
    if (missing) invalid(`slice ${slice.id} implements "${missing}", which is not a requirement in this change's deltas`);
    const escaping = (slice.paths ?? []).find(path => path.startsWith('/') || path.split('/').includes('..'));
    if (escaping) invalid(`slice ${slice.id} path leaves the repository: ${escaping}`);
  }
  const loop = cycle(plan.slices);
  if (loop) invalid(`dependency cycle ${loop.join(' -> ')}`);
  const storeId = await storeIdentity(root, source);
  const parties = storeId ? (await loadParties(root, await (source ?? openSpec(root)).list())).parties : null;
  for (const slice of plan.slices) {
    if (!parties && slice.repo) invalid(`slice ${slice.id} names repo ${slice.repo}, but only a store's change lands slices in party repositories`);
    if (parties && !slice.repo) invalid(`slice ${slice.id} names no repo; every slice of a store's change names the party it lands in`);
    if (parties && !parties.some(party => party.name === slice.repo)) invalid(`slice ${slice.id} names repo ${slice.repo}, a party ${PARTIES_FILE} does not declare`);
  }
  return { change, file, plan, requirements, parties, storeId };
}
// Slice and requirement states are derived from landing evidence on every call; nothing is stored.
// A party slice is judged only by its party's source, and is unknown when that source can't be read:
// no recorded checkout, or none of its remotes is the party upstream.
export function deriveStatus({ change, plan, requirements, parties }, landing) {
  const sourceOf = slice => landing.sources.find(source => source.repo === (slice.repo ?? null));
  const evidence = slice => sourceOf(slice).slices?.get(slice.id) ?? { commits: [], branches: [], pullRequests: [] };
  const states = new Map();
  const slices = (plan?.slices ?? []).map(slice => {
    const found = evidence(slice);
    const landed = found.commits.some(commit => commit.landed) || found.pullRequests.some(pr => pr.landed ?? pr.state === 'MERGED');
    const working = found.commits.length > 0 || found.pullRequests.some(pr => pr.state === 'OPEN' || pr.state === 'MERGED');
    return { slice, found, landed, working, source: sourceOf(slice) };
  });
  for (const { slice, landed, working, source } of slices) {
    states.set(slice.id, source.reason ? 'unknown' : landed ? 'landed' : working ? 'in_progress' : null);
  }
  const result = slices.map(({ slice, found, source }) => {
    const blockedBy = (slice.depends_on ?? []).filter(id => states.get(id) !== 'landed');
    const state = states.get(slice.id) ?? (blockedBy.length ? 'blocked' : 'ready');
    const repo = slice.repo ? { repo: { party: slice.repo, upstream: parties.find(party => party.name === slice.repo).upstream, checkout: source.root } } : {};
    return { id: slice.id, title: slice.title ?? null, ...repo, state, implements: slice.implements, dependsOn: slice.depends_on ?? [],
      ...(state === 'blocked' ? { blockedBy } : {}), ...(state === 'unknown' ? { reason: source.reason, remedies: source.remedies } : {}),
      paths: slice.paths ?? null, commits: found.commits, branches: found.branches, pullRequests: found.pullRequests };
  });
  // An unknown covering slice is not landed, so its requirement is at most partial; with nothing
  // landed or in progress it is unstarted, as for any slice not yet built.
  const requirementStates = requirements.map(requirement => {
    const covering = result.filter(slice => slice.implements.includes(requirement.id));
    const landed = covering.filter(slice => slice.state === 'landed').length;
    const state = !covering.length ? 'unplanned' : landed === covering.length ? 'landed' : landed ? 'partial'
      : covering.some(slice => slice.state === 'in_progress') ? 'in_progress' : 'unstarted';
    return { id: requirement.id, spec: requirement.spec, requirement: requirement.requirement, key: requirement.key,
      ops: requirement.ops, state, slices: covering.map(slice => slice.id) };
  });
  const landedRequirements = requirementStates.filter(requirement => requirement.state === 'landed').length;
  // A repository plan has one base; a store plan has one per party it names.
  const [own] = landing.sources;
  const where = parties
    ? { repos: landing.sources.map(({ repo, upstream, root, remote, base, pullRequests, reason }) => ({ party: repo, upstream, checkout: root,
      ...(reason ? { reason } : { remote, base, pullRequests }) })) }
    : { base: own.base };
  return { change, plan: plan ? 'present' : 'absent', ...where, slices: result, requirements: requirementStates,
    totals: { slices: { landed: result.filter(slice => slice.state === 'landed').length, total: result.length },
      requirements: { landed: landedRequirements, total: requirementStates.length },
      readyToReconcile: requirementStates.length > 0 && landedRequirements === requirementStates.length },
    ...(parties ? {} : { pullRequests: own.pullRequests }) };
}
