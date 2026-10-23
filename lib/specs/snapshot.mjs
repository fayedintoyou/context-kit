import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fail, MAX_OUTPUT } from '../files.mjs';
import { git as runGit } from '../git-env.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function gitState(root) {
  async function git(args) {
    return (await runGit(root, args, { timeout: 10000 })).stdout.trim();
  }
  let topLevel;
  try { topLevel = await realpath(await git(['rev-parse', '--show-toplevel'])); }
  catch { return { head: null, dirty: null, status: 'not_a_git_repository' }; }
  let head = null;
  try { head = await git(['rev-parse', '--verify', 'HEAD']); } catch { /* An unborn repository has no HEAD. */ }
  // HEAD belongs to the enclosing repository; dirty covers only the audited root.
  return { gitRoot: topLevel, rootIsGitRoot: topLevel === await realpath(root), head,
    dirty: Boolean(await git(['status', '--porcelain', '--untracked-files=all', '--', '.'])) };
}
async function collect(source, budget) {
  const inventory = (await source.list()).sort((a, b) => a.id.localeCompare(b.id));
  const specs = [];
  for (const { id } of inventory) {
    const spec = await source.read(id);
    budget.bytes += Buffer.byteLength(JSON.stringify(spec));
    if (budget.bytes > MAX_OUTPUT) fail('TOO_LARGE', 'Canonical specs exceed the MVP audit budget');
    specs.push(spec);
  }
  return { specs, contentHash: hash(JSON.stringify(specs.map(({ id, content }) => ({ id, content })))) };
}
export async function snapshot(sources) {
  const budget = { bytes: 0 };
  const states = [];
  for (const source of sources) states.push({ git: await gitState(source.root), ...await collect(source, budget) });
  return states;
}
export const requirementKey = (spec, name) => spec + ':' + hash(name.normalize('NFKC').trim().toLowerCase()).slice(0, 16);
