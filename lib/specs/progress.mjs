import { fail, MAX_OUTPUT } from '../files.mjs';
import { openSpec } from './openspec.mjs';
import { loadPlan, deriveStatus } from './slices.mjs';
import { landing, changedFiles, changeId } from './landing.mjs';
import { testLinks, storeLinks } from './links.mjs';

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
// A store change's tests live in its parties, read at a named commit in the party's checkout,
// once per party and commit however many slices ask.
function partyReader({ loaded }) {
  const cache = new Map();
  return (source, commit) => {
    const id = `${source.repo}\0${commit}`;
    if (!cache.has(id)) cache.set(id, storeLinks(source.root, loaded.storeId, commit)
      .then(found => found.map(({ key, file, line }) => ({ key, repo: source.repo, file, line, commit }))));
    return cache.get(id);
  };
}
// A landed party slice's links are read at its party's base commit; an in-progress one's at its
// latest trailer commit (the newest in log order), which exists locally because it was found there. A slice in progress
// only through a pull request has no such commit, and nothing is fetched to get one.
async function partySliceLinks({ evidence }, slice, read) {
  const source = evidence.sources.find(item => item.repo === slice.repo.party);
  if (source.reason) return { repo: source.repo, status: 'not_collected', reason: source.reason, links: [] };
  const commit = slice.state === 'landed' ? source.base.commit : slice.commits[0]?.sha;
  if (!commit) return { repo: source.repo, status: 'not_collected', reason: 'no_local_commit', links: [] };
  return { repo: source.repo, status: 'collected', commit, links: await read(source, commit) };
}
// Review links for a started slice: the repository's own `test/` links, or the party's.
function reviewLinks(root, collected) {
  if (!collected.loaded.parties) {
    let list;
    return async (slice, keys) => (list ??= await links(root)).filter(link => keys.includes(link.key)).map(({ key, kind, file, line }) => ({ key, kind, file, line }));
  }
  const read = partyReader(collected);
  return async (slice, keys) => {
    const found = await partySliceLinks(collected, slice, read);
    return { ...found, links: found.links.filter(link => keys.includes(link.key)) };
  };
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
// A party packet carries its destination, so a worker started anywhere can act on it alone: the
// store, and the party with its upstream, recorded checkout and party remote. A fork's `origin`
// is not the party, so the packet names the remote to branch from and open the pull request to.
function destination({ loaded, evidence }, slice) {
  if (!slice.repo) return {};
  const { remote = null } = evidence.sources.find(source => source.repo === slice.repo.party);
  return { store: loaded.storeId, repo: { ...slice.repo, remote } };
}
async function packet(root, collected, slice, canonical, linked) {
  const { loaded, status } = collected;
  // Each dependency of a party slice names the repository its commits landed in.
  const repoOf = id => slice.repo ? { repo: loaded.plan.slices.find(item => item.id === id).repo } : {};
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
    return { id, ...repoOf(id), state: dependency.state, commits: dependency.commits.filter(commit => commit.landed).map(commit => commit.sha) };
  });
  const result = { change: loaded.change, slice: { id: slice.id, title: slice.title, state: slice.state }, ...destination(collected, slice),
    base: baseOf(status, slice), requirements, dependencies, paths: slice.paths, trailers: trailers(changeId(loaded), slice.id) };
  if (['landed', 'in_progress'].includes(slice.state)) {
    const scenarioKeys = requirements.flatMap(item => (item.delta?.scenarios ?? []).map(scenario => `${item.spec} / ${scenario.name}`));
    result.review = { commits: slice.commits, branches: slice.branches, pullRequests: slice.pullRequests,
      linkedTests: await linked(slice, scenarioKeys) };
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
  const linked = reviewLinks(root, collected);
  const packets = [];
  for (const slice of ready) packets.push(await packet(root, collected, slice, canonical, linked));
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
  return bounded({ root, ...await packet(root, collected, slice, await canonicalText(source), reviewLinks(root, collected)) });
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
// A store change's untested scenarios come from every party a slice names: each party read at its
// base commit, and each in-progress slice at its latest trailer commit; the union counts. They are
// not_collected only when no party could be read. Every read names its repository and commit.
async function partyUntested(collected, scenarios) {
  const { evidence, status } = collected;
  const read = partyReader(collected);
  const reads = [];
  for (const source of evidence.sources) {
    reads.push(source.reason ? { repo: source.repo, status: 'not_collected', reason: source.reason, links: [] }
      : { repo: source.repo, status: 'collected', commit: source.base.commit, links: await read(source, source.base.commit) });
  }
  for (const slice of status.slices.filter(item => item.state === 'in_progress')) {
    const { repo, ...found } = await partySliceLinks(collected, slice, read);
    reads.push({ repo, slice: slice.id, ...found });
  }
  // A link unchanged between a party's base and a slice's commit is listed once, as read first.
  const keyOf = item => `${item.spec} / ${item.scenario}`;
  const keys = new Set(scenarios.map(keyOf));
  const found = new Map();
  for (const link of reads.flatMap(item => item.links)) {
    const id = JSON.stringify([link.key, link.repo, link.file, link.line]);
    if (keys.has(link.key) && !found.has(id)) found.set(id, link);
  }
  const linked = new Set([...found.values()].map(link => link.key));
  const collectedAny = reads.some(item => item.status === 'collected');
  return { status: collectedAny ? 'collected' : 'not_collected', scenarios: collectedAny ? scenarios.filter(item => !linked.has(keyOf(item))) : [],
    links: [...found.values()], reads: reads.map(({ links: _links, ...item }) => item) };
}
export async function reconcileChange(root, change, source = openSpec(root), workspace = root) {
  const collected = await collect(root, change, source, workspace);
  const { loaded, evidence, status } = collected;
  // A party slice's files are in its party's repository and are labeled with it; files are
  // shared only between slices of the same repository. The change's own files live where it is
  // planned, so only there are they set aside.
  const own = `openspec/changes/${change}/`;
  const touched = new Map();
  const slices = [];
  for (const slice of status.slices) {
    const repo = slice.repo?.party ?? null;
    const files = new Set();
    for (const commit of slice.commits) for (const file of await changedFiles(slice.repo?.checkout ?? root, commit.sha)) if (repo || !file.startsWith(own)) files.add(file);
    const sorted = [...files].sort();
    for (const file of sorted) {
      const id = JSON.stringify([repo, file]);
      touched.set(id, [...(touched.get(id) ?? []), slice.id]);
    }
    const patterns = slice.paths?.map(glob);
    slices.push({ id: slice.id, ...(repo ? { repo } : {}), state: slice.state, scope: patterns ? 'checked' : 'unchecked', files: sorted,
      outOfScope: patterns ? sorted.filter(file => !patterns.some(pattern => pattern.test(file))) : [] });
  }
  const known = new Set(status.slices.map(slice => slice.id));
  const strayTrailers = evidence.sources.flatMap(found => [...found.stray ?? [], ...(found.commits ?? []).flatMap(commit => commit.slices
    .filter(id => !known.has(id)).map(slice => ({ sha: commit.sha, subject: commit.subject, slice })))]);
  const scenarios = loaded.requirements.filter(item => !(item.ops.length === 1 && item.ops[0] === 'REMOVED'))
    .flatMap(item => (item.scenarios ?? []).map(scenario => ({ spec: item.spec, requirement: item.requirement, scenario: scenario.name })));
  let untested;
  if (loaded.parties) untested = await partyUntested(collected, scenarios);
  else {
    const testLinkList = await links(root);
    const linked = new Set(testLinkList.map(link => link.key));
    untested = testLinkList.length
      ? { status: 'collected', scenarios: scenarios.filter(item => !linked.has(`${item.spec} / ${item.scenario}`)) }
      : { status: 'not_collected', scenarios: [] };
  }
  return bounded({ root, change, slices,
    sharedFiles: [...touched].filter(([, ids]) => ids.length > 1).map(([id, ids]) => {
      const [repo, file] = JSON.parse(id);
      return { ...(repo ? { repo } : {}), file, slices: ids };
    }),
    strayTrailers, uncovered: status.requirements.filter(item => item.state === 'unplanned').map(item => item.id),
    untested, status });
}
