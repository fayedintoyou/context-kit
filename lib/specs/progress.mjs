import { fail, MAX_OUTPUT } from '../files.mjs';
import { openSpec } from './openspec.mjs';
import { loadPlan, deriveStatus } from './slices.mjs';
import { landing, changedFiles, changeId } from './landing.mjs';
import { testLinks } from './links.mjs';

function bounded(result) {
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > MAX_OUTPUT) fail('TOO_LARGE', 'Change progress exceeds the output budget');
  return result;
}
// Party checkouts come from the workspace's registry; the plan root may be a store's.
async function collect(root, change, source, workspace) {
  const loaded = await loadPlan(root, change, source);
  const evidence = await landing(loaded, root, workspace);
  return { loaded, evidence, status: deriveStatus(loaded, evidence) };
}
const trailers = (change, slice) => `OpenSpec-Change: ${change}\nOpenSpec-Slice: ${slice}`;
// A party slice is built against its party's base; a repository's slices share one.
const baseOf = (status, slice) => slice.repo ? status.repos.find(repo => repo.party === slice.repo.party).base ?? null : status.base;
async function links(root) {
  return (await testLinks(root)).filter(link => link.attached && (link.kind === 'e2e' || link.kind === 'manual' || (link.kind === 'unit' && link.justified)));
}
// Canonical text comes from the source the change is planned in: the repository, or a store.
async function canonicalText(source) {
  const cache = new Map();
  let available;
  return async (spec, name) => {
    available ??= new Set((await source.list().catch(() => [])).map(item => item.id));
    if (!available.has(spec)) return null;
    if (!cache.has(spec)) cache.set(spec, await source.read(spec));
    const found = cache.get(spec).requirements.find(requirement => requirement.name === name);
    return found ? { text: found.text, scenarios: found.scenarios } : null;
  };
}
async function packet(root, collected, slice, canonical, testLinkList) {
  const { loaded, status } = collected;
  const requirements = [];
  for (const id of slice.implements) {
    const requirement = loaded.requirements.find(item => item.id === id);
    const replaces = requirement.ops.some(op => ['MODIFIED', 'REMOVED', 'RENAMED'].includes(op));
    requirements.push({ id, spec: requirement.spec, requirement: requirement.requirement, key: requirement.key, ops: requirement.ops,
      delta: requirement.text === undefined ? null : { text: requirement.text, scenarios: requirement.scenarios },
      canonical: replaces ? await canonical(requirement.spec, requirement.from ?? requirement.requirement) : null });
  }
  const dependencies = slice.dependsOn.map(id => {
    const dependency = status.slices.find(item => item.id === id);
    return { id, state: dependency.state, commits: dependency.commits.filter(commit => commit.landed).map(commit => commit.sha) };
  });
  const result = { change: loaded.change, slice: { id: slice.id, title: slice.title, state: slice.state }, base: baseOf(status, slice),
    requirements, dependencies, paths: slice.paths, trailers: trailers(changeId(loaded), slice.id) };
  if (['landed', 'in_progress'].includes(slice.state)) {
    const scenarioKeys = requirements.flatMap(item => (item.delta?.scenarios ?? []).map(scenario => `${item.spec} / ${scenario.name}`));
    result.review = { commits: slice.commits, branches: slice.branches, pullRequests: slice.pullRequests,
      linkedTests: testLinkList.filter(link => scenarioKeys.includes(link.key)).map(({ key, kind, file, line }) => ({ key, kind, file, line })) };
  }
  return result;
}
export async function changeStatus(root, change, source = openSpec(root), workspace = root) {
  return bounded({ root, ...(await collect(root, change, source, workspace)).status });
}
export async function nextSlices(root, change, source = openSpec(root), workspace = root) {
  const collected = await collect(root, change, source, workspace);
  const { status } = collected;
  const ready = status.slices.filter(slice => slice.state === 'ready');
  const canonical = await canonicalText(source);
  const testLinkList = await links(root);
  const packets = [];
  for (const slice of ready) packets.push(await packet(root, collected, slice, canonical, testLinkList));
  const reason = packets.length ? null : status.plan === 'absent' ? 'no_plan'
    : status.slices.every(slice => slice.state === 'landed') ? 'all_landed' : 'nothing_ready';
  return bounded({ root, change, packets, ...(reason ? { reason } : {}),
    waiting: status.slices.filter(slice => ['in_progress', 'blocked', 'unknown'].includes(slice.state))
      .map(({ id, state, blockedBy, reason, branches, pullRequests }) => ({ id, state, ...(blockedBy ? { blockedBy } : {}), ...(reason ? { reason } : {}),
        branches, pullRequests })) });
}
export async function readSlice(root, change, id, source = openSpec(root), workspace = root) {
  const collected = await collect(root, change, source, workspace);
  const slice = collected.status.slices.find(item => item.id === id);
  if (!slice) fail('NOT_FOUND', `No slice ${id} in ${change}`);
  return bounded({ root, ...await packet(root, collected, slice, await canonicalText(source), await links(root)) });
}
function glob(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') { source += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}${pattern.endsWith('/') ? '.*' : ''}$`);
}
export async function reconcileChange(root, change, source = openSpec(root), workspace = root) {
  const { loaded, evidence, status } = await collect(root, change, source, workspace);
  const own = `openspec/changes/${change}/`;
  const touched = new Map();
  const slices = [];
  for (const slice of status.slices) {
    const files = new Set();
    for (const commit of slice.commits) for (const file of await changedFiles(slice.repo?.checkout ?? root, commit.sha)) if (!file.startsWith(own)) files.add(file);
    const sorted = [...files].sort();
    for (const file of sorted) touched.set(file, [...(touched.get(file) ?? []), slice.id]);
    const patterns = slice.paths?.map(glob);
    slices.push({ id: slice.id, state: slice.state, scope: patterns ? 'checked' : 'unchecked', files: sorted,
      outOfScope: patterns ? sorted.filter(file => !patterns.some(pattern => pattern.test(file))) : [] });
  }
  const known = new Set(status.slices.map(slice => slice.id));
  const strayTrailers = evidence.sources.flatMap(found => [...found.stray ?? [], ...(found.commits ?? []).flatMap(commit => commit.slices
    .filter(id => !known.has(id)).map(slice => ({ sha: commit.sha, subject: commit.subject, slice })))]);
  const testLinkList = await links(root);
  const linked = new Set(testLinkList.map(link => link.key));
  const scenarios = loaded.requirements.filter(item => !(item.ops.length === 1 && item.ops[0] === 'REMOVED'))
    .flatMap(item => (item.scenarios ?? []).map(scenario => ({ spec: item.spec, requirement: item.requirement, scenario: scenario.name })));
  return bounded({ root, change, slices,
    sharedFiles: [...touched].filter(([, ids]) => ids.length > 1).map(([file, ids]) => ({ file, slices: ids })),
    strayTrailers, uncovered: status.requirements.filter(item => item.state === 'unplanned').map(item => item.id),
    untested: testLinkList.length
      ? { status: 'collected', scenarios: scenarios.filter(item => !linked.has(`${item.spec} / ${item.scenario}`)) }
      : { status: 'not_collected', scenarios: [] },
    status });
}
