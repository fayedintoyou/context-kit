import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { localFile, readText } from '../files.mjs';

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
// Each operation keeps its requirement body so packets can quote the target text.
export function parseDelta(content) {
  const operations = [];
  let op, from, current;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) { op = line.match(/^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/)?.[1]; from = undefined; current = undefined; continue; }
    const requirement = line.match(/^### Requirement:\s*(.+?)\s*$/)?.[1];
    if (op && op !== 'RENAMED' && requirement) {
      current = { op, requirement, lines: [] };
      operations.push(current);
      continue;
    }
    if (line.startsWith('### ')) current = undefined;
    if (current) current.lines.push(line);
    if (op === 'RENAMED') {
      const pair = line.match(/^- (FROM|TO):\s*`?### Requirement:\s*(.+?)`?\s*$/);
      if (pair?.[1] === 'FROM') from = pair[2];
      if (pair?.[1] === 'TO' && from) { operations.push({ op, from, requirement: pair[2] }); from = undefined; }
    }
  }
  return operations.map(({ lines, ...operation }) => lines ? { ...operation, ...body(lines) } : operation);
}
function body(lines) {
  const scenarios = [];
  const text = [];
  for (const line of lines) {
    const scenario = line.match(/^####\s+Scenario:\s*(.+?)\s*$/)?.[1];
    if (scenario) scenarios.push({ name: scenario, lines: [] });
    else if (scenarios.length) scenarios.at(-1).lines.push(line);
    else text.push(line);
  }
  return { text: text.join('\n').trim(), scenarios: scenarios.map(({ name, lines }) => ({ name, rawText: lines.join('\n').trim() })) };
}
export async function deltas(root) {
  const changes = join(root, 'openspec/changes');
  const result = [];
  async function change(directory, name, date = null) {
    const specRoot = join(directory, 'specs');
    async function walk(path) {
      for (const entry of (await entries(path)).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name === 'spec.md') {
          result.push({ change: name, date, spec: relative(specRoot, path).split(sep).join('/'),
            operations: parseDelta(await readText(await localFile(root, relative(root, file)))) });
        }
      }
    }
    await walk(specRoot);
  }
  for (const entry of (await entries(changes)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== 'archive') await change(join(changes, entry.name), entry.name);
    else for (const archive of (await entries(join(changes, 'archive'))).sort((a, b) => a.name.localeCompare(b.name))) {
      const match = archive.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      if (archive.isDirectory() && match) await change(join(changes, 'archive', archive.name), match[2], match[1]);
    }
  }
  return result;
}
