// Open Knowledge Format v0.2 (GoogleCloudPlatform/knowledge-catalog, okf/SPEC.md).
// Hubs are validated strictly against §11 conformance; everything consumers must
// tolerate (unknown types and keys, broken links, missing indexes) is accepted.
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { fail, readText } from './files.mjs';

export const OKF_VERSION = '0.2';
const MAX_CONCEPTS = 2000;
const actorPattern = /^(?:(?:human|process|team):[A-Za-z0-9._@-]{1,100}|[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._+-]{1,100})$/;
export const isActor = value => typeof value === 'string' && actorPattern.test(value);

// Returns null when there is no frontmatter, or { data, body } / { error }.
export function splitFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) return null;
  const match = text.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/);
  if (!match) return { error: 'unterminated frontmatter' };
  let data;
  try { data = parse(match[1] ?? '') ?? {}; }
  catch (error) { return { error: 'invalid YAML: ' + error.message.split('\n')[0] }; }
  if (typeof data !== 'object' || Array.isArray(data)) return { error: 'frontmatter must be a mapping' };
  return { data, body: text.slice(match[0].length) };
}

// §5.3 trust tiers, §5.4 status, §5.5 staleness. A bare verified mapping is one entry.
// Malformed trust fields are treated as absent and reported as warnings, never rejected.
export function summarize(data, now = Date.now()) {
  const warnings = [];
  const listed = data.verified == null ? [] : Array.isArray(data.verified) ? data.verified : [data.verified];
  const verified = listed.filter(entry => entry && typeof entry === 'object' && isActor(entry.by));
  if (verified.length !== listed.length) warnings.push('ignored verified entries without a valid actor');
  let stale = false;
  if (data.stale_after != null) {
    const value = String(data.stale_after);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) warnings.push('stale_after needs an ISO 8601 datetime with a UTC offset');
    else stale = now >= Date.parse(value);
  }
  const text = value => typeof value === 'string' ? value : undefined;
  return { summary: { type: text(data.type), title: text(data.title), description: text(data.description),
    status: text(data.status) ?? 'stable',
    trust: !verified.length ? 'unverified' : verified.some(entry => entry.by.startsWith('human:')) ? 'human-reviewed' : 'machine-confirmed',
    stale }, warnings };
}

// ISO 8601 durations of years, months, weeks, days, hours and minutes, e.g. P1D, P6M, PT12H.
const durationPattern = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;
export function isDuration(value) {
  return typeof value === 'string' && value !== 'P' && value !== 'PT' && !value.endsWith('T') && durationPattern.test(value);
}
function addDuration(time, duration) {
  const [, y, mo, w, d, h, mi] = duration.match(durationPattern).map(part => Number(part ?? 0));
  const date = new Date(time);
  date.setUTCFullYear(date.getUTCFullYear() + y, date.getUTCMonth() + mo, date.getUTCDate() + w * 7 + d);
  date.setUTCHours(date.getUTCHours() + h, date.getUTCMinutes() + mi);
  return date.getTime();
}
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Freshness decision: refresh once stale_after passes; verify when older than the policy's
// age for this type (or the hub default) since last verified, or generated if never
// verified; otherwise read as written.
export function freshness(data, policy, now = Date.now()) {
  const staleAt = instant(data.stale_after);
  if (staleAt !== null && now >= staleAt) return { action: 'refresh', reason: 'stale_after has passed', due: iso(staleAt) };
  const maxAge = policy?.types?.[data.type] ?? policy?.default;
  if (!maxAge) {
    return staleAt === null ? { action: 'read', reason: 'no freshness rule applies' }
      : { action: 'read', reason: 'before stale_after', due: iso(staleAt) };
  }
  const listed = data.verified == null ? [] : Array.isArray(data.verified) ? data.verified : [data.verified];
  const verifiedAt = listed.map(entry => entry && typeof entry === 'object' ? instant(entry.at) : null).filter(time => time !== null);
  const basis = verifiedAt.length ? { time: Math.max(...verifiedAt), what: 'verified' }
    : instant(data.generated?.at) !== null ? { time: instant(data.generated.at), what: 'generated' } : null;
  if (!basis) return { action: 'verify', reason: `no verification or generation time under a ${maxAge} rule` };
  const due = Math.min(addDuration(basis.time, maxAge), staleAt ?? Infinity);
  return now >= due ? { action: 'verify', reason: `last ${basis.what} more than ${maxAge} ago`, due: iso(due) }
    : { action: 'read', reason: `${basis.what} within ${maxAge}`, due: iso(due) };
}

// §11 conformance for one bundle. Problems are returned, not thrown, so reads can stay
// lenient while validation is strict. Concepts are keyed by bundle-relative path.
export async function checkBundle(bundleRoot) {
  const all = (await readdir(bundleRoot, { recursive: true, withFileTypes: true }))
    .map(entry => ({ entry, path: relative(bundleRoot, join(entry.parentPath, entry.name)).split(sep).join('/') }))
    .filter(({ path }) => !path.split('/').slice(0, -1).some(part => part.startsWith('.')));
  if (all.length > MAX_CONCEPTS * 5) fail('TOO_LARGE', `Bundle exceeds ${MAX_CONCEPTS * 5} entries: ${bundleRoot}`);
  // The hub's own file and directory sets, so links can be classified without probing paths.
  const files = new Set(all.filter(({ entry, path }) => entry.isFile() && !posixBase(path).startsWith('.')).map(({ path }) => path));
  const directories = new Set(all.filter(({ entry, path }) => entry.isDirectory() && !posixBase(path).startsWith('.')).map(({ path }) => path));
  const entries = all.filter(({ entry }) => entry.name.endsWith('.md'));
  if (entries.length > MAX_CONCEPTS) fail('TOO_LARGE', `Bundle exceeds ${MAX_CONCEPTS} Markdown files: ${bundleRoot}`);
  const concepts = new Map();
  const problems = [];
  let okfVersion = null;
  for (const { entry, path } of entries) {
    const problem = message => problems.push({ path, message });
    if (entry.isSymbolicLink()) { problem('symlinked Markdown files are not allowed'); continue; }
    if (!entry.isFile()) continue;
    const text = await readText(join(entry.parentPath, entry.name));
    const front = splitFrontmatter(text);
    if (front?.error) { problem(front.error); continue; }
    if (entry.name === 'index.md') {
      // §8 / §12: index files carry no frontmatter, except okf_version at the bundle root.
      if (front && (path !== 'index.md' || Object.keys(front.data).some(key => key !== 'okf_version'))) {
        problem('index files may only declare okf_version, and only at the bundle root');
      } else if (front?.data.okf_version != null) okfVersion = String(front.data.okf_version);
      continue;
    }
    if (entry.name === 'log.md') {
      // §9: every ## heading is an ISO 8601 date.
      const heading = text.split('\n').find(line => /^## /.test(line) && !/^## \d{4}-\d{2}-\d{2}\s*$/.test(line));
      if (heading) problem(`log date headings must be YYYY-MM-DD: ${heading.trim()}`);
      continue;
    }
    if (!front) { problem('missing YAML frontmatter with a type (see docs/format.md, Migrating)'); continue; }
    if (typeof front.data.type !== 'string' || !front.data.type.trim()) { problem('frontmatter needs a non-empty type'); continue; }
    concepts.set(path, front.data);
  }
  return { concepts, problems, okfVersion, files, directories };
}

const posixBase = path => path.slice(path.lastIndexOf('/') + 1);
export function concept(frontmatter, body) {
  return `---\n${stringify(frontmatter)}---\n\n${body}`;
}
export function timestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
