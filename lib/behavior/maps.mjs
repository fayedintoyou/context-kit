// Behavior maps: `maps/<name>.md` in the workspace repository, an OKF concept with
// `type: BehaviorMap` holding one fenced `yaml map` block. The model drafts a map; this module
// finds, parses and checks it, and writes only its generated diagram block.
import { lstat, readdir, rename, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { fail, readText } from '../files.mjs';
import { splitFrontmatter } from '../okf.mjs';
import { storeIdSchema } from '../specs/openspec.mjs';
import { SOURCE_NAMES, openSource, capabilityOf } from './sources.mjs';
import { DIAGRAM_END, DIAGRAM_START_PREFIX, diagramBlock, mermaid, model } from './render.mjs';

export const MAP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const mapName = z.string().regex(MAP_NAME, 'a map name is kebab-case, the file stem of maps/<name>.md').max(100);
const NODE_LABEL_MAX = 70;
const WHEN_LABEL_MAX = 50;

const line = z.string().min(1).max(500).regex(/^[^\r\n]+$/, 'must be one line');
const cites = z.array(z.string().min(1).max(500)).max(50);
const schema = z.object({
  version: z.literal(1),
  source: z.object({ kind: z.enum(SOURCE_NAMES), store: storeIdSchema.optional() }).strict(),
  scope: z.array(z.string().min(1).max(500)).min(1).max(50),
  vocabulary: z.array(z.string().min(1).max(100)).max(200).optional(),
  nodes: z.array(z.object({ id: z.string().regex(MAP_NAME, 'node IDs are kebab-case').max(100),
    kind: z.enum(['start', 'state', 'choice', 'end']).default('state'), label: line, cites: cites.optional() }).strict()).min(1).max(200),
  transitions: z.array(z.object({ from: z.string().min(1).max(100), to: z.string().min(1).max(100), when: line.optional(), cites: cites.optional() }).strict()).max(500),
}).strict();

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const edge = transition => `${transition.from} -> ${transition.to}`;
const issue = (code, element, message) => ({ code, element, message });

// Fenced code blocks (CommonMark: up to three spaces, three or more backticks or tildes) and the
// generated-diagram markers outside them, by line, with character offsets.
function scan(text, offset) {
  const blocks = [];
  const markers = [];
  let fence = null;
  let position = offset;
  for (const raw of text.slice(offset).split('\n')) {
    const start = position;
    const end = start + raw.length; // excludes the newline, includes a CRLF's \r
    position = end + 1;
    const content = raw.replace(/\r$/, '');
    if (fence) {
      const close = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        blocks.push({ info: fence.info, start: fence.start, contentStart: fence.contentStart, contentEnd: start, end, closed: true });
        fence = null;
      }
      continue;
    }
    const open = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length, info: open[2].trim().split(/\s+/).join(' '), start, contentStart: Math.min(position, text.length) };
      continue;
    }
    // A marker's span stops before any \r, so a CRLF file's line ending stays outside it.
    if (content.startsWith(DIAGRAM_START_PREFIX)) markers.push({ kind: 'start', start, end: start + content.length });
    else if (content.trimEnd() === DIAGRAM_END) markers.push({ kind: 'end', start, end: start + content.length });
  }
  if (fence) blocks.push({ info: fence.info, start: fence.start, contentStart: fence.contentStart, contentEnd: text.length, end: text.length, closed: false });
  return { blocks, markers };
}

// zod issues as report entries naming the element: a node by its ID, a transition by its ends.
function schemaIssues(error, raw) {
  return error.issues.map(item => {
    const [section, index] = item.path;
    const entry = Array.isArray(raw?.[section]) && typeof index === 'number' ? raw[section][index] : undefined;
    let element = section === undefined ? 'map' : String(section);
    if (section === 'nodes' && typeof index === 'number') element = typeof entry?.id === 'string' ? entry.id : `nodes[${index}]`;
    if (section === 'transitions' && typeof index === 'number') {
      element = typeof entry?.from === 'string' && typeof entry?.to === 'string' ? edge(entry) : `transitions[${index}]`;
    }
    const where = item.path.join('.');
    const message = item.code === 'unrecognized_keys' ? `Unknown key${item.keys.length > 1 ? 's' : ''}: ${item.keys.join(', ')}${where ? ` (in ${where})` : ''}`
      : `${where ? `${where}: ` : ''}${item.message}`;
    return issue('schema', element, message);
  });
}

