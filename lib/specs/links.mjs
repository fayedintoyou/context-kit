import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { loadPlan, deriveStatus } from './slices.mjs';
import { landing, headSlices, behindSlices, shallow } from './landing.mjs';
import { git as runGit } from '../git-env.mjs';

const linkPattern = /^\s*\/\/\s*spec:\s*(.+?)\s*\/\s*(.+?)\s*$/;
const reasonPattern = /^\s*\/\/\s*because:\s*\S/;
const manualPattern = /^-\s*spec:\s*(.+?)\s*\/\s*(.+?)\s+—\s+(\S.*)$/;

async function files(directory, matches) {
  let entries;
  try { entries = await readdir(directory, { recursive: true, withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isFile() && matches(entry.name))
    .map(entry => join(entry.parentPath, entry.name)).sort();
}

// Every file each scenario appears in: the canonical specs first, then each active change's deltas.
async function occurrences(root) {
  const specRoots = [join(root, 'openspec/specs')];
  for (const entry of await readdir(join(root, 'openspec/changes'), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name !== 'archive') specRoots.push(join(root, 'openspec/changes', entry.name, 'specs'));
  }
  const found = new Map();
  for (const specRoot of specRoots) {
    for (const file of await files(specRoot, name => name === 'spec.md')) {
      const capability = relative(specRoot, file).split(sep).slice(0, -1).join('/');
      let removed = false;
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (line.startsWith('## ')) removed = /^## REMOVED/i.test(line);
        const match = !removed && line.match(/^####\s+Scenario:\s*(.+?)\s*$/);
        if (match) {
          const key = `${capability} / ${match[1]}`;
          const sources = found.get(key) ?? [];
          if (!sources.includes(relative(root, file))) found.set(key, [...sources, relative(root, file)]);
        }
      }
    }
  }
  return found;
}
export async function scenarios(root) {
  return new Map([...await occurrences(root)].map(([key, [source]]) => [key, source]));
}

// A link is a comment block directly above `test(`; unit links must say why e2e cannot show it.
export async function testLinks(root) {
  const links = [];
  for (const file of await files(join(root, 'test'), name => name.endsWith('.test.mjs'))) {
    const kind = relative(join(root, 'test'), file).split(sep)[0];
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(linkPattern);
      if (!match) continue;
      let end = i;
      while (end < lines.length && /^\s*\/\//.test(lines[end])) end++;
      let start = i;
      while (start > 0 && /^\s*\/\//.test(lines[start - 1])) start--;
      const block = lines.slice(start, end);
      links.push({ key: `${match[1]} / ${match[2]}`, kind, file: relative(root, file), line: i + 1,
        attached: /^\s*test\(/.test(lines[end] ?? ''), justified: block.some(line => reasonPattern.test(line)) });
    }
  }
  const manual = await readFile(join(root, 'test/manual-checks.md'), 'utf8').catch(() => '');
  manual.split('\n').forEach((line, i) => {
    const match = line.match(manualPattern);
    if (match) links.push({ key: `${match[1]} / ${match[2]}`, kind: 'manual', file: 'test/manual-checks.md',
      line: i + 1, attached: true, justified: true });
  });
  return links;
}

// Why the repository's test policy (docs/testing.md) rejects a link, apart from the scenario it
// names: none for an attached e2e test, a manual check, or a unit test that says why e2e can't
// show it. Behavior maps derive `tested` only from links with no problem.
export function linkProblems(link) {
  const problems = [];
  if (!link.attached) problems.push('link is not directly above a test(...) call');
  if (!['e2e', 'unit', 'manual'].includes(link.kind)) problems.push('tests must live in test/e2e or test/unit');
  if (link.kind === 'unit' && !link.justified) problems.push('unit link needs a "// because:" line saying why e2e cannot show it');
  return problems;
}

// A party repository links a store's scenario as `// spec: <store-id>:<capability> / <scenario>`
// in any file git tracks, whatever its own test layout. Links are read with git grep at one named
// commit, never from the working tree, and only the store's own qualifier matches: unqualified
// links and other stores' (`other:`) are the party's own business.
export async function storeLinks(root, storeId, commit) {
  const qualified = new RegExp(`//\\s*spec:\\s*${storeId}:(.+?)\\s*/\\s*(.+?)\\s*$`);
  let output;
  try {
    // Display settings (grep.column, color.grep) would change the output's fields, so they are pinned off.
    output = (await runGit(root, ['-c', 'color.grep=never', '-c', 'grep.column=false', 'grep', '--no-color', '--full-name', '-I', '-n', '-z', '-E',
      `//[[:space:]]*spec:[[:space:]]*${storeId}:`, commit, '--', ':/'],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  }
  catch (error) { if (error.code === 1 && !error.stderr) return []; throw error; }
  // Each record is <commit>:<path>\0<line>\0<text>\n. A path may itself hold newlines, so the
  // NUL-delimited fields are consumed before looking for the newline that ends the text.
  const links = [];
  for (let at = 0; at < output.length;) {
    const pathEnd = output.indexOf('\0', at);
    const lineEnd = pathEnd < 0 ? -1 : output.indexOf('\0', pathEnd + 1);
    if (lineEnd < 0) break;
    const textEnd = output.indexOf('\n', lineEnd + 1);
    const text = output.slice(lineEnd + 1, textEnd < 0 ? output.length : textEnd);
    const match = text.match(qualified);
    if (match) links.push({ key: `${match[1]} / ${match[2]}`, file: output.slice(at, pathEnd).slice(commit.length + 1), line: Number(output.slice(pathEnd + 1, lineEnd)) });
    at = textEnd < 0 ? output.length : textEnd + 1;
  }
  return links;
}

// A sliced change is delivered one pull request per slice, so its scenarios wait for a slice
// implementing their requirement to start: landed, by the same evidence as `specs status`, or with
// a trailer commit on HEAD that is not on the base. Each waiting scenario names the slices it waits
// for. Requirements no slice implements are never waiting. Whenever progress can't be read (a
// shallow clone, no git, no default branch to judge landing by, an invalid plan, a store's change,
// whose tests live in its parties) every
// scenario stays required, with a note saying why. Archive readiness needs every slice landed, so
// nothing is still waiting by the time a change can archive. A scenario required only by slices
// that landed on the base, where HEAD has no record of the landing (no trailer or merge commit),
// still fails, and is reported as `behind`, saying only what is known: the branch may be behind
// the base, or may carry the slice's code without its trailers, which trailers can't tell apart.
async function waiting(root) {
  const entries = await readdir(join(root, 'openspec/changes'), { withFileTypes: true }).catch(() => []);
  const planned = [];
  for (const entry of entries.filter(entry => entry.isDirectory() && entry.name !== 'archive')) {
    if (await readFile(join(root, 'openspec/changes', entry.name, 'slices.yaml')).catch(() => null)) planned.push(entry.name);
  }
  let isShallow;
  // Changes are read in parallel: each may wait on gh for its pull requests.
  const results = await Promise.all(planned.map(async change => {
    const required = reason => ({ change, note: `${change}: every scenario is required, since slice progress can't be read: ${reason}` });
    try {
      const loaded = await loadPlan(root, change);
      if (loaded.parties) return required("a store's change is tested in its parties");
      if (await (isShallow ??= shallow(root))) return required('the clone is shallow');
      const evidence = await landing(loaded, root, root);
      const { base } = evidence.sources[0];
      if (base.fallback || !base.refs.length) return required(`no default branch was found (no origin/HEAD, main or master), so ${base.ref} is no base`);
      const status = deriveStatus(loaded, evidence);
      const onHead = await headSlices(root, change, base);
      const started = new Set(status.slices.filter(slice => slice.state === 'landed' || onHead.has(slice.id)).map(slice => slice.id));
      const landedIds = status.slices.filter(slice => slice.state === 'landed' && !onHead.has(slice.id)).map(slice => slice.id);
      const behindIds = await behindSlices(root, change, evidence.sources[0], landedIds);
      const pending = new Map();
      const due = new Set();
      const behind = new Map();
      const current = new Set();
      for (const requirement of loaded.requirements) {
        const covering = status.slices.filter(slice => slice.implements.includes(requirement.id)).map(slice => slice.id);
        const waits = covering.length > 0 && !covering.some(id => started.has(id));
        for (const { name } of requirement.scenarios ?? []) {
          const key = `${requirement.spec} / ${name}`;
          if (waits) pending.set(key, [...new Set([...(pending.get(key) ?? []), ...covering])]);
          else due.add(key);
          const startedBy = covering.filter(id => started.has(id));
          if (startedBy.length && startedBy.every(id => behindIds.has(id))) behind.set(key, [...new Set([...(behind.get(key) ?? []), ...startedBy])]);
          else if (startedBy.length) current.add(key);
        }
      }
      for (const key of due) pending.delete(key);
      for (const key of current) behind.delete(key);
      return { change, pending, behind, base: base.ref };
    } catch (error) { return required(error.message); }
  }));
  return { waiting: new Map(results.filter(item => item.pending).map(item => [item.change, item.pending])),
    behind: new Map(results.filter(item => item.behind).map(item => [item.change, { base: item.base, scenarios: item.behind }])),
    notes: results.filter(item => item.note).map(item => item.note) };
}

export async function specLinks(root) {
  const found = await occurrences(root);
  const known = new Map([...found].map(([key, [source]]) => [key, source]));
  const { waiting: byChange, behind: behindByChange, notes } = await waiting(root);
  // A scenario waits only when every file it appears in is a waiting change's delta for it.
  const changeOf = source => source.match(/^openspec\/changes\/([^/]+)\/specs\//)?.[1];
  const pendingOf = key => {
    const sources = found.get(key);
    const waits = sources.map(source => byChange.get(changeOf(source))?.get(key));
    if (!waits.every(Boolean)) return null;
    return sources.map((source, i) => ({ change: changeOf(source), slices: waits[i] }));
  };
  // A required scenario is behind only when every file it appears in is a change's delta for it
  // that is required by slices landed outside this tree.
  const behindOf = key => {
    const sources = found.get(key);
    const behind = sources.map(source => {
      const entry = behindByChange.get(changeOf(source));
      const slices = entry?.scenarios.get(key);
      return slices ? { change: changeOf(source), slices, base: entry.base } : null;
    });
    return behind.every(Boolean) ? behind : null;
  };
  const links = await testLinks(root);
  const problems = [];
  for (const link of links) {
    const where = `${link.file}:${link.line}`;
    if (!known.has(link.key)) problems.push(`${where} links unknown scenario "${link.key}"`);
    problems.push(...linkProblems(link).map(problem => `${where} ${problem}`));
  }
  const coverage = [...known].map(([key, source]) => {
    const pending = pendingOf(key);
    const behind = pending ? null : behindOf(key);
    return { key, source, tests: links.filter(link => link.key === key).map(({ kind, file, line }) => ({ kind, file, line })),
      ...(pending ? { pending } : {}), ...(behind ? { behind } : {}) };
  });
  for (const item of coverage) {
    if (item.tests.length || item.pending) continue;
    const late = item.behind?.map(({ slices, base }) => `slice ${slices.join(', ')} has landed on ${base}, but this tree has no record of that landing; if the branch is behind ${base}, update it (rebase/merge ${base}) and re-run; otherwise link the test`);
    problems.push(`${item.source}: scenario "${item.key}" has no linked test${late ? ` — ${[...new Set(late)].join('; ')}` : ''}`);
  }
  return { coverage, problems, notes };
}

