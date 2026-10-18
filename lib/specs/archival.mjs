import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorData } from '../files.mjs';
import { openSpec } from './openspec.mjs';
import { loadPlan, deriveStatus } from './slices.mjs';
import { landing } from './landing.mjs';

// Archive order: by name. archivable, archiveReady and the rehearsal all walk changes this way.
const inArchiveOrder = async source => (await source.changes()).sort((a, b) => a.name.localeCompare(b.name));

// Ready means OpenSpec counts every task ticked and, with a slice plan, every slice has
// landed on its base. An unticked task is how a finished-looking change is held open.
// The source is the repository at root, or the store whose root it is. Each unlanded slice is
// named by exactly one blocker: evidence_missing when its party's evidence can't be read
// (state unknown, with the party and reason), else slices_unlanded.
export async function archivable(root, source = openSpec(root), workspace = root) {
  const changes = await inArchiveOrder(source);
  const result = [];
  for (const change of changes) {
    const blockers = [];
    if (!change.totalTasks) blockers.push({ code: 'no_tasks' });
    else if (change.completedTasks < change.totalTasks) blockers.push({ code: 'tasks_incomplete' });
    let plan = 'absent';
    try {
      const loaded = await loadPlan(root, change.name, source);
      if (loaded.plan) {
        plan = 'present';
        const status = deriveStatus(loaded, await landing(loaded, root, workspace));
        const unknown = status.slices.filter(slice => slice.state === 'unknown')
          .map(slice => ({ id: slice.id, party: slice.repo.party, reason: slice.reason, remedies: slice.remedies }));
        const unlanded = status.slices.filter(slice => !['landed', 'unknown'].includes(slice.state)).map(slice => slice.id);
        if (unknown.length) blockers.push({ code: 'evidence_missing', slices: unknown });
        if (unlanded.length) blockers.push({ code: 'slices_unlanded', slices: unlanded });
      }
    } catch (error) {
      // The blocker's code stays invalid_plan; the failure's own code and message go under error.
      plan = 'invalid';
      blockers.push({ code: 'invalid_plan', error: errorData(error) });
    }
    result.push({ name: change.name, tasks: { completed: change.completedTasks, total: change.totalTasks },
      plan, ready: !blockers.length, blockers });
  }
  return { root, changes: result };
}
// Archives only ready changes and never commits; the caller decides what to do with the tree.
export async function archiveReady(root, source = openSpec(root), workspace = root) {
  const { changes } = await archivable(root, source, workspace);
  const archived = [];
  const skipped = changes.filter(change => !change.ready).map(({ name, blockers }) => ({ name, blockers }));
  for (const change of changes.filter(change => change.ready)) {
    try { archived.push(await source.archive(change.name)); }
    catch (error) { return { root, archived, skipped, valid: false, error: { change: change.name, ...errorData(error) } }; }
  }
  if (!archived.length) return { root, archived, skipped, valid: true, validation: null };
  const validation = await source.validate();
  return { root, archived, skipped, valid: validation.valid, validation };
}

// Strict validation issues of a root, each naming its spec and, when OpenSpec reports a position
// like requirements[2], the requirement's name: an index alone doesn't say which one to fix.
async function issuesOf(source) {
  const result = [];
  for (const { id, issues } of (await source.validate()).items.filter(item => item.issues.length)) {
    const names = (await source.read(id).catch(() => ({ requirements: [] }))).requirements.map(requirement => requirement.name);
    for (const { level = null, path = null, message = null } of issues) {
      const index = /^requirements\[(\d+)\]/.exec(path ?? '')?.[1];
      result.push({ spec: id, requirement: index === undefined ? null : names[index] ?? null, path, level, message });
    }
  }
  return result;
}
// An index shifts when an earlier requirement comes or goes, so a named requirement identifies an issue.
const issueKey = ({ spec, requirement, path, level, message }) => [spec, requirement ?? path, level, message].join('\0');
// Asks "will this archive cleanly" of every active change, ready or not: in a pull request a change
// is unfinished by design. Each is archived, in archive order and through the same OpenSpec path as
// archiveReady, into a scratch copy of the root's openspec/, and the copy is validated strictly after
// each one, so an issue is attributed to the change that introduced it. Issues already there before
// any change are the baseline. Nothing under root changes.
export async function rehearseArchive(root, source = openSpec(root)) {
  const names = (await inArchiveOrder(source)).map(change => change.name);
  const scratch = await mkdtemp(join(tmpdir(), 'context-kit-rehearsal-'));
  try {
    // Dereferenced, so a symlink inside openspec/ can't let the copy's archive write through to root.
    await cp(join(root, 'openspec'), join(scratch, 'openspec'), { recursive: true, dereference: true });
    const copy = openSpec(scratch);
    const baseline = await issuesOf(copy);
    let known = new Set(baseline.map(issueKey));
    const changes = [];
    for (const name of names) {
      try { await copy.archive(name); }
      // A change that can't be applied at all, such as MODIFIED of a missing requirement, is its own issue.
      catch (error) {
        changes.push({ name, issues: [{ spec: null, requirement: null, path: null, level: 'ERROR', message: error.message }] });
        continue;
      }
      const after = await issuesOf(copy);
      changes.push({ name, issues: after.filter(issue => !known.has(issueKey(issue))) });
      known = new Set(after.map(issueKey));
    }
    return { root, changes, baseline, valid: changes.every(change => !change.issues.length) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
