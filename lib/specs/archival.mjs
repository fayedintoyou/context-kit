import { errorData } from '../files.mjs';
import { openSpec } from './openspec.mjs';
import { loadPlan, deriveStatus } from './slices.mjs';
import { landing } from './landing.mjs';

// Ready means OpenSpec counts every task ticked and, with a slice plan, every slice has
// landed on its base. An unticked task is how a finished-looking change is held open.
// The source is the repository at root, or the store whose root it is. Each unlanded slice is
// named by exactly one blocker: evidence_missing when its party's evidence can't be read
// (state unknown, with the party and reason), else slices_unlanded.
export async function archivable(root, source = openSpec(root), workspace = root) {
  const changes = (await source.changes()).sort((a, b) => a.name.localeCompare(b.name));
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
