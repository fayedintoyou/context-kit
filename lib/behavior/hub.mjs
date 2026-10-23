// Hubs for behavior maps: the `hub` behavior source (a hub's concepts as behaviors) and hub maps
// (`BehaviorMap` concepts named `<hub-id>:/<concept-id>`). Only the workspace's own hubs, from
// its hubs/ and examples/, are read; mounted hubs are not (a later change may add them).
// Freshness depends on the clock, so it is evaluated at one instant the caller can give.
import { dirname, relative, sep } from 'node:path';
import { fail, readText } from '../files.mjs';
import { conceptRef, hubFile, idPattern, loadHubs } from '../hubs.mjs';
import { freshness, splitFrontmatter, summarize } from '../okf.mjs';
import { fingerprint } from './sources.mjs';

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MOUNTS_NOT_READ = 'maps read only the workspace\'s own hubs (hubs/ and examples/), not mounted hubs';

// An ISO 8601 timestamp with an explicit offset (`Z` or `+hh:mm`), as milliseconds; the current
// time when omitted. Anything else is INVALID_INPUT, so an instant is never read as local time.
// Every field is checked against the calendar (no February 30, no hour 24), since Date.parse
// would roll an impossible date over into the next month.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
export function evaluationInstant(at) {
  if (at === undefined) return Date.now();
  const invalid = why => fail('INVALID_INPUT', `at must be an ISO 8601 timestamp with an offset, such as 2026-03-01T09:00:00Z or 2026-03-01T10:00:00+01:00${why}: ${String(at).slice(0, 64)}`);
  const match = typeof at === 'string' ? at.match(INSTANT) : null;
  if (!match) invalid('');
  const [year, month, day, hour, minute, second = 0, fraction = '0', sign, offsetHours = 0, offsetMinutes = 0] =
    match.slice(1).map((part, index) => (part === undefined ? undefined : index === 6 || index === 7 ? part : Number(part)));
  // Date.UTC reads years 0-99 as 1900-1999, so the year is set on its own.
  const utc = (y, m, ...rest) => { const date = new Date(Date.UTC(2000, m, ...rest)); date.setUTCFullYear(y); return date.getTime(); };
  const daysInMonth = month >= 1 && month <= 12 ? new Date(utc(year, month, 0)).getUTCDate() : 0;
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) {
    invalid(' and a real date and time');
  }
  const local = utc(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0')));
  const time = local - (sign === '-' ? -1 : 1) * (sign ? (offsetHours * 60 + offsetMinutes) * 60000 : 0);
  if (year < 1 || !Number.isFinite(time)) invalid(' and a real date and time');
  return time;
}
// The instant as reported: UTC, with milliseconds only when it has them.
export const reportedInstant = time => new Date(time).toISOString().replace(/\.000Z$/, 'Z');

const hubBase = (root, hub) => relative(root, hub.root).split(sep).join('/');
const isMapConcept = (path, data) => data.type === 'BehaviorMap' && !path.startsWith('inbox/');

// A hub map name: <hub-id>:/<concept-id>, the concept ID a relative path without `.md`.
export function isHubMapName(value) {
  const at = typeof value === 'string' ? value.indexOf(':/') : -1;
  if (at <= 0 || !idPattern.test(value.slice(0, at))) return false;
  const concept = value.slice(at + 2);
  return concept.length > 0 && concept.length <= 500 && !/[\0\\]/.test(concept) && concept.split('/').every(part => part && part !== '.' && part !== '..');
}

// The workspace's hub maps, loaded once per command: names in hub order, then path order, each
// with its workspace-relative file and directory.
export function hubMaps(root) {
  let loaded;
  const load = () => (loaded ??= loadHubs(root, { allowEmpty: true }).then(hubs => hubs.flatMap(hub => {
    const base = hubBase(root, hub);
    return [...hub.concepts].filter(([path, data]) => isMapConcept(path, data)).map(([path]) => path).sort(byPath)
      .map(path => ({ name: conceptRef(hub, path), file: `${base}/${path}`, dir: dirname(`${base}/${path}`) }));
  })));
  return {
    names: async () => (await load()).map(map => map.name),
    find: async name => (await load()).find(map => map.name === name) ?? null,
  };
}
export const unknownHubMap = name => fail('UNKNOWN_MAP', `No map named ${name}: no BehaviorMap concept by that ID in the workspace's hubs; ${MOUNTS_NOT_READ}`);