// Reads and parses one map file. Never follows a symlink: a symlinked map is reported, not read.
async function loadMap(root, name) {
  const file = `maps/${name}.md`;
  const path = join(root, 'maps', `${name}.md`);
  if (!(await mapsDirectory(root))) fail('UNKNOWN_MAP', `No map named ${name} (${file})`);
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') fail('UNKNOWN_MAP', `No map named ${name} (${file})`); throw error; }
  const map = { name, file, path, title: null, problems: [] };
  if (info.isSymbolicLink()) { map.problems.push(issue('schema', 'map', `${file} is a symlink; map files are read only as regular files`)); return map; }
  if (!info.isFile()) fail('UNKNOWN_MAP', `No map named ${name} (${file} is not a file)`);
  try { map.text = await readText(path); }
  catch (error) {
    if (!['TOO_LARGE', 'INVALID_UTF8'].includes(error.code)) throw error;
    map.problems.push(issue('schema', 'map', `${file}: ${error.code === 'TOO_LARGE' ? 'too large' : 'not UTF-8'}`));
    return map;
  }
  map.eol = map.text.includes('\r\n') ? '\r\n' : '\n';
  const front = splitFrontmatter(map.text);
  if (!front || front.error) { map.problems.push(issue('schema', 'map', front?.error ? `Frontmatter: ${front.error}` : 'A map needs OKF frontmatter with type: BehaviorMap')); return map; }
  if (front.data.type !== 'BehaviorMap') map.problems.push(issue('schema', 'map', 'Frontmatter type must be BehaviorMap'));
  map.title = typeof front.data.title === 'string' ? front.data.title : null;
  const { blocks, markers } = scan(map.text, map.text.length - front.body.length);
  const mapBlocks = blocks.filter(block => block.info === 'yaml map');
  if (mapBlocks.length !== 1) { map.problems.push(issue('schema', 'map', `A map holds exactly one \`\`\`yaml map block; found ${mapBlocks.length}`)); return map; }
  const [block] = mapBlocks;
  if (!block.closed) { map.problems.push(issue('schema', 'map', 'The yaml map block is not closed')); return map; }
  map.block = block;
  if (markers.length) {
    const [first, second] = markers;
    if (markers.length !== 2 || first.kind !== 'start' || second.kind !== 'end') {
      map.problems.push(issue('schema', 'diagram', 'The generated diagram needs one start marker followed by one end marker'));
    } else if (first.start < block.end && second.end > block.start) {
      map.problems.push(issue('schema', 'diagram', 'The generated diagram markers must not enclose the yaml map block'));
    } else map.diagram = { start: first.start, end: second.end };
  }
  let raw;
  try { raw = parseYaml(map.text.slice(block.contentStart, block.contentEnd)); }
  catch (error) { map.problems.push(issue('schema', 'map', `Invalid YAML: ${error.message.split('\n')[0]}`)); return map; }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) { map.problems.push(...schemaIssues(parsed.error, raw)); return map; }
  map.data = parsed.data;
  return map;
}

// The repository's maps/ directory, or null when there is none. A symlinked one is never read.
async function mapsDirectory(root) {
  const directory = join(root, 'maps');
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink()) fail('PATH_ESCAPE', 'maps/ is a symlink; maps are read only from a real directory');
  return info.isDirectory() ? directory : null;
}

// The repository's map names, sorted.
async function mapNames(root) {
  const directory = await mapsDirectory(root);
  if (!directory) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md') && MAP_NAME.test(entry.name.slice(0, -3)))
    .map(entry => entry.name.slice(0, -3)).sort(compare);
}

export async function listMaps(root) {
  const maps = [];
  for (const name of await mapNames(root)) {
    const map = await loadMap(root, name);
    maps.push({ map: name, file: map.file, title: map.title, source: map.data?.source ?? null, scope: map.data?.scope ?? null,
      problem: map.problems[0]?.message ?? null });
  }
  return { root, maps };
}

function structure(data) {
  const errors = [];
  const nodes = new Map();
  for (const node of data.nodes) {
    if (nodes.has(node.id)) errors.push(issue('structure', node.id, `Duplicate node ID: ${node.id}`));
    else nodes.set(node.id, node);
  }
  const exits = new Map([...nodes.keys()].map(id => [id, []]));
  for (const transition of data.transitions) {
    const unknown = [transition.from, transition.to].filter(id => !nodes.has(id));
    for (const id of new Set(unknown)) errors.push(issue('structure', edge(transition), `Transition names an unknown node: ${id}`));
    if (!unknown.length) exits.get(transition.from).push(transition);
  }
  const starts = data.nodes.filter(node => node.kind === 'start');
  if (starts.length !== 1) errors.push(issue('structure', 'nodes', `A map has exactly one start; found ${starts.length}${starts.length ? `: ${starts.map(node => node.id).join(', ')}` : ''}`));
  else {
    const reached = new Set([starts[0].id]);
    const queue = [starts[0].id];
    while (queue.length) for (const transition of exits.get(queue.shift())) if (!reached.has(transition.to)) { reached.add(transition.to); queue.push(transition.to); }
    for (const id of nodes.keys()) if (!reached.has(id)) errors.push(issue('structure', id, `${id} is not reachable from the start`));
  }
  for (const node of nodes.values()) {
    const out = exits.get(node.id);
    if (node.kind === 'choice') {
      if (out.length < 2) errors.push(issue('structure', node.id, `A choice needs at least two exits; ${node.id} has ${out.length}`));
      for (const transition of out) if (transition.when === undefined) errors.push(issue('structure', edge(transition), `An exit from the choice ${node.id} needs a when label`));
    }
    if (node.kind === 'end' && out.length) errors.push(issue('structure', node.id, `An end has no exits; ${node.id} has ${out.length}`));
  }
  return errors;
}

