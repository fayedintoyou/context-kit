// Behavior maps: `maps/<name>.md` in the workspace repository, an OKF concept with
// `type: BehaviorMap` holding one fenced `yaml map` block. The model drafts a map; this module
// finds, parses and checks it, and writes only its generated diagram block and its pins.
import { lstat, readdir, realpath, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, parseDocument, Document, isMap, isScalar, isSeq } from 'yaml';
import { z } from 'zod';
import { fail, readText } from '../files.mjs';
import { splitFrontmatter } from '../okf.mjs';
import { storeIdSchema } from '../specs/openspec.mjs';
import { SOURCE_NAMES, openSource } from './sources.mjs';
import { DIAGRAM_END, DIAGRAM_START_PREFIX, diagramBlock, mermaid, model, pinState } from './render.mjs';

export const MAP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const mapName = z.string().regex(MAP_NAME, 'a map name is kebab-case, the file stem of maps/<name>.md').max(100);
const NODE_LABEL_MAX = 70;
const WHEN_LABEL_MAX = 50;

const FINGERPRINT = /^[0-9a-f]{12}$/;
const line = z.string().min(1).max(500).regex(/^[^\r\n]+$/, 'must be one line');
const cites = z.array(z.string().min(1).max(500)).max(50);
const schema = z.object({
  version: z.literal(1),
  source: z.object({ kind: z.enum(SOURCE_NAMES), store: storeIdSchema.optional() }).strict()
    .refine(source => source.kind === 'openspec' || source.store === undefined, { message: 'store applies only to the openspec source', path: ['store'] }),
  scope: z.array(z.string().min(1).max(500)).min(1).max(50),
  vocabulary: z.array(z.string().min(1).max(100)).max(200).optional(),
  nodes: z.array(z.object({ id: z.string().regex(MAP_NAME, 'node IDs are kebab-case').max(100),
    kind: z.enum(['start', 'state', 'choice', 'end']).default('state'), label: line, cites: cites.optional() }).strict()).min(1).max(200),
  transitions: z.array(z.object({ from: z.string().min(1).max(100), to: z.string().min(1).max(100), when: line.optional(), cites: cites.optional() }).strict()).max(500),
  // Written by maps pin: each citation's fingerprint when a person last reviewed the map.
  pins: z.record(z.string().min(1).max(500), z.string().regex(FINGERPRINT, 'a pin is a 12-hex fingerprint, written by maps pin')).optional(),
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
  const directory = await confinedDirectory(root);
  if (!directory) fail('UNKNOWN_MAP', `No map named ${name} (${file})`);
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') fail('UNKNOWN_MAP', `No map named ${name} (${file})`); throw error; }
  const map = { name, file, path, directory, title: null, problems: [] };
  if (info.isSymbolicLink()) { map.problems.push(issue('schema', 'map', `${file} is a symlink; map files are read only as regular files`)); return map; }
  if (!info.isFile()) fail('UNKNOWN_MAP', `No map named ${name} (${file} is not a file)`);
  try { map.text = await readText(path); }
  catch (error) {
    if (!['TOO_LARGE', 'INVALID_UTF8'].includes(error.code)) throw error;
    map.problems.push(issue('schema', 'map', `${file}: ${error.code === 'TOO_LARGE' ? 'too large' : 'not UTF-8'}`));
    return map;
  }
  // What was read is the file that was checked, in the directory that was checked.
  await sameDirectory(root, directory);
  const after = await lstat(path);
  if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino) fail('SNAPSHOT_CHANGED', `${file} was replaced while it was read; run the command again`);
  return parseMap(map);
}

// Parses map.text into its title, map block, diagram span and data, recording problems on map.
// maps check and the pin guard read a map's text only through this.
function parseMap(map) {
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

// The repository's maps/ directory as { path, dev, ino }, or null when there is none. It must be
// a real directory whose real path is root/maps: a symlink at the root or at maps/ is refused.
async function confinedDirectory(root) {
  const path = join(root, 'maps');
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink()) fail('PATH_ESCAPE', 'maps/ is a symlink; maps are read and written only in a real directory');
  if (!info.isDirectory()) return null;
  if (await realpath(path) !== join(await realpath(root), 'maps')) fail('PATH_ESCAPE', 'maps/ resolves outside the repository');
  return { path, dev: info.dev, ino: info.ino };
}
// Refuses when maps/ is no longer the directory first checked (swapped, or replaced by a symlink).
async function sameDirectory(root, directory) {
  const current = await confinedDirectory(root).catch(error => { if (error.code === 'PATH_ESCAPE') return null; throw error; });
  if (!current || current.dev !== directory.dev || current.ino !== directory.ino) {
    fail('PATH_ESCAPE', 'maps/ was replaced while the command ran; nothing was written');
  }
}

