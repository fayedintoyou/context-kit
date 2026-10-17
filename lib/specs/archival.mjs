import { errorData } from '../files.mjs';
import { openSpec } from './openspec.mjs';
import { loadPlan, deriveStatus } from './slices.mjs';
import { landing } from './landing.mjs';

// Ready means OpenSpec counts every task ticked and, with a slice plan, every slice has
// landed on the base. An unticked task is how a finished-looking change is held open.
export async function archivable(root) {
  const source = openSpec(root);
  const changes = (await source.changes()).sort((a, b) => a.name.localeCompare(b.name));
  const result = [];
  for (const change of changes) {
    const blockers = [];
    if (!change.totalTasks) blockers.push({ code: 'no_tasks' });
    else if (change.completedTasks < change.totalTasks) blockers.push({ code: 'tasks_incomplete' });
    let plan = 'absent';
    try {
      const loaded = await loadPlan(root, change.name);
      if (loaded.plan) {
        plan = 'present';
        const status = deriveStatus(loaded, await landing(root, change.name, loaded.plan.base));
        const unlanded = status.slices.filter(slice => slice.state !== 'landed').map(slice => slice.id);
        if (unlanded.length) blockers.push({ code: 'slices_unlanded', slices: unlanded });
      }
    } catch (error) {
      plan = 'invalid';
      blockers.push({ code: 'invalid_plan', ...errorData(error) });
    }
    result.push({ name: change.name, tasks: { completed: change.completedTasks, total: change.totalTasks },
      plan, ready: !blockers.length, blockers });
  }
  return { root, changes: result };
}
// Archives only ready changes and never commits; the caller decides what to do with the tree.
export async function archiveReady(root) {
  const { changes } = await archivable(root);
  const source = openSpec(root);
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
