import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from '../files.mjs';
import { normalizeUpstream, recordedCheckout } from '../repos.mjs';

const exec = promisify(execFile);
const options = { timeout: 15000, maxBuffer: 8 * 1024 * 1024 };
async function git(root, args) {
  return (await exec('git', args, { cwd: root, ...options })).stdout;
}
async function exists(root, ref) {
  try { await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
}
async function first(root, refs) {
  for (const ref of refs) if (await exists(root, ref)) return ref;
  return null;
}
// The plan's base, else the remote's default branch, else main or master, else the current
// branch; a feature branch must not become the base just because it is checked out. A local base
// and its remote-tracking branch both count, so landing does not depend on a recent pull.
async function resolveBase(root, planned) {
  try { await git(root, ['rev-parse', '--git-dir']); }
  catch { fail('NOT_A_GIT_REPOSITORY', 'Change progress is derived from git; the repository is not a git checkout'); }
  let ref = planned;
  if (!ref) {
    try { ref = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, ''); }
    catch {
      for (const candidate of ['main', 'master']) if (!ref && await exists(root, candidate)) ref = candidate;
      ref ??= (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || 'HEAD';
    }
  }
  const refs = [];
  for (const candidate of [ref, `origin/${ref}`]) if (await exists(root, candidate)) refs.push(candidate);
  if (!refs.length && planned) fail('INVALID_CONFIG', `Base branch not found: ${planned}`);
  const commit = refs.length ? (await git(root, ['rev-parse', refs[0]])).trim() : null;
  return { ref, refs, commit };
}
// A party's evidence comes from the remote whose URL is its upstream, never `origin` by
// assumption: a fork's `origin` is the fork. Without such a remote the checkout says nothing
// about the party, so its local branches are never taken for what landed upstream.
async function partyRemote(root, party) {
  let listed;
  try { listed = await git(root, ['remote', '-v']); }
  catch { fail('NOT_A_GIT_REPOSITORY', `The checkout recorded for party ${party.name} is not a git checkout: ${root}`); }
  const key = normalizeUpstream(party.upstream);
  const matches = url => { try { return normalizeUpstream(url) === key; } catch { return false; } };
  return listed.split('\n').map(line => line.split(/\s+/)).find(([, url]) => url && matches(url))?.[0] ?? null;
}
// The base branch is the plan's, else the party remote's default branch, else main or master;
// the base commit is only ever that remote's fetched tip of it. A local branch is never taken
// for what landed upstream: missing tracking data proves nothing, so without a tip the
// party's evidence is unreadable (null) and its slices are unknown until it is fetched.
async function resolvePartyBase(root, remote, planned) {
  let ref = planned;
  if (!ref) ref = (await git(root, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim().slice(remote.length + 1) || undefined;
  // Always the fully qualified ref: an abbreviated `origin/main` can resolve to a local
  // branch of that name (refs/heads/origin/main).
  const tracking = name => `refs/remotes/${remote}/${name}`;
  for (const candidate of ['main', 'master']) if (!ref && await first(root, [tracking(candidate)])) ref = candidate;
  if (!ref) return null;
  const tip = await first(root, [tracking(ref)]);
  return tip ? { ref, refs: [tip], commit: (await git(root, ['rev-parse', tip])).trim() } : null;
}
// Trailer lines count anywhere in the message, not only in git's final trailer block:
// squash merges stack several commit messages, and a later paragraph (Co-Authored-By)
// would otherwise hide them.
const values = (message, key) => [...message.matchAll(new RegExp(`^${key}:[ \\t]*(\\S+)[ \\t]*$`, 'gm'))].map(match => match[1]);
async function trailerLog(root, change, revisions) {
  if (!revisions.length) return [];
  const output = await git(root, ['log', '-z', '--format=%H%x1f%cI%x1f%s%x1f%B', '-E',
    `--grep=^OpenSpec-Change:[[:space:]]*${change}[[:space:]]*$`, ...revisions, '--']);
  return output.split('\0').filter(Boolean).map(record => {
    const [sha, date, subject, message] = record.replace(/^\n/, '').split('\x1f');
    return { sha, date, subject, changes: values(message, 'OpenSpec-Change'), slices: [...new Set(values(message, 'OpenSpec-Slice'))] };
  }).filter(commit => commit.changes.includes(change));
}
// gh names a repository [HOST/]OWNER/NAME; a local upstream has none.
function ghRepository(upstream) {
  const key = normalizeUpstream(upstream);
  return key.startsWith('file:') ? null : key.replace(/^github\.com\//, '');
}
// Pull requests are optional enrichment: without gh, git evidence alone decides each state.
// A party's come from its upstream by name (`-R` overrides any gh default or GH_REPO), so a
// fork's checkout is never asked about the fork.
async function pullRequests(root, repository) {
  if (repository === null) return { status: 'not_collected', reason: 'the upstream is a local path, not a GitHub repository', items: [] };
  let output;
  try {
    output = (await exec('gh', ['pr', 'list', ...(repository ? ['-R', repository] : []), '--state', 'all', '--limit', '200',
      '--json', 'number,state,headRefName,baseRefName,body,url'], { cwd: root, ...options })).stdout;
  }
  catch (error) {
    const reason = error.code === 'ENOENT' ? 'gh is not installed' : ((error.stderr || '').trim().split('\n').find(Boolean) || 'gh failed');
    return { status: 'not_collected', reason, items: [] };
  }
  let list;
  try { list = JSON.parse(output); } catch { return { status: 'not_collected', reason: 'gh returned unexpected output', items: [] }; }
  const items = list.flatMap(pr => {
    const body = pr.body ?? '';
    return [{ number: pr.number, state: pr.state, url: pr.url, headRefName: pr.headRefName, baseRefName: pr.baseRefName,
      changes: values(body, 'OpenSpec-Change'), slices: values(body, 'OpenSpec-Slice') }];
  });
  return { status: 'collected', items };
}
// Evidence in one checkout against its base. A party's merged pull request lands a slice only
// when it merged into the party's base; it is named either way.
async function evidence(root, change, base, party) {
  const landedShas = new Set((await trailerLog(root, change, base.refs)).map(commit => commit.sha));
  const all = await trailerLog(root, change, ['--branches', '--remotes']);
  const slices = new Map();
  const entry = id => {
    if (!slices.has(id)) slices.set(id, { commits: [], branches: [], pullRequests: [] });
    return slices.get(id);
  };
  for (const commit of all) {
    const landed = landedShas.has(commit.sha);
    // Symbolic refs such as origin/HEAD (listed as "origin") are aliases, not branches.
    const branches = landed ? [] : (await git(root, ['for-each-ref', '--contains', commit.sha, '--format=%(refname:short)%09%(refname)%09%(symref)', 'refs/heads', 'refs/remotes']))
      .split('\n').map(line => line.split('\t'))
      .filter(([name, full, symref]) => name && !symref && !base.refs.includes(name) && !base.refs.includes(full)).map(([name]) => name);
    for (const id of commit.slices) {
      const found = entry(id);
      found.commits.push({ sha: commit.sha, date: commit.date, subject: commit.subject, landed });
      for (const branch of branches) if (!found.branches.includes(branch)) found.branches.push(branch);
    }
  }
  const prs = await pullRequests(root, party ? ghRepository(party.upstream) : undefined);
  for (const pr of prs.items) {
    const ids = new Set(pr.changes.includes(change) ? pr.slices : []);
    // A party's pull request counts only by its own trailers: a branch name is no evidence
    // across a fork and its upstream, where unrelated work can share it.
    if (!party) for (const [id, found] of slices) if (found.branches.some(branch => branch === pr.headRefName || branch.endsWith(`/${pr.headRefName}`))) ids.add(id);
    if (pr.state === 'CLOSED') continue;
    const named = { number: pr.number, state: pr.state, url: pr.url,
      ...(party ? { baseRefName: pr.baseRefName, landed: pr.state === 'MERGED' && pr.baseRefName === base.ref } : {}) };
    for (const id of ids) entry(id).pullRequests.push(named);
  }
  const stray = all.filter(commit => !commit.slices.length).map(commit => ({ sha: commit.sha, subject: commit.subject, slice: null }));
  return { base, slices, commits: all, stray, pullRequests: { status: prs.status, ...(prs.reason ? { reason: prs.reason } : {}) } };
}
// A store change's commits carry the store-qualified id, so a party's own change of the same
// name, or another store's, never counts for it.
export const changeId = ({ change, parties, storeId }) => parties ? `${storeId}:${change}` : change;
// Evidence sources: the repository itself for a repository plan, else one per party the plan
// names, at the checkout the workspace records for its upstream. A party without one is
// unknown, never ready or landed, and so is one whose checkout has no remote for its upstream.
export async function landing(loaded, root, workspace) {
  const { plan, parties } = loaded;
  const change = changeId(loaded);
  if (!parties) return { sources: [{ repo: null, root, upstream: null, ...await evidence(root, change, await resolveBase(root, plan?.base)) }] };
  const sources = [];
  for (const party of parties.filter(party => plan.slices.some(slice => slice.repo === party.name))) {
    const checkout = await recordedCheckout(workspace, party.upstream);
    const source = { repo: party.name, root: checkout.path, upstream: party.upstream };
    if (!checkout.path) { sources.push({ ...source, reason: 'checkout_missing', remedies: checkout.remedies }); continue; }
    const remote = await partyRemote(checkout.path, party);
    if (!remote) {
      sources.push({ ...source, reason: 'remote_missing',
        remedies: [`git -C ${checkout.path} remote add <remote> ${party.upstream}`, `git -C ${checkout.path} fetch <remote>`] });
      continue;
    }
    const base = await resolvePartyBase(checkout.path, remote, plan.base);
    if (!base) {
      sources.push({ ...source, remote, reason: 'remote_not_fetched',
        remedies: [`git -C ${checkout.path} fetch ${remote}`] });
      continue;
    }
    sources.push({ ...source, remote, ...await evidence(checkout.path, change, base, party) });
  }
  return { sources };
}
export async function changedFiles(root, sha) {
  return (await git(root, ['diff-tree', '-r', '--name-only', '--no-commit-id', '--root', '-m', '--first-parent', sha]))
    .split('\n').map(line => line.trim()).filter(Boolean);
}
// Slices being delivered on the checked-out branch: those named by this change's trailer commits
// reachable from HEAD but not from the base. A detached HEAD, as in a pull request's merge
// checkout, counts too, though no branch names it.
export async function headSlices(root, change, base) {
  const commits = await trailerLog(root, change, ['HEAD', ...base.refs.map(ref => `^${ref}`)]);
  return new Set(commits.flatMap(commit => commit.slices));
}
// A shallow clone lacks the history landing is read from, so its absence of evidence proves nothing.
export async function shallow(root) {
  return (await git(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
}
