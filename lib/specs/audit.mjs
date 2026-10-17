import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fail, MAX_OUTPUT } from '../files.mjs';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
async function gitState(root) {
  async function git(args) {
    return (await exec('git', args, { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  }
  try { await git(['rev-parse', '--show-toplevel']); }
  catch { return { head: null, dirty: null, status: 'not_a_git_repository' }; }
  let head = null;
  try { head = await git(['rev-parse', '--verify', 'HEAD']); } catch { /* An unborn repository has no HEAD. */ }
  return { head, dirty: Boolean(await git(['status', '--porcelain', '--untracked-files=all'])) };
}
async function collect(source) {
  const inventory = (await source.list()).sort((a, b) => a.id.localeCompare(b.id));
  const specs = [];
  let bytes = 0;
  for (const { id } of inventory) {
    const spec = await source.read(id);
    bytes += Buffer.byteLength(JSON.stringify(spec));
    if (bytes > MAX_OUTPUT) fail('TOO_LARGE', 'Canonical specs exceed the MVP audit budget');
    specs.push(spec);
  }
  return { specs, contentHash: hash(JSON.stringify(specs.map(({ id, content }) => ({ id, content })))) };
}
export async function auditSpecs(source) {
  // Resolve first: a store's root comes from the OpenSpec registry, not the workspace.
  await source.list();
  const root = source.root;
  const before = await gitState(root);
  const { specs, contentHash } = await collect(source);
  const structural = specs.length ? await source.validate() : { strict: true, valid: false, items: [] };
  const after = await gitState(root);
  const second = await collect(source);
  if (JSON.stringify(before) !== JSON.stringify(after) || contentHash !== second.contentHash) {
    fail('SNAPSHOT_CHANGED', 'Repository or specs changed during audit; retry on a stable tree');
  }
  const checklist = specs.flatMap(spec => spec.requirements.map(requirement => ({
    key: spec.id + ':' + hash(requirement.name.normalize('NFKC').trim().toLowerCase()).slice(0, 16),
    spec: spec.id, requirement: requirement.name, text: requirement.text,
    scenarios: requirement.scenarios, semantic: 'not_assessed', evidence: [],
  })));
  if (new Set(checklist.map(item => item.key)).size !== checklist.length) {
    fail('DUPLICATE_REQUIREMENT', 'Requirement names must be unique within a canonical spec');
  }
  return { root, source: source.source, adapter: { name: source.name, version: source.version },
    status: specs.length ? (structural.valid ? 'structurally_valid' : 'structurally_invalid') : 'no_canonical_specs',
    semantic: 'not_assessed', snapshot: { ...after, canonicalHash: contentHash,
      implementationEvidence: 'not_collected' }, structural, checklist };
}