// The repository's map names, sorted.
async function mapNames(root) {
  const directory = await confinedDirectory(root);
  if (!directory) return [];
  return (await readdir(directory.path, { withFileTypes: true }))
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
  if (/[<>{}]|%%|:::|->|\[\[|\]\]/.test(token)) return 'diagram or web markup';
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

// Reads each source once per run, and each of its groups (an OpenSpec capability) only when a
// map cites or scopes it; ids are the map's scope entries and citations.
function behaviorReader(specSource) {
  const sources = new Map();
  return async (selection, ids) => {
    const key = JSON.stringify(selection);
    if (!sources.has(key)) {
      const source = await openSource(selection, specSource);
      sources.set(key, { source, known: new Set(await source.capabilities()), read: new Map() });
    }
    const entry = sources.get(key);
    for (const capability of [...new Set(ids.map(entry.source.groupOf))].sort(compare)) {
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
  const source = await read(data.source, [...data.scope, ...elements.flatMap(item => item.cites)]);
  const byId = new Map();
  for (const behaviors of source.read.values()) for (const behavior of behaviors) byId.set(behavior.id, [...(byId.get(behavior.id) ?? []), behavior]);

  const resolved = new Map();
  const cited = new Set();
  for (const { element, node, cites: list } of elements) {
    if (node?.kind === 'state' && !list.length) report.errors.push(issue('uncited_state', element, `The state ${element} cites no behavior; cite what it shows`));
    for (const id of list) {
      const matches = byId.get(id) ?? [];
      if (!matches.length) report.errors.push(issue('unknown_citation', element, `${element} cites ${id}, which names no ${source.source.noun}`));
      else if (matches.length > 1) report.errors.push(issue('ambiguous_citation', element, `${element} cites ${id}, which names ${matches.length} behaviors: ${matches.map(describeMatch).join(', ')}`));
      else { resolved.set(id, matches[0]); cited.add(matches[0]); }
    }
  }

  // Coverage: the behaviors in scope (OpenSpec scenarios, linked-intent entries) that no element
  // cites; a cited requirement covers its own scenarios.
  const inScope = [];
  for (const entry of data.scope) {
    const scoped = source.source.scoped(entry, source.read);
    if (scoped.error) report.errors.push(issue('unknown_citation', 'scope', scoped.error));
    else inScope.push(...scoped.behaviors);
  }
  const coveredRequirements = new Set([...cited].filter(behavior => behavior.kind === 'requirement').map(behavior => behavior.id));
  for (const behavior of new Set(inScope)) {
    if (cited.has(behavior) || (behavior.parent !== undefined && coveredRequirements.has(behavior.parent))) continue;
    report.warnings.push(issue('uncovered', behavior.id, behavior.parent === undefined ? `No element cites ${behavior.id}`
      : `No element cites ${behavior.id} (a scenario of ${behavior.parent}) or its requirement`));
  }

  // Pins: each resolved citation, per element citing it, against the fingerprint it was pinned at.
  const pins = data.pins ?? {};
  for (const { element, cites: list } of elements) {
    for (const id of new Set(list)) {
      const behavior = resolved.get(id);
      if (!behavior) continue;
      const state = pinState(pins, id, behavior.fingerprint);
      if (state === 'unpinned') report.warnings.push(issue('unpinned', element, `${element} cites ${id}, which has no pin; once a person has reviewed the map, run maps pin ${name}`));
      if (state === 'stale') {
        report.warnings.push(issue('stale', element, `${element} cites ${id}, whose text changed since the map was pinned (pinned ${pins[id]}, now ${behavior.fingerprint}); check that ${element} still shows it, then run maps pin ${name}`));
      }
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
  return replaceMapFile(root, map, text, `maps render ${name} --write`);
}

// Records each citation's current fingerprint under `pins` and changes nothing else. The `pins`
// pair is located through yaml's Document API and edited in place, line by line: a changed pin has
// only its value replaced, a pin nothing cites loses its line (and the `pins` line goes when none
// remain), and new pins follow the last one in citation order, indented like the file. A flow value
// (`pins: { ... }`) has changed values replaced in place, and is rewritten as one flow mapping only
// when pins are added or removed. Pins already current change nothing. Before writing, the whole
// new file is read back as maps check reads it (pinRewriteProblem), and any difference outside the
// pins refuses the write.
export async function pinMap(root, name, specSource) {
  const { map, resolved } = await checked(root, name, specSource);
  const pins = new Map([...resolved].map(([id, behavior]) => [id, behavior.fingerprint]));
  const content = map.text.slice(map.block.contentStart, map.block.contentEnd);
  const document = parseDocument(content);
  if (!isMap(document.contents) || document.contents.flow) {
    fail('INVALID_INPUT', `maps pin can't add pins to ${map.file}: its yaml map block is one { ... } mapping; write the block in block style, one key per line`);
  }
  const unchanged = { map: name, file: map.file, written: false };
  const old = map.data.pins ?? {};
  const { items } = document.contents;
  const pair = items.find(item => isScalar(item.key) && item.key.value === 'pins');
  if (!pair && !pins.size) return unchanged;
  if (Object.keys(old).length === pins.size && [...pins].every(([id, value]) => old[id] === value)) return unchanged;
  const { eol } = map;
  const lineStart = offset => content.lastIndexOf('\n', offset - 1) + 1;
  const nextLine = offset => { const at = content.indexOf('\n', offset); return at === -1 ? content.length : at + 1; };
  const indentAt = offset => {
    const indent = content.slice(lineStart(offset), offset);
    if (!/^ *$/.test(indent)) fail('INVALID_INPUT', `maps pin needs the keys of the yaml map block of ${map.file} on lines of their own`);
    return indent;
  };
  const scalar = value => new Document(value).toString({ lineWidth: 0 }).trimEnd();
  const entryLine = (id, value) => new Document({ [id]: value }).toString({ lineWidth: 0 }).trimEnd();
  const flowMap = entries => { const flow = new Document(Object.fromEntries(entries)); flow.contents.flow = true; return flow.toString({ lineWidth: 0 }).trimEnd(); };
  const edits = [];
  let order;
  let region;
  if (!pair) {
    // After the last top-level entry, so before a document end marker or trailing comments.
    const last = items.at(-1);
    let end = last.value?.range?.[1] ?? last.key.range[1];
    while (end > 0 && (content[end - 1] === '\n' || content[end - 1] === '\r')) end -= 1;
    const at = nextLine(end);
    const indent = indentAt(items[0].key.range[0]);
    const step = indentStep(content, items, indent.length);
    order = [...pins.keys()];
    edits.push({ start: at, end: at, text: [`${indent}pins:`, ...order.map(id => indent + step + entryLine(id, pins.get(id)))].join(eol) + eol });
    region = [at, at];
  } else if (isMap(pair.value) && !pair.value.flow && pair.value.items.length) {
    const entries = pair.value.items;
    const indent = indentAt(entries[0].key.range[0]);
    order = [];
    for (const entry of entries) {
      const id = entry.key.value;
      if (!pins.has(id)) { edits.push({ start: lineStart(entry.key.range[0]), end: nextLine(entry.value.range[1]), text: '' }); continue; }
      order.push(id);
      if (old[id] !== pins.get(id)) edits.push({ start: entry.value.range[0], end: entry.value.range[1], text: scalar(pins.get(id)) });
    }
    const added = [...pins.keys()].filter(id => !order.includes(id));
    const after = nextLine(entries.at(-1).value.range[1]);
    if (added.length) {
      edits.push({ start: after, end: after, text: added.map(id => indent + entryLine(id, pins.get(id)) + eol).join('') });
      order.push(...added);
    }
    // No pins remain: the `pins` line goes too; comment lines between the entries stay.
    if (!order.length) edits.push({ start: lineStart(pair.key.range[0]), end: nextLine(pair.key.range[1]), text: '' });
    region = [lineStart(pair.key.range[0]), after];
  } else if (isMap(pair.value)) {
    const entries = pair.value.items;
    const ids = entries.map(entry => entry.key?.value);
    region = [pair.value.range[0], pair.value.range[1]];
    if (ids.length === pins.size && ids.every(id => pins.has(id))) {
      order = ids;
      for (const entry of entries) if (old[entry.key.value] !== pins.get(entry.key.value)) edits.push({ start: entry.value.range[0], end: entry.value.range[1], text: scalar(pins.get(entry.key.value)) });
    } else {
      order = [...pins.keys()];
      edits.push({ start: region[0], end: region[1], text: flowMap(pins) });
    }
  } else fail('INVALID_INPUT', `maps pin can't rewrite the pins of ${map.file}: its pins value is not a mapping; remove the pins key and pin again`);
  let updated = content;
  for (const edit of edits.sort((a, b) => b.start - a.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  const text = map.text.slice(0, map.block.contentStart) + updated + map.text.slice(map.block.contentEnd);
  const problem = pinRewriteProblem(name, map.text, text, region, order.map(id => [id, pins.get(id)]));
  if (problem) fail('PIN_UNSAFE', `maps pin refused to rewrite ${map.file}: ${problem}. Nothing was written; remove its pins key and pin again`);
  return replaceMapFile(root, map, text, `maps pin ${name}`);
}

// The indentation one level down, as the block already uses it, or two spaces.
function indentStep(content, items, top) {
  for (const item of items) {
    const value = item.value;
    if (!(isMap(value) || isSeq(value)) || value.flow || !value.items.length) continue;
    const first = value.items[0];
    const at = isMap(value) ? first.key.range[0] : first.range[0];
    const column = content.slice(content.lastIndexOf('\n', at - 1) + 1).match(/^ */)[0].length;
    if (column > top) return ' '.repeat(column - top);
  }
  return '  ';
}

// Why a pin rewrite is unsafe, or null. beforeText is the checked map file, text the whole new
// file, region the span of the map block's content (offsets into the old content) that pinning may
// change, expected the pins as entries in order. Both files are read exactly as maps check reads them.
export function pinRewriteProblem(name, beforeText, text, region, expected) {
  const before = parseMap({ name, file: `maps/${name}.md`, text: beforeText, title: null, problems: [] });
  if (before.problems.length || !before.data) return 'the map did not parse before pinning';
  const prefix = before.block.contentStart + region[0];
  const suffix = before.text.length - (before.block.contentStart + region[1]);
  if (text.length < prefix + suffix || text.slice(0, prefix) !== before.text.slice(0, prefix)
    || text.slice(text.length - suffix) !== before.text.slice(before.text.length - suffix)) return 'the rewrite changed text outside the pins';
  const after = parseMap({ name: before.name, file: before.file, text, title: null, problems: [] });
  if (after.problems.length || !after.data) return `the rewritten map would not parse (${after.problems[0]?.message ?? 'no map'})`;
  const { pins: oldPins, ...rest } = before.data;
  const { pins: newPins, ...restAfter } = after.data;
  if (!isDeepStrictEqual(restAfter, rest) || after.title !== before.title) return 'the rewrite changed the map, not only its pins';
  if (JSON.stringify(Object.entries(newPins ?? {})) !== JSON.stringify(expected)) return 'the rewritten pins are not the current fingerprints';
  return null;
}

// Replaces a checked map's file with text, atomically, only if the file and maps/ are still the
// ones that were read. again is the command to run when the file changed in the meantime.
async function replaceMapFile(root, map, text, again) {
  const { name } = map;
  if (text === map.text) return { map: name, file: map.file, written: false };
  // Node has no renameat, so the directory is re-verified around every step: before the temporary
  // file is created, once it exists (it must sit in that same directory), and just before the
  // rename. A swap of maps/ (or of the file) at any of those points refuses without writing.
  await sameDirectory(root, map.directory);
  const temporary = join(map.directory.path, `.${name}.md.${randomBytes(6).toString('hex')}.tmp`);
  const { mode } = await lstat(map.path);
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    await chmod(temporary, mode & 0o777);
    await sameDirectory(root, map.directory);
    const placed = await lstat(temporary);
    if (!placed.isFile() || dirname(await realpath(temporary)) !== join(await realpath(root), 'maps')) fail('PATH_ESCAPE', 'The temporary file left maps/; nothing was written');
    const current = await lstat(map.path);
    if (!current.isFile() || await readText(map.path) !== map.text) fail('SNAPSHOT_CHANGED', `${map.file} changed while it was being rewritten; run ${again} again`);
    await sameDirectory(root, map.directory);
    await rename(temporary, map.path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { map: name, file: map.file, written: true };
}
