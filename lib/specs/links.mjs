import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

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

export async function scenarios(root) {
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
          if (!found.has(key)) found.set(key, relative(root, file));
        }
      }
    }
  }
  return found;
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

export async function specLinks(root) {
  const known = await scenarios(root);
  const links = await testLinks(root);
  const problems = [];
  for (const link of links) {
    const where = `${link.file}:${link.line}`;
    if (!known.has(link.key)) problems.push(`${where} links unknown scenario "${link.key}"`);
    if (!link.attached) problems.push(`${where} link is not directly above a test(...) call`);
    if (!['e2e', 'unit', 'manual'].includes(link.kind)) problems.push(`${where} tests must live in test/e2e or test/unit`);
    if (link.kind === 'unit' && !link.justified) problems.push(`${where} unit link needs a "// because:" line saying why e2e cannot show it`);
  }
  const coverage = [...known].map(([key, source]) => ({ key, source,
    tests: links.filter(link => link.key === key).map(({ kind, file, line }) => ({ kind, file, line })) }));
  for (const item of coverage) {
    if (!item.tests.length) problems.push(`${item.source}: scenario "${item.key}" has no linked test`);
  }
  return { coverage, problems };
}