// Why a cited concept's context has aged at the instant, or null: due for a check (verify), out of
// date (refresh) or deprecated.
function aged(behavior) {
  const reasons = [];
  if (behavior.okf.status === 'deprecated') reasons.push('is deprecated');
  const { action, reason, due } = behavior.freshness;
  if (action === 'refresh') reasons.push(`is out of date (${reason}${due ? `, at ${due}` : ''})`);
  if (action === 'verify') reasons.push(`is due for a check (${reason}${due ? `, since ${due}` : ''})`);
  return reasons.length ? reasons.join(' and ') : null;
}

// A concept's description, or the first line of its body that is not a heading, kept short.
function describe(okf, body) {
  const line = okf.description ?? body.split('\n').map(item => item.trim()).find(item => item && !item.startsWith('#')) ?? '';
  return [...line].length > 200 ? [...line].slice(0, 199).join('') + '…' : line;
}

// The hub source: a workspace hub's concepts as `<hub-id>:/<concept-id>`, kind `concept`, with
// the concept file's full text, its OKF trust summary and its freshness at the instant. Maps are
// never behaviors; inbox notes are listed (with `inbox: true`) only when asked for. Listings
// are summaries (progressive disclosure): text only with full, the rest with read_concept.
export async function hubSource(spec, selection) {
  const { root } = spec;
  const hubs = await loadHubs(root, { allowEmpty: true });
  const hub = hubs.find(item => item.manifest.id === selection.hub);
  if (!hub) fail('UNKNOWN_HUB', `Unknown hub: ${selection.hub}; ${MOUNTS_NOT_READ}`);
  const id = hub.manifest.id;
  const at = selection.at ?? Date.now();
  const base = hubBase(root, hub);
  const maps = new Set();
  let behaviors;
  async function load() {
    if (behaviors) return behaviors;
    const listed = [];
    for (const path of [...hub.concepts.keys()].sort(byPath)) {
      const inbox = path.startsWith('inbox/');
      if (hub.concepts.get(path).type === 'BehaviorMap') { if (!inbox) maps.add(conceptRef(hub, path)); continue; }
      if (inbox && !selection.inbox) continue;
      // What is fingerprinted is what is summarized: the file as read now.
      const text = await readText(await hubFile(hub, path));
      const front = splitFrontmatter(text);
      if (!front || front.error || front.data.type === 'BehaviorMap') fail('SNAPSHOT_CHANGED', `${base}/${path} changed while hub ${id} was read; run the command again`);
      const okf = summarize(front.data, at).summary;
      listed.push({ id: conceptRef(hub, path), kind: 'concept', title: okf.title ?? path.slice(0, -3), description: describe(okf, front.body), text, file: `${base}/${path}`,
        fingerprint: fingerprint(text), okf, freshness: freshness(front.data, hub.manifest.freshness, at), ...(inbox ? { inbox: true } : {}) });
    }
    behaviors = listed;
    return behaviors;
  }
  return {
    name: 'hub',
    describe: () => ({ kind: 'hub', hub: id }),
    root,
    at,
    capabilities: async () => [''],
    read: () => load(),
    groupOf: () => '',
    noun: `concept of hub ${id}`,
    unknown: cited => (maps.has(cited) ? ' (it is a map, and maps are not behaviors)' : ''),
    aged,
    // A scope entry is a directory of the hub (its concepts, at any depth), or "" for the whole hub.
    scoped(entry, groups) {
      const all = (groups.get('') ?? []).filter(behavior => !behavior.inbox);
      if (entry === '') return { behaviors: all };
      if (entry === 'inbox' || entry.startsWith('inbox/') || !hub.directories.has(entry)) return { error: `Scope names ${entry}, which is no directory of hub ${id} ("" is the whole hub)` };
      return { behaviors: all.filter(behavior => behavior.id.startsWith(`${id}:/${entry}/`)) };
    },
  };
}
