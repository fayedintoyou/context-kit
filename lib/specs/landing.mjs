import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from '../files.mjs';

const exec = promisify(execFile);
const options = { timeout: 15000, maxBuffer: 8 * 1024 * 1024 };
async function git(root, args) {
  return (await exec('git', args, { cwd: root, ...options })).stdout;
}
async function exists(root, ref) {
  try { await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
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
// Pull requests are optional enrichment: without gh, git evidence alone decides each state.
async function pullRequests(root, change) {
  let output;
  try { output = (await exec('gh', ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,headRefName,body,url'], { cwd: root, ...options })).stdout; }
  catch (error) {
    const reason = error.code === 'ENOENT' ? 'gh is not installed' : ((error.stderr || '').trim().split('\n').find(Boolean) || 'gh failed');
    return { status: 'not_collected', reason, items: [] };
  }
  let list;
  try { list = JSON.parse(output); } catch { return { status: 'not_collected', reason: 'gh returned unexpected output', items: [] }; }
  const items = list.flatMap(pr => {
    const body = pr.body ?? '';
    return [{ number: pr.number, state: pr.state, url: pr.url, headRefName: pr.headRefName,
      changes: values(body, 'OpenSpec-Change'), slices: values(body, 'OpenSpec-Slice') }];
  });
  return { status: 'collected', items };
}
export async function landing(root, change, planned) {
  const base = await resolveBase(root, planned);
  const landedShas = new Set((await trailerLog(root, change, base.refs)).map(commit => commit.sha));
  const all = await trailerLog(root, change, ['--branches', '--remotes']);
  const baseNames = new Set([...base.refs, 'origin/HEAD', 'origin']);
  const slices = new Map();
  const entry = id => {
    if (!slices.has(id)) slices.set(id, { commits: [], branches: [], pullRequests: [] });
    return slices.get(id);
  };
  for (const commit of all) {
    const landed = landedShas.has(commit.sha);
    const branches = landed ? [] : (await git(root, ['for-each-ref', '--contains', commit.sha, '--format=%(refname:short)', 'refs/heads', 'refs/remotes']))
      .split('\n').map(name => name.trim()).filter(name => name && !baseNames.has(name));
    for (const id of commit.slices) {
      const found = entry(id);
      found.commits.push({ sha: commit.sha, date: commit.date, subject: commit.subject, landed });
      for (const branch of branches) if (!found.branches.includes(branch)) found.branches.push(branch);
    }
  }
  const prs = await pullRequests(root, change);
  for (const pr of prs.items) {
    const ids = new Set(pr.changes.includes(change) ? pr.slices : []);
    for (const [id, found] of slices) if (found.branches.some(branch => branch === pr.headRefName || branch.endsWith(`/${pr.headRefName}`))) ids.add(id);
    if (pr.state === 'CLOSED') continue;
    for (const id of ids) entry(id).pullRequests.push({ number: pr.number, state: pr.state, url: pr.url });
  }
  const stray = all.filter(commit => !commit.slices.length).map(commit => ({ sha: commit.sha, subject: commit.subject, slice: null }));
  return { base, slices, commits: all, stray, pullRequests: { status: prs.status, ...(prs.reason ? { reason: prs.reason } : {}) } };
}
export async function changedFiles(root, sha) {
  return (await git(root, ['diff-tree', '-r', '--name-only', '--no-commit-id', '--root', '-m', '--first-parent', sha]))
    .split('\n').map(line => line.trim()).filter(Boolean);
}