// Mechanical plain-language lint (design decision 10). Whole tokens are split on whitespace
// for code shapes; words are split further on punctuation. Vocabulary terms match exactly.
const SPEC_WORDS = new Set(['SHALL', 'MUST', 'WHEN', 'THEN']);
function codeReason(token) {
  if (token.includes('`')) return 'a backtick';
  if (token.includes('::') || token.includes('()') || token.includes('=>') || token.includes('==')) return 'code punctuation';
  if (token.startsWith('/') || (token.includes('/') && token.includes('.'))) return 'a file path';
  return null;
}
function wordReason(word) {
  if (word.includes('_')) return 'an underscore';
  if (/\p{Ll}\p{Lu}/u.test(word)) return 'an inner capital';
  if (/^[A-Z]+(?:-[A-Z0-9]+)*-\d+$/.test(word)) return 'a spec ID';
  if (SPEC_WORDS.has(word)) return 'a spec keyword';
  return null;
}
function lint(label, max, element, vocabulary) {
  const errors = [];
  const length = [...label].length;
  if (length > max) errors.push(issue('label', element, `Label is ${length} characters; keep it to ${max}`));
  const flagged = new Set();
  const flag = (token, reason) => {
    if (flagged.has(token)) return;
    flagged.add(token);
    errors.push(issue('label', element, `"${token}" reads as code or spec language (${reason}); say it in the person's words or add it to vocabulary`));
  };
  for (const raw of label.split(/\s+/).filter(Boolean)) {
    const token = raw.replace(/^["']+/, '').replace(/["',.;:!?]+$/, '');
    if (!token || vocabulary.has(token)) continue;
    const reason = codeReason(token);
    if (reason) { flag(token, reason); continue; }
    for (const word of token.split(/[,.;:!?()"]+/).filter(Boolean)) {
      if (vocabulary.has(word)) continue;
      const why = wordReason(word);
      if (why) flag(word, why);
    }
  }
  return errors;
}
function labels(data) {
  const vocabulary = new Set(data.vocabulary ?? []);
  return [
    ...data.nodes.flatMap(node => lint(node.label, NODE_LABEL_MAX, node.id, vocabulary)),
    ...data.transitions.flatMap(transition => (transition.when === undefined ? [] : lint(transition.when, WHEN_LABEL_MAX, edge(transition), vocabulary))),
  ];
}

// Reads each source once per run, and each capability only when a map cites or scopes it.
function behaviorReader(specSource) {
  const sources = new Map();
  return async (selection, capabilities) => {
    const key = JSON.stringify(selection);
    if (!sources.has(key)) {
      const source = await openSource(selection, specSource);
      sources.set(key, { source, known: new Set(await source.capabilities()), read: new Map() });
    }
    const entry = sources.get(key);
    for (const capability of [...new Set(capabilities)].sort(compare)) {
      if (entry.known.has(capability) && !entry.read.has(capability)) entry.read.set(capability, await entry.source.read(capability));
    }
    return entry;
  };
}

function describeMatch(behavior) {
  return behavior.kind === 'requirement' ? `the requirement ${behavior.id}` : `a scenario of ${behavior.parent}`;
}

async function checkOne(root, name, read) {
  const map = await loadMap(root, name);
  const report = { map: name, valid: false, errors: [...map.problems], warnings: [] };
  if (!map.data) return { report, map };
  const { data } = map;
  report.errors.push(...structure(data));

  const elements = [...data.nodes.map(node => ({ element: node.id, node, cites: node.cites ?? [] })),
    ...data.transitions.map(transition => ({ element: edge(transition), cites: transition.cites ?? [] }))];
  const capabilities = [...data.scope, ...elements.flatMap(item => item.cites)].map(capabilityOf);
  const source = await read(data.source, capabilities);
  const byId = new Map();
  for (const behaviors of source.read.values()) for (const behavior of behaviors) byId.set(behavior.id, [...(byId.get(behavior.id) ?? []), behavior]);

  const resolved = new Map();
  const cited = new Set();
  for (const { element, node, cites: list } of elements) {
    if (node?.kind === 'state' && !list.length) report.errors.push(issue('uncited_state', element, `The state ${element} cites no behavior; cite what it shows`));
    for (const id of list) {
      const matches = byId.get(id) ?? [];
      if (!matches.length) report.errors.push(issue('unknown_citation', element, `${element} cites ${id}, which names no requirement or scenario`));
      else if (matches.length > 1) report.errors.push(issue('ambiguous_citation', element, `${element} cites ${id}, which names ${matches.length} behaviors: ${matches.map(describeMatch).join(', ')}`));
      else { resolved.set(id, matches[0]); cited.add(matches[0]); }
    }
  }

  // Coverage: the scenarios in scope that no element cites; a cited requirement covers its own.
  const inScope = [];
  for (const entry of data.scope) {
    const capability = capabilityOf(entry);
    const behaviors = source.read.get(capability);
    if (!behaviors) { report.errors.push(issue('unknown_citation', 'scope', `Scope names ${capability}, which is no capability of the source`)); continue; }
    if (entry === capability) { inScope.push(...behaviors.filter(behavior => behavior.kind === 'scenario')); continue; }
    if (!behaviors.some(behavior => behavior.kind === 'requirement' && behavior.id === entry)) {
      report.errors.push(issue('unknown_citation', 'scope', `Scope names ${entry}, which is no requirement of ${capability}`));
      continue;
    }
    inScope.push(...behaviors.filter(behavior => behavior.kind === 'scenario' && behavior.parent === entry));
  }
  const coveredRequirements = new Set([...cited].filter(behavior => behavior.kind === 'requirement').map(behavior => behavior.id));
  for (const scenario of new Set(inScope)) {
    if (!cited.has(scenario) && !coveredRequirements.has(scenario.parent)) {
      report.warnings.push(issue('uncovered', scenario.id, `No element cites ${scenario.id} (a scenario of ${scenario.parent}) or its requirement`));
    }
  }

  report.errors.push(...labels(data));
  report.valid = report.errors.length === 0;
  if (report.valid && map.diagram && map.text.slice(map.diagram.start, map.diagram.end) !== diagramBlock(data, map.eol)) {
    report.warnings.push(issue('diagram_outdated', 'diagram', `The generated diagram in ${map.file} differs from a fresh rendering; run maps render ${name} --write`));
  }
  return { report, map, resolved };
}

export async function checkMaps(root, name, specSource) {
  const read = behaviorReader(specSource);
  const names = name === undefined ? await mapNames(root) : [name];
  const maps = [];
  for (const each of names) maps.push((await checkOne(root, each, read)).report);
  return { root, valid: maps.every(map => map.valid), maps };
}

// Rendering and writing refuse a map the check reports errors for, before any output or write.
async function checked(root, name, specSource) {
  const result = await checkOne(root, name, behaviorReader(specSource));
  if (!result.report.valid) {
    const count = result.report.errors.length;
    fail('INVALID_INPUT', `Map ${name} has ${count} error${count === 1 ? '' : 's'}; run maps check ${name} and fix ${count === 1 ? 'it' : 'them'} first`);
  }
  return result;
}

export async function renderMap(root, name, format, specSource) {
  const { map, resolved } = await checked(root, name, specSource);
  if (format === 'json') return { map: name, format, ...model(name, map.title, map.data, resolved) };
  return { map: name, format, diagram: mermaid(map.data) };
}

// Replaces the generated block between the markers, or adds it after the map block, and
// changes nothing else. The file is replaced atomically, and only if it is unchanged since read.
export async function writeDiagram(root, name, specSource) {
  const { map } = await checked(root, name, specSource);
  const block = diagramBlock(map.data, map.eol);
  let text;
  if (map.diagram) text = map.text.slice(0, map.diagram.start) + block + map.text.slice(map.diagram.end);
  else {
    const at = map.block.end === map.text.length ? map.text.length : map.block.end + 1;
    const before = map.text.slice(0, at);
    const after = map.text.slice(at);
    const lead = at === map.block.end ? map.eol : '';
    text = before + lead + map.eol + block + map.eol + (after === '' || after.startsWith(map.eol) ? '' : map.eol) + after;
  }
  if (text === map.text) return { map: name, file: map.file, written: false };
  const temporary = join(root, 'maps', `.${name}.md.${randomBytes(6).toString('hex')}.tmp`);
  const { mode } = await stat(map.path);
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    await chmod(temporary, mode & 0o777);
    const current = await lstat(map.path);
    if (!current.isFile() || await readText(map.path) !== map.text) fail('SNAPSHOT_CHANGED', `${map.file} changed while its diagram was rendered; run maps render ${name} --write again`);
    await rename(temporary, map.path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { map: name, file: map.file, written: true };
}
