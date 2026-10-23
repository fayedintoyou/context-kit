// Repositories: every `type: Repository` concept is registered by its upstream (`resource`)
// and `aliases`. Where each one is checked out is recorded per machine in the workspace's
// untracked .state/checkouts.json, and a generated `my-repos` skill tells agents.
import { appendFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { loadHubs, KIT_ROOT } from './hubs.mjs';
import { concept as conceptText, timestamp, isActor } from './okf.mjs';
import { fail } from './files.mjs';
import { git as runGit } from './git-env.mjs';

export const ROUTING_SKILL = 'my-repos';
// Git runs through lib/git-env.mjs: -C names the checkout, and hook-exported GIT_DIR and the
// like are dropped, so a command run from a linked workspace's pull hook reads the checkout asked about.
const git = async (directory, args) => (await runGit(directory, args)).stdout.trim();
// Output that is one path, with only git's line ending removed: a path may hold newlines or edge spaces.
const gitPath = async (directory, args) => (await runGit(directory, args)).stdout.replace(/\n$/, '');
// A last-resort guard on free text: output names remotes by remoteIdentity and never
// echoes git's diagnostics, but anything else that might hold a URL passes through this.
// Linear in the text's length: the userinfo pass is a hand-written scan, and the two
// regular expressions start only at a fixed prefix and never backtrack over a long run.
export function redact(text) {
  return redactUserinfo(String(text))
    .replace(/([?&](?:access_token|private_token|token)=)[^&\s]+/gi, '$1***')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g, '***');
}
// <scheme>://<userinfo>@ becomes <scheme>://***@, where the scheme is a letter then letters,
// digits, + . or -, and userinfo has no whitespace, / or @. Each scan back from a :// stops at
// the previous one's /, and each scan forward stops at the next /, so every character is read
// a bounded number of times.
const SCHEME_CHAR = /[a-z0-9+.-]/i;
const STOP = /[\s/@]/;
function redactUserinfo(text) {
  let out = '';
  let from = 0;
  for (let at = text.indexOf('://'); at >= 0; at = text.indexOf('://', at + 1)) {
    if (at < from) continue;
    let letter = false;
    for (let start = at; start > from && SCHEME_CHAR.test(text[start - 1]); start--) if (/[a-z]/i.test(text[start - 1])) letter = true;
    let end = at + 3;
    while (end < text.length && !STOP.test(text[end])) end++;
    if (letter && end > at + 3 && text[end] === '@') {
      out += `${text.slice(from, at + 3)}***@`;
      from = end + 1;
    }
  }
  return out + text.slice(from);
}

// host/owner/name for remote URLs (SSH, scp-like or HTTP, any case, with or without .git);
// file:<path> for local upstreams. null when the value is not a git upstream. The result
// never holds userinfo, a port, a query or a fragment, so it is what output shows of a remote.
const HOST = String.raw`(?:[\p{L}\p{N}](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}])?|\[[0-9a-f:.]+\])`;
// After userinfo: a host (hostname or [IPv6]) with an optional port, then the path.
const AUTHORITY_PATH = new RegExp(String.raw`^(${HOST})(?::\d*)?(/[\s\S]*)$`, 'iu');
const FILE_PATH = new RegExp(String.raw`^(${HOST})?(/[\s\S]*)$`, 'iu');
const SCP_PATH = new RegExp(String.raw`^(${HOST}):([\s\S]*)$`, 'iu');
// Everything up to the last @ is userinfo, whatever it holds, and is dropped before any other
// parsing. Well-formed userinfo has no raw / ? or #; with one, the string is ambiguous (a
// password holding it, or an @ in the path or query) and isn't an upstream at all.
function afterUserinfo(rest) {
  const at = rest.lastIndexOf('@');
  if (at < 0) return rest;
  return /[/?#]/.test(rest.slice(0, at)) ? null : rest.slice(at + 1);
}
// host/owner/name for remote URLs (SSH, scp-like or HTTP, any case, with or without .git);
// file:<path> for local upstreams. null when the value is not a git upstream. The result
// never holds userinfo, a port, a query or a fragment, so it is what output shows of a remote.
export function normalizeUpstream(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const tidy = path => path.replace(/[?#][\s\S]*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (raw.startsWith('/')) return `file:${raw.replace(/\/+$/, '').replace(/\.git$/i, '')}`;
  const scheme = raw.match(/^(https?|ssh|git|git\+ssh|file):\/\//i);
  if (scheme?.[1].toLowerCase() === 'file') {
    const rest = afterUserinfo(raw.slice(scheme[0].length));
    const parts = rest?.match(FILE_PATH);
    return parts ? `file:${decodeURIComponent(`${parts[1] ?? ''}${parts[2].replace(/\/+$/, '').replace(/\.git$/i, '')}`)}` : null;
  }
  const rest = afterUserinfo(scheme ? raw.slice(scheme[0].length) : raw);
  // scp-like (git@host:owner/name, or host:owner/name as a clean form leaves it); without a
  // user@ the host must hold a dot or be [IPv6], so a drive letter or note:path is not one.
  const scp = () => { const parts = rest?.match(SCP_PATH); return parts && (raw.includes('@') || /[.[]/.test(parts[1])) ? parts : null; };
  const parts = scheme ? rest?.match(AUTHORITY_PATH) : scp();
  if (!parts) return null;
  const path = tidy(parts[2]).replace(/^\/+/, '');
  return path.includes('/') ? `${parts[1]}/${path}`.toLowerCase() : null;
}
// How output names a remote: its normalized identity, never the URL as given.
export function remoteIdentity(value) {
  try { return normalizeUpstream(value) ?? 'an unrecognized remote'; } catch { return 'an unrecognized remote'; }
}
const repoName = key => key.slice(key.lastIndexOf('/') + 1);
// A repository's clean upstream: the URL as given without userinfo, query or fragment,
// keeping its scheme, host, port and path, so it still clones. SSH (ssh://, git+ssh:// and
// scp-like) keeps a well-known login (wellKnownLogin), which is not a secret; any other login,
// a login with a password, and any userinfo over HTTP, git:// or file://, is dropped whole.
// An scp-like upstream stays scp-like, so its path keeps meaning the same (relative to the
// login's home). `stripped` is true when anything was removed. null when the value is not a
// git upstream. The clean form has the same identity (normalizeUpstream) as the value.
// A login kept on an SSH upstream: git, or a short lowercase account name with at most three
// digits. Anything longer, mixed-case or digit-heavy may be a token used as the user.
const wellKnownLogin = name => name === 'git' || (/^[a-z][a-z0-9_-]{0,14}$/.test(name) && (name.match(/[0-9]/g) ?? []).length <= 3);
export function cleanUpstream(value) {
  let key;
  try { key = normalizeUpstream(value); } catch { return null; }
  if (!key) return null;
  const raw = value.trim();
  if (raw.startsWith('/')) return { url: raw, stripped: false };
  const scheme = raw.match(/^(https?|ssh|git|git\+ssh|file):\/\//i);
  const prefix = scheme?.[0] ?? '';
  const body = raw.slice(prefix.length);
  // normalizeUpstream accepted it, so userinfo (up to the last @) holds no raw / ? or #.
  const at = body.lastIndexOf('@');
  const userinfo = at < 0 ? null : body.slice(0, at);
  let rest = at < 0 ? body : body.slice(at + 1);
  const file = scheme?.[1].toLowerCase() === 'file';
  // A file: path may hold a literal ? or #; it carries no token, so only its userinfo goes.
  const cut = file ? -1 : rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  const ssh = !scheme || /^(?:ssh|git\+ssh)$/i.test(scheme[1]);
  // A login with a password is a credential pair; it goes whole.
  const name = ssh && userinfo !== null && !userinfo.includes(':') ? userinfo : null;
  const login = name && wellKnownLogin(name) ? name : null;
  const stripped = cut >= 0 || (userinfo !== null && userinfo !== login);
  // scp-like keeps its host:path whether or not a login stays.
  const url = `${prefix}${login ? `${login}@` : ''}${rest}`;
  let same;
  try { same = normalizeUpstream(url) === key; } catch { same = false; }
  return same ? { url, stripped } : null;
}

// Name bounds, in code points: every repository's minimal routing entry then fits a
// description on its own.
export const TITLE_MAX = 80;
export const NAME_MAX = 60;
const points = text => [...text].length;
const unnamed = id => `${id}: has no title of at most ${TITLE_MAX} characters or alias of at most ${NAME_MAX}, and its id is too long to name it in the routing skill; give it a shorter title or an alias`;

// Registered repositories, sorted by id, plus problems with their fields and warnings. Hubs are
// workspace hubs and loaded mounted hubs (with `mount`). A workspace hub's problems are
// `problems`, which validate fails on; anything involving a mount is a `warning`, since the
// workspace can't fix someone else's hub. Listings skip repositories without a valid upstream
// or aliases. A mounted repository's id is its concept ref, `<mount>:/<concept-id>`.
//
// Precedence: workspace hubs by hub then concept ID, then mounts by name then concept ID (code
// point order, whatever the locale). Concepts sharing an upstream with a mount among them are
// one repository, the first by precedence, the rest its `alternateIds`; only its own `context`
// counts.
//
// Every kind of name goes through one precedence (`lost` names no longer name a repository;
// `disputed` ones still do, ambiguously, but never trigger). Names compare as they always have
// (case-insensitively) between workspace repositories, and by `nameKey` (compatibility
// normalization and full case folding) whenever a mounted repository is one of the two:
// - an id or alternate id is its repository's alone: any other repository's title, alias,
//   upstream name or keyword equal to it is lost, with a warning;
// - a name a workspace hub's repository claims in any way (title, alias, upstream name or
//   keyword) is lost by every mounted repository claiming it, with a warning;
// - a title, alias or upstream name only mounts claim, for several repositories, names none
//   of them (disputed, with a warning when a title or alias is among the claims), and a mounted
//   keyword equal to it is dropped;
// - among workspace hubs alone, a title or alias claimed twice, or a keyword equal to another
//   repository's title or alias, fails validate as before.
// `triggers` holds a repository's effective trigger names, the only names renderers may use:
// titles and aliases it owns undisputed within their bounds, and keywords it keeps, each
// keyword only for the first repository that lists it.
const UNSAFE_ID = /[\s`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Text from a mount, on one visible line: format characters (bidi overrides, zero widths) go,
// and any run of breaks, controls or spaces is one space.
const oneLine = text => text.replace(/\p{Cf}+/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
// Bounds on what one mount brings; more is dropped with a warning.
export const MOUNT_NAMES_MAX = 20;
export const MOUNT_REPOSITORIES_MAX = 200;
export const MOUNT_RESOURCE_MAX = 300;
// How two workspace repositories' names compare (as before mounts), and how a mounted
// repository's name compares with any other: compatibility-normalized and fully case-folded
// (upper then lower, so ß is ss), so NFD and NFC, and fullwidth and ASCII spellings, are one.
export const caseKey = name => name.toLowerCase();
export const nameKey = name => name.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
// Code point order, the same in every locale.
export function byCodePoint(a, b) {
  const [x, y] = [[...a], [...b]];
  for (let at = 0; at < Math.min(x.length, y.length); at++) if (x[at] !== y[at]) return x[at].codePointAt(0) - y[at].codePointAt(0);
  return x.length - y.length;
}
// How many ids a warning or dispute line names, and how many warnings the registry reports.
const IDS_SHOWN = 5;
export const WARNINGS_MAX = 100;
const listIds = list => list.length > IDS_SHOWN ? `${list.slice(0, IDS_SHOWN).map(item => item.id ?? item).join(', ')} and ${list.length - IDS_SHOWN} more` : list.map(item => item.id ?? item).join(' and ');
const byPrecedence = (a, b) => Boolean(a.mount) - Boolean(b.mount) || byCodePoint(a.mount ?? a.manifest.id, b.mount ?? b.manifest.id);
// Whether a repository has given up a name (in either comparison), or it is disputed.
const gaveUp = (repository, name) => repository.lost.has(nameKey(name)) || repository.lostCase.has(caseKey(name));
export function registry(hubs) {
  const entries = [];
  const problems = [];
  // [text, rank]: rank 0 for a warning that names a workspace repository, 1 for the rest.
  const notes = [];
  const warn = (text, rank = 1) => notes.push([text, rank]);
  const ordered = hubs.map(hub => ({ hub, manifest: hub.manifest, mount: hub.mount?.name ?? null })).sort(byPrecedence);
  for (const { hub, mount } of ordered) {
    const report = mount ? text => warn(text) : text => problems.push(text);
    let count = 0;
    const concepts = [...hub.concepts].sort(([a], [b]) => mount ? byCodePoint(a, b) : a.localeCompare(b));
    for (const [path, data] of concepts) {
      if (data.type !== 'Repository' || path.startsWith('inbox/')) continue;
      if (mount && ++count > MOUNT_REPOSITORIES_MAX) { if (count === MOUNT_REPOSITORIES_MAX + 1) warn(`mount ${mount}: Repository concepts past the first ${MOUNT_REPOSITORIES_MAX} by concept ID are not registered`); continue; }
      const concept = path.slice(0, -3);
      const id = mount ? `${mount}:/${concept}` : `${hub.manifest.id}/${concept}`;
      if (mount && (UNSAFE_ID.test(concept) || (typeof data.resource === 'string' && UNSAFE_ID.test(data.resource.trim())))) {
        warn(`${JSON.stringify(id).slice(0, 200)}: not registered: its concept ID or resource holds whitespace, a backtick, or a control or format character`);
        continue;
      }
      if (mount && typeof data.resource === 'string' && points(data.resource.trim()) > MOUNT_RESOURCE_MAX) { warn(`${id}: not registered: its resource is over ${MOUNT_RESOURCE_MAX} characters`); continue; }
      const key = normalizeUpstream(data.resource);
      // A local path names a directory on the hub author's machine, not an upstream to share.
      if (mount && key?.startsWith('file:')) { warn(`${id}: not registered: its resource is a local path, not a shared upstream`); continue; }
      const named = text => mount ? oneLine(text) : text.trim();
      let aliases = data.aliases ?? [];
      // Absent means none; an explicit null or any other non-list is reported.
      let keywords = 'keywords' in data ? data.keywords : [];
      const clean = key ? cleanUpstream(data.resource) : null;
      if (!key) report(`${id}: resource must be the repository's git upstream, e.g. https://github.com/<owner>/<name>`);
      // The clean form holds nothing secret, so it is safe to suggest.
      else if (!clean || clean.stripped) report(`${id}: resource must not carry credentials, a query or a fragment; ${clean ? `use ${clean.url}` : 'give only the upstream, e.g. https://github.com/<owner>/<name>'}`);
      if (!Array.isArray(keywords) || keywords.some(keyword => typeof keyword !== 'string' || !named(keyword))) {
        report(`${id}: keywords must be a list of strings`);
        keywords = [];
      }
      if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !named(alias))) { report(`${id}: aliases must be a list of names`); continue; }
      if (!key || (mount && (!clean || clean.stripped))) continue;
      let title = typeof data.title === 'string' ? named(data.title) : '';
      aliases = aliases.map(named);
      keywords = keywords.map(named);
      // A mount can't bloat the routing skill: names past their bounds and their count go.
      if (mount) {
        if (points(title) > TITLE_MAX) { warn(`${id}: title is over ${TITLE_MAX} characters; it is not used`); title = ''; }
        const capped = (list, kind) => {
          const fitting = list.filter(name => points(name) <= NAME_MAX);
          if (fitting.length < list.length) warn(`${id}: ${list.length - fitting.length} ${kind} over ${NAME_MAX} characters dropped`);
          if (fitting.length > MOUNT_NAMES_MAX) warn(`${id}: ${fitting.length - MOUNT_NAMES_MAX} ${kind} past the first ${MOUNT_NAMES_MAX} dropped`);
          return fitting.slice(0, MOUNT_NAMES_MAX);
        };
        aliases = capped(aliases, 'aliases');
        keywords = capped(keywords, 'keywords');
      }
      entries.push({ id, hub: hub.manifest.id, concept, title, upstream: clean?.url ?? remoteIdentity(data.resource), key, name: repoName(key), aliases, keywords,
        ...(mount ? { mount } : {}), alternateIds: [], hasContext: 'context' in data, notes: [] });
    }
  }
  // One repository per upstream once a mount is involved; workspace-only duplicates stay apart.
  const repositories = [];
  const canonical = new Map();
  for (const entry of entries) {
    const first = canonical.get(entry.key);
    if (first && (entry.mount || first.mount)) {
      first.alternateIds.push(entry.id);
      if (entry.hasContext) {
        const note = `context of ${entry.id} is ignored; ${first.id} is the canonical concept for its upstream`;
        first.notes.push(note);
        warn(note, first.mount ? 1 : 0);
      }
      continue;
    }
    if (!first) canonical.set(entry.key, entry);
    repositories.push(entry);
  }
  for (const repository of repositories) Object.assign(repository, { lost: new Set(), lostCase: new Set(), disputed: new Set(), dropped: new Set(), hidden: new Set() });
  // Every name each repository claims, by kind, in precedence order, under a key.
  const claimsBy = (members, key) => {
    const claims = new Map();
    const claim = (name, repository, kind) => {
      const lower = key(name);
      if (!claims.has(lower)) claims.set(lower, new Map());
      const by = claims.get(lower);
      if (!by.has(repository)) by.set(repository, new Set());
      by.get(repository).add(kind);
    };
    for (const repository of members) {
      for (const id of [repository.id, ...(repository.alternateIds ?? [])]) claim(id, repository, 'id');
      for (const name of [repository.title, ...repository.aliases].filter(Boolean)) claim(name, repository, 'name');
      claim(repository.name, repository, 'upstream');
      for (const keyword of repository.keywords) claim(keyword, repository, 'keyword');
    }
    return claims;
  };
  const ids = listIds;
  const written = (repository, lower, key) => repository.keywords.find(keyword => key(keyword) === lower) ?? lower;
  // A repository gives up a name: as a title, alias or upstream name it no longer names it; as a
  // keyword it no longer triggers (and, a mount involved, leaves the skill altogether).
  const lose = (repository, lower, kinds, mounted, field) => {
    if (kinds.has('name') || kinds.has('upstream')) repository[field].add(lower);
    if (kinds.has('keyword')) { repository.dropped.add(lower); if (mounted) repository.hidden.add(lower); }
  };
  const anyOwn = list => list.some(item => !item.mount) ? 0 : 1;
  // Workspace repositories among themselves, compared as before mounts.
  for (const [lower, by] of claimsBy(repositories.filter(item => !item.mount), caseKey)) {
    if (by.size < 2) continue;
    const all = [...by.keys()];
    const owners = all.filter(item => by.get(item).has('id'));
    if (owners.length) {
      const others = all.filter(item => !owners.includes(item));
      for (const item of others) lose(item, lower, by.get(item), false, 'lostCase');
      if (others.length) warn(`"${lower}" is the id of ${ids(owners)}, so it no longer names ${ids(others)}`, 0);
      continue;
    }
    const naming = all.filter(item => by.get(item).has('name'));
    if (naming.length > 1) problems.push(`"${lower}" is claimed by ${ids(naming)}; give each repository its own aliases`);
    for (const item of all.filter(other => by.get(other).has('keyword'))) {
      const others = naming.filter(other => other !== item);
      if (!others.length) continue;
      item.dropped.add(lower);
      problems.push(`${item.id}: keyword "${written(item, lower, caseKey)}" names ${ids(others)}; keywords must not be another repository's title or alias`);
    }
  }
  // Every name a mounted repository is among the claimants of, by nameKey.
  const disputes = [];
  for (const [lower, by] of claimsBy(repositories, nameKey)) {
    const all = [...by.keys()];
    if (by.size < 2 || !all.some(item => item.mount)) continue;
    const owners = all.filter(item => by.get(item).has('id'));
    if (owners.length) {
      const others = all.filter(item => !owners.includes(item) && (item.mount || owners.some(owner => owner.mount)));
      for (const item of others) lose(item, lower, by.get(item), true, 'lost');
      if (others.length) warn(`"${lower}" is the id of ${ids(owners)}, so it no longer names ${ids(others)}`, anyOwn([...owners, ...others]));
      continue;
    }
    const own = all.filter(item => !item.mount);
    const mounted = all.filter(item => item.mount);
    if (own.length) {
      for (const item of mounted) lose(item, lower, by.get(item), true, 'lost');
      const keywordOnly = mounted.filter(item => by.get(item).size === 1 && by.get(item).has('keyword'));
      for (const item of keywordOnly) warn(`${item.id}: keyword "${written(item, lower, nameKey)}" is claimed by ${ids(own)}, so it is dropped from the routing skill`, 0);
      const naming = mounted.filter(item => !keywordOnly.includes(item));
      if (naming.length) warn(`"${lower}" is claimed by ${ids([...own, ...naming])}; it stays with ${ids(own)}, so ${ids(naming)} ${naming.length > 1 ? 'need their ids' : 'needs its id'}`, 0);
      continue;
    }
    const naming = mounted.filter(item => by.get(item).has('name') || by.get(item).has('upstream'));
    if (naming.length > 1) {
      for (const item of naming) item.disputed.add(lower);
      if (naming.some(item => by.get(item).has('name'))) {
        disputes.push({ name: lower, ids: naming.map(item => item.id).sort(byCodePoint) });
        warn(`"${lower}" is claimed by ${ids(naming)}, all from mounts, so it names none of them; use their ids`);
      }
    }
    if (naming.length) for (const item of mounted.filter(other => !naming.includes(other))) {
      lose(item, lower, new Set(['keyword']), true, 'lost');
      warn(`${item.id}: keyword "${written(item, lower, nameKey)}" names ${ids(naming)}, so it is dropped from the routing skill`);
    }
  }
  // Keywords listed once: by the first repository by precedence; two workspace repositories'
  // keywords compare as before mounts.
  const keywordOwners = new Map();
  for (const repository of repositories) {
    const { id, title, aliases, keywords, mount } = repository;
    if (!mount) {
      if (points(title) > TITLE_MAX) problems.push(`${id}: title is over ${TITLE_MAX} characters`);
      for (const alias of aliases) if (points(alias) > NAME_MAX) problems.push(`${id}: alias "${alias}" is over ${NAME_MAX} characters`);
    }
    const effective = [];
    for (const keyword of keywords) {
      if (points(keyword) > NAME_MAX) { problems.push(`${id}: keyword "${keyword}" is over ${NAME_MAX} characters`); continue; }
      if (repository.dropped.has(nameKey(keyword)) || repository.dropped.has(caseKey(keyword))) continue;
      const listed = keywordOwners.get(nameKey(keyword)) ?? [];
      const owner = listed.find(other => other.repository !== repository && (other.repository.mount || mount || other.key === caseKey(keyword)))?.repository;
      if (owner) {
        warn(`${id}: keyword "${keyword}" is also ${owner.id}'s, so it triggers the routing skill only for ${owner.id}`, anyOwn([owner, repository]));
        continue;
      }
      keywordOwners.set(nameKey(keyword), [...listed, { repository, key: caseKey(keyword) }]);
      effective.push(keyword);
    }
    repository.keywords = keywords.filter(keyword => !repository.hidden.has(nameKey(keyword)));
    const owned = name => !gaveUp(repository, name) && !repository.disputed.has(nameKey(name));
    repository.triggers = {
      title: title && points(title) <= TITLE_MAX && owned(title) ? title : null,
      aliases: aliases.filter(alias => points(alias) <= NAME_MAX && owned(alias)),
      keywords: [...new Set(effective)],
    };
    // The id is the last fallback name; past the title bound it could overflow a description alone.
    // A mount's repository named only by such an id is left out of the routing skill instead.
    if (!repository.triggers.title && !repository.triggers.aliases.length && points(id) > TITLE_MAX) {
      if (mount) { repository.unroutable = true; warn(`${unnamed(id)}, in its own repository; until then it is not in the routing skill`); }
      else problems.push(unnamed(id));
    }
  }
  for (const repository of repositories) {
    // Lookup reads the names as claimed (`claimed`, with `lost`); everything shown (repos,
    // list_repos, open, the skill's body and metadata) gives only the names that resolve to this
    // repository: lost and disputed titles and aliases, and a mount's keywords that don't
    // trigger, are left out, so no listing pairs a name with a repository it doesn't open.
    const kept = name => !gaveUp(repository, name) && !repository.disputed.has(nameKey(name));
    repository.claimed = { title: repository.title, aliases: repository.aliases };
    repository.title = kept(repository.title) ? repository.title : '';
    repository.aliases = repository.aliases.filter(kept);
    if (repository.mount) repository.keywords = repository.triggers.keywords;
    for (const field of ['lost', 'lostCase', 'disputed']) repository[field] = [...repository[field]];
    delete repository.hasContext; delete repository.dropped; delete repository.hidden;
    if (!repository.alternateIds.length) delete repository.alternateIds;
  }
  // Someone else's hub can't flood output: each warning is bounded; warnings naming a workspace
  // repository come first, and past WARNINGS_MAX the rest are counted.
  const ranked = notes.map(([text, rank], at) => ({ text: points(text) > 500 ? `${[...text].slice(0, 499).join('')}…` : text, rank, at }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at).map(item => item.text);
  const warnings = ranked.length > WARNINGS_MAX ? [...ranked.slice(0, WARNINGS_MAX), `and ${ranked.length - WARNINGS_MAX} more warnings, the ones above first`] : ranked;
  return { repositories: repositories.sort((a, b) => a.id.localeCompare(b.id)), problems, warnings, disputes };
}

const checkoutsPath = root => join(root, '.state', 'checkouts.json');
async function loadCheckouts(root) {
  try {
    const data = JSON.parse(await readFile(checkoutsPath(root), 'utf8'));
    if (data?.version !== 1 || !data.checkouts || typeof data.checkouts !== 'object') throw new Error('expected {"version": 1, "checkouts": {...}}');
    return data.checkouts;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    fail('INVALID_CONFIG', `${checkoutsPath(root)}: ${error.message}`);
  }
}
async function saveCheckouts(root, checkouts) {
  await mkdir(join(root, '.state'), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(checkouts).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(checkoutsPath(root), JSON.stringify({ version: 1, checkouts: sorted }, null, 2) + '\n');
}
const isDirectory = path => stat(path).then(info => info.isDirectory(), () => false);

// Workspace hubs, then every fetched mount's hub (never one named like a workspace hub), with
// every declared mount's status. Reads only fetched content; nothing contacts a source.
export async function registryHubs(root) {
  let hubs;
  try { hubs = await loadHubs(root); } catch (error) { if (error.code === 'NO_HUBS') hubs = []; else throw error; }
  const { loadMounts, mountWarnings } = await import('./mounts.mjs');
  const mounts = await loadMounts(root);
  const warnings = mountWarnings(mounts);
  const ids = new Set(hubs.map(hub => hub.manifest.id));
  for (const mount of mounts.filter(item => item.hub && ids.has(item.name))) warnings.push(`mount ${mount.name} is named like a workspace hub and is not read; run mounts remove ${mount.name}, then mounts add it under another name`);
  const mounted = mounts.filter(item => item.hub && !ids.has(item.name)).map(item => item.hub);
  return { hubs, mounted, mounts: mounts.map(({ name, status }) => ({ name, status })), warnings };
}
// Repositories with their recorded checkout, or path null when none is recorded or it is gone.
// `mounts` names every declared mount and its status, for the routing skill's recovery guidance.
export async function listRepositories(root) {
  const { hubs, mounted, mounts, warnings: mountProblems } = await registryHubs(root);
  const { repositories, problems, warnings, disputes } = registry([...hubs, ...mounted]);
  // Mounts that are not fetched or broken are named, with their remedy.
  const checkouts = await loadCheckouts(root);
  const listed = [];
  for (const repository of repositories) {
    const recorded = checkouts[repository.key];
    const path = recorded && await isDirectory(recorded) ? recorded : null;
    // recorded: this machine's record as written, even when its directory is gone (stale).
    listed.push({ ...repository, path, status: path ? 'located' : 'missing', recorded: typeof recorded === 'string' ? recorded : null });
  }
  return { root, repositories: listed, warnings: [...problems, ...mountProblems, ...warnings], mounts, disputes };
}
// The checkout recorded for any upstream, whether or not a hub registers it. Without one,
// the remedies name the registered repository, or a placeholder when none has that upstream.
export async function recordedCheckout(root, upstream) {
  const key = normalizeUpstream(upstream);
  const recorded = (await loadCheckouts(root))[key];
  if (recorded && await isDirectory(recorded)) return { path: recorded };
  const name = (await listRepositories(root)).repositories.find(repository => repository.key === key)?.id ?? '<repository>';
  return { path: null, remedies: [`repos locate ${name} <path>`, `repos clone ${name} [<path>]`] };
}
const view = ({ id, title, upstream, aliases, path, status, mount, alternateIds }) => ({ id, title, upstream, aliases, path, status, ...(mount ? { mount } : {}), ...(alternateIds ? { alternateIds } : {}) });
// What `repos` and `list_repos` show of a repository: a mounted one names its mount, and one
// registered under several concepts names the others as alternateIds.
export const listed = repository => view(repository);

// The registered repository a name means, and the field it matched. An exact id or alternate id
// ends the lookup. Otherwise its title, an alias or its upstream's name (upstreamName), in that
// order: case-insensitively for a workspace repository, as before mounts, and by nameKey for a
// mounted one; when nothing matches so, by nameKey for any. A name a repository gave up (see
// registry) no longer names it, and one only mounts dispute names each of them, so it is
// ambiguous. Keywords never name a repository.
export function findRepository(repositories, name) {
  const exact = repositories.find(item => item.id === name || (item.alternateIds ?? []).includes(name));
  if (exact) return { repository: exact, matched: 'id' };
  const wanted = name.trim();
  const fieldBy = loose => item => {
    if (!wanted || (item.lost ?? []).includes(nameKey(wanted)) || (item.lostCase ?? []).includes(caseKey(wanted))) return null;
    const key = loose || item.mount ? nameKey : caseKey;
    const names = value => key(value) === key(wanted);
    const { title, aliases } = item.claimed ?? item;
    return names(title) ? 'title' : aliases.some(names) ? 'alias' : names(item.name) ? 'upstreamName' : null;
  };
  let field = fieldBy(false);
  let matches = repositories.filter(field);
  if (!matches.length) { field = fieldBy(true); matches = repositories.filter(field); }
  if (!matches.length) fail('UNKNOWN_REPOSITORY', `No registered repository is called ${name} (run repos to list them)`);
  if (matches.length > 1) fail('AMBIGUOUS_REPOSITORY', `${name} could be ${matches.map(item => item.id).join(' or ')}; use the id`, { candidates: matches.map(item => item.id) });
  return { repository: matches[0], matched: field(matches[0]) };
}
const find = (repositories, name) => findRepository(repositories, name).repository;
// Normalized URLs of every remote of the git checkout containing path; none outside one.
// A remote that does not normalize (normalizeUpstream throws on bad file: URLs) is skipped alone.
export async function remoteKeys(path) {
  let output;
  try { output = await git(path, ['remote', '-v']); } catch { return new Set(); }
  const key = url => { try { return normalizeUpstream(url); } catch { return null; } };
  return new Set(output.split('\n').map(line => key(line.split(/\s+/)[1])).filter(Boolean));
}
// The checkout's top level and its remotes' normalized URLs, or null when not a git checkout.
async function checkout(path) {
  try {
    const top = await realpath(await gitPath(path, ['rev-parse', '--show-toplevel']));
    if (top !== await realpath(path)) return null;
    const remotes = (await git(path, ['remote', '-v'])).split('\n').map(line => line.split(/\s+/)[1]).filter(Boolean);
    return { path: top, remotes: [...new Set(remotes)], keys: new Set(remotes.map(normalizeUpstream).filter(Boolean)) };
  } catch { return null; }
}

// A checkout's remotes as output shows them: identities, and a count of the unrecognized.
function remoteList(found) {
  const unrecognized = found.remotes.filter(url => remoteIdentity(url) === 'an unrecognized remote').length;
  const shown = [...found.keys].sort().join(', ');
  return [shown, unrecognized ? `${unrecognized} unrecognized` : ''].filter(Boolean).join(' and ') || '(none)';
}
// A fixed category for a failed clone; git's own message may quote the URL with credentials.
function cloneFailure(error) {
  const text = `${error.stderr ?? ''}\n${error.message ?? ''}`;
  if (/Authentication failed|could not read (?:Username|Password)|Permission denied|terminal prompts disabled|Invalid username or password|returned error: 40[13]/i.test(text)) return 'authentication failed';
  if (/Repository not found|not found|does not exist|does not appear to be a git repository|returned error: 404/i.test(text)) return 'not found';
  if (error.killed || /Could not resolve|Failed to connect|Connection (?:refused|timed out|reset|closed)|Network is unreachable|timed out|unable to access/i.test(text)) return 'network error';
  return 'git failed';
}

export async function locateRepository(root, name, path) {
  const { repositories } = await listRepositories(root);
  const repository = find(repositories, name);
  if (!await isDirectory(path)) fail('NOT_A_CHECKOUT', `Not a directory: ${path}`);
  const found = await checkout(resolve(path));
  if (!found) fail('NOT_A_CHECKOUT', `${path} is not the top of a git checkout`);
  if (!found.keys.has(repository.key)) {
    fail('REMOTE_MISMATCH', `${path} has remotes ${remoteList(found)}, not ${remoteIdentity(repository.upstream)}`);
  }
  await saveCheckouts(root, { ...await loadCheckouts(root), [repository.key]: found.path });
  return { root, repository: view({ ...repository, path: found.path, status: 'located' }) };
}

export async function cloneRepository(root, name, path) {
  const { repositories } = await listRepositories(root);
  const repository = find(repositories, name);
  const destination = resolve(path ?? join(process.env.HOME || homedir(), repository.name));
  if (await stat(destination).then(() => true, () => false)) fail('DESTINATION_EXISTS', `${destination} already exists; locate it instead if it is this repository`);
  try { await runGit(null, ['clone', '--quiet', repository.upstream, destination], { timeout: 600000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) {
    const reason = cloneFailure(error);
    fail('CLONE_FAILED', `Could not clone ${remoteIdentity(repository.upstream)}: ${reason}`, { reason, upstream: remoteIdentity(repository.upstream) });
  }
  const real = await realpath(destination);
  await saveCheckouts(root, { ...await loadCheckouts(root), [repository.key]: real });
  return { root, repository: view({ ...repository, path: real, status: 'located' }) };
}

// Writes a draft Repository concept into a hub (personal or shared) and lists it in the
// hub's index; with a checkout path, takes the upstream from its remote and records it.
export async function addRepository(selection, { hub: hubId, upstream, path, title, aliases = [], concept: conceptId, description }) {
  const { root, explicit, actor } = selection;
  const offset = relative(await realpath(KIT_ROOT), root);
  if (!explicit || !offset || offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset)) {
    fail('WRITE_DISABLED', 'Adding repositories requires an explicit workspace outside the toolkit checkout');
  }
  if (!isActor(actor)) fail('INVALID_INPUT', 'Adding a repository needs an actor such as human:<id> or <producer>/<version>');
  await (await import('./mounts.mjs')).refuseMountWrite(root, hubId);
  const hubs = await loadHubs(root);
  const hub = hubs.find(item => item.manifest.id === hubId);
  if (!hub) fail('UNKNOWN_HUB', `Unknown hub: ${hubId}`);
  let found = null;
  const given = upstream !== undefined;
  if (path !== undefined) {
    found = await checkout(resolve(path));
    if (!found) fail('NOT_A_CHECKOUT', `${path} is not the top of a git checkout`);
    if (upstream === undefined) {
      const origin = (await git(found.path, ['remote', 'get-url', 'origin']).catch(() => null));
      upstream = origin ?? (found.remotes.length === 1 ? found.remotes[0] : undefined);
      if (!upstream) fail('INVALID_INPUT', `${path} has ${found.remotes.length ? 'several remotes and no origin' : 'no remote'}; give the upstream`);
    }
  }
  if (upstream === undefined) fail('INVALID_INPUT', 'Give the upstream (e.g. https://github.com/<owner>/<name>), or --path to a checkout');
  // The input is never echoed: it may hold credentials. Only its clean form is written or shown.
  const clean = cleanUpstream(upstream);
  if (!clean) fail('INVALID_INPUT', `Not a git upstream${path !== undefined && !given ? ` (the remote of ${path})` : ''}; give one like https://github.com/<owner>/<name>`);
  const key = normalizeUpstream(clean.url);
  if (found && !found.keys.has(key)) fail('REMOTE_MISMATCH', `${path} has remotes ${remoteList(found)}, not ${key}`);
  upstream = clean.url;
  const { repositories } = registry(hubs);
  const existing = repositories.find(item => item.key === key);
  if (existing) fail('REPOSITORY_EXISTS', `${upstream} is already registered as ${existing.id}`);
  const name = repoName(key);
  const titleGiven = title !== undefined;
  title = (title ?? name).trim();
  aliases = [...new Set(aliases.map(alias => alias.trim()).filter(Boolean))];
  if (!title) fail('INVALID_INPUT', 'The title must not be blank');
  if (points(title) > TITLE_MAX) fail('INVALID_INPUT', `The title "${title}" is over ${TITLE_MAX} characters${titleGiven ? '' : ' (it defaults to the upstream\'s name)'}; give a shorter --title`);
  for (const alias of aliases) if (points(alias) > NAME_MAX) fail('INVALID_INPUT', `The alias "${alias}" is over ${NAME_MAX} characters`);
  for (const claimed of [title, ...aliases]) {
    const owner = repositories.find(item => [item.title, ...item.aliases].some(other => other.toLowerCase() === claimed.toLowerCase()));
    if (owner) fail('REPOSITORY_EXISTS', `"${claimed}" already names ${owner.id}; choose another title or alias`);
  }
  const id = conceptId ?? name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(id) || id.split('/').includes('inbox')) fail('INVALID_INPUT', `Invalid concept id: ${id}`);
  const file = join(hub.root, `${id}.md`);
  if (await stat(file).then(() => true, () => false)) fail('CONCEPT_EXISTS', `${hubId} already has a concept ${id}`);
  description = (description ?? `Repository ${upstream}.`).trim();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, conceptText({ type: 'Repository', title, description, resource: upstream, ...(aliases.length ? { aliases } : {}),
    status: 'draft', generated: { by: actor, at: timestamp() } },
  `# ${title}\n\nUpstream: ${upstream}\n\nAdd what someone needs to work on it: what it is, how to run and test it, who owns it.\n`), { flag: 'wx' });
  // List it in the index of its own directory, or the hub's root index.
  for (const directory of [dirname(file), hub.root]) {
    const index = join(directory, 'index.md');
    const text = await readFile(index, 'utf8').catch(() => null);
    if (text === null) continue;
    await appendFile(index, `${text.endsWith('\n') ? '' : '\n'}* [${title}](${relative(directory, file).split('\\').join('/')}) - ${description}\n`);
    break;
  }
  if (found) await saveCheckouts(root, { ...await loadCheckouts(root), [key]: found.path });
  const repository = { id: `${hubId}/${id}`, title, upstream, aliases, path: found?.path ?? null, status: found ? 'located' : 'missing' };
  const notice = clean.stripped ? { removed: `The ${given ? 'upstream' : 'checkout\'s remote'} carried credentials, a query or a fragment; only ${upstream} was stored` } : {};
  return { root, concept: relative(root, file), repository, ...notice };
}

// A linked worktree's main worktree, as `git worktree list` reports it, or why there is none
// to record; null when path is not a linked worktree. Git reports a `--separate-git-dir`
// checkout's git directory as its main worktree, so the main must itself be a checkout.
async function mainWorktree(path) {
  const gitDir = await gitPath(path, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = await gitPath(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (await realpath(gitDir) === await realpath(common)) return null;
  // -z keeps every path character: attributes end with NUL, entries with an empty attribute.
  const [main] = (await runGit(path, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0');
  const fields = main.split('\0');
  const reported = fields.find(field => field.startsWith('worktree ')).slice('worktree '.length);
  if (fields.includes('bare')) return { reason: `a worktree of the bare repository ${reported}` };
  if (!await isDirectory(reported)) return { reason: `a worktree of ${reported}, which no longer exists` };
  const found = await checkout(reported);
  if (!found) return { reason: `a worktree whose main worktree git reports as ${reported}, which is not a checkout` };
  return { path: found.path };
}
// The same, failing closed: an error from git is a reason not to record anything.
const resolveMain = path => mainWorktree(path).catch(() => ({ reason: 'a worktree whose worktrees git could not list' }));
// A `.git` file naming a git directory that is gone: a worktree whose main checkout was deleted.
async function brokenWorktree(path) {
  const text = await readFile(join(path, '.git'), 'utf8').catch(() => null);
  const gitDir = text?.startsWith('gitdir: ') ? text.slice('gitdir: '.length).replace(/\r?\n$/, '') : null;
  if (!gitDir || await stat(resolve(path, gitDir)).then(() => true, () => false)) return null;
  return `a worktree whose git directory ${resolve(path, gitDir)} no longer exists, so its main checkout is gone`;
}
const readable = path => readdir(path, { withFileTypes: true }).catch(() => []);
export const SCAN_DEPTH_LIMIT = 6;

// The fetch remotes of a checkout as [name, identity], skipping any that don't normalize.
async function namedRemotes(top) {
  const output = await git(top, ['remote', '-v']).catch(() => '');
  const remotes = [];
  for (const line of output.split('\n')) {
    const match = /^(\S+)\t(.*) \(fetch\)$/.exec(line);
    let key = null;
    try { key = match && normalizeUpstream(match[2]); } catch { key = null; }
    if (key) remotes.push([match[1], key]);
  }
  return remotes;
}
const within = (parent, path) => { const offset = relative(parent, path); return offset !== '..' && !offset.startsWith('../') && !isAbsolute(offset); };
// Which of the user's repositories a path belongs to: the innermost git checkout containing it
// (never an enclosing one), matched by its remotes' identities. A pure lookup: nothing is recorded.
// Remotes appear only as the registered repository's identity, never as the URL a checkout holds.
export async function whichRepository(root, path) {
  const given = resolve(path);
  const real = await realpath(given).catch(() => null);
  if (!real) fail('INVALID_PATH', `No such file or directory: ${path}`);
  const directory = await isDirectory(real) ? real : dirname(real);
  let hubs = [];
  try { hubs = await loadHubs(root); } catch (error) { if (error.code !== 'NO_HUBS') throw error; }
  // A hub directory, by its real path, whether or not it is also a checkout.
  let hub = null;
  for (const item of hubs) {
    const hubRoot = await realpath(item.root).catch(() => null);
    if (hubRoot && within(hubRoot, real) && (!hub || hubRoot.length > hub.length)) hub = { id: item.manifest.id, length: hubRoot.length };
  }
  const result = { root, path: real, ...(hub ? { hub: hub.id } : {}) };
  let top = null;
  try { top = await realpath(await gitPath(directory, ['rev-parse', '--show-toplevel'])); } catch { top = null; }
  const found = top && await checkout(top);
  if (!found) {
    const broken = await brokenWorktree(directory);
    return { ...result, repository: null, ...(broken ? { reason: broken } : {}) };
  }
  const { repositories } = await listRepositories(root);
  const remotes = await namedRemotes(found.path);
  const keys = new Set(remotes.map(([, key]) => key));
  const matches = repositories.filter(item => keys.has(item.key));
  const where = { checkout: found.path, relative: relative(found.path, real) || '.' };
  const brief = item => ({ id: item.id, title: item.title, hub: item.hub, concept: item.concept, upstream: item.key });
  let match = matches.length === 1 ? matches[0] : null;
  if (matches.length > 1) {
    const origin = remotes.find(([name]) => name === 'origin')?.[1];
    const preferred = origin ? matches.filter(item => item.key === origin) : [];
    if (preferred.length === 1) match = preferred[0];
    else return { ...result, repository: null, status: 'ambiguous', ...where, candidates: matches.map(brief) };
  }
  if (!match) return { ...result, repository: null, ...where };
  const recorded = match.path ? await realpath(match.path).catch(() => match.path) : null;
  const status = { ...result, repository: brief(match), ...where, recorded };
  if (recorded === found.path) return { ...status, status: 'recorded' };
  const main = await resolveMain(found.path);
  if (main?.reason) return { ...status, status: 'worktree', main: null, reason: main.reason };
  if (main && main.path === recorded) return { ...status, status: 'worktree', main: main.path };
  return { ...status, status: 'unrecorded', ...(main ? { main: main.path } : {}) };
}

// The directory and its subdirectories down to depth levels, breadth-first and sorted, never
// entering hidden directories, node_modules, a checkout below the directory, or the directory
// itself when it is a registered repository's checkout. A linked
// worktree records its main worktree, or nothing and the reason (skipped).
export async function scanRepositories(root, directory, { depth = 1 } = {}) {
  const base = await realpath(resolve(directory)).catch(() => null);
  if (!base || !await isDirectory(base)) fail('INVALID_PATH', `Not a directory: ${directory}`);
  if (!Number.isInteger(depth) || depth < 0 || depth > SCAN_DEPTH_LIMIT) fail('INVALID_INPUT', `depth must be 0 to ${SCAN_DEPTH_LIMIT}`);
  const { repositories } = await listRepositories(root);
  const checkouts = await loadCheckouts(root);
  const recorded = [];
  const skipped = [];
  const open = () => repositories.filter(item => item.status === 'missing' && !recorded.some(done => done.id === item.id));
  let level = [base];
  for (let current = 0; level.length && open().length; current++) {
    const next = [];
    for (const candidate of level) {
      if (!open().length) break;
      const entries = await readable(candidate);
      if (entries.some(entry => entry.name === '.git')) {
        const broken = await brokenWorktree(candidate);
        const found = broken ? null : await checkout(candidate);
        if (broken) skipped.push({ path: candidate, reason: broken });
        const match = found && open().find(item => found.keys.has(item.key));
        if (match) {
          const main = await resolveMain(found.path);
          if (main?.reason) skipped.push({ id: match.id, path: found.path, reason: main.reason });
          else {
            checkouts[match.key] = main?.path ?? found.path;
            recorded.push({ id: match.id, path: main?.path ?? found.path, ...(main ? { worktree: found.path } : {}) });
          }
        }
        // The scanned directory itself is searched unless it is a registered repository's
        // checkout, so a home directory kept in git still works.
        if (candidate !== base ? found || broken : found && repositories.some(item => found.keys.has(item.key))) continue;
      }
      // One push per entry: spreading a huge directory's entries overflows the call stack.
      if (current < depth) for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') next.push(join(candidate, entry.name));
    }
    level = next.sort();
  }
  if (recorded.length) await saveCheckouts(root, checkouts);
  const missing = open().map(item => item.id);
  return { root, scanned: base, depth, recorded, skipped: skipped.filter(item => !item.id || missing.includes(item.id)), missing };
}

const expandHome = path => path === '~' ? process.env.HOME || homedir() : path.startsWith('~/') ? join(process.env.HOME || homedir(), path.slice(2)) : path;
export const remedies = id => [`repos locate ${id} <path>`, `repos clone ${id} [<path>]`];

// A new machine: scan each directory, clone the repositories named in clone, then ask about
// each one still missing when ask is given (a function from a repository to its answer line,
// or null at the end of input): a path to locate, `clone`, `clone <path>`, or empty to skip.
// A repository is cloned only when named or answered `clone`.
export async function setupRepositories(root, { scan, depth = 2, clone = [], ask = null, tell = () => {} }) {
  const directories = scan?.length ? scan : [process.env.HOME || homedir()];
  for (const directory of directories) if (!await isDirectory(resolve(expandHome(directory)))) fail('INVALID_PATH', `Not a directory: ${directory}`);
  if (!Number.isInteger(depth) || depth < 0 || depth > SCAN_DEPTH_LIMIT) fail('INVALID_INPUT', `depth must be 0 to ${SCAN_DEPTH_LIMIT}`);
  const registered = (await listRepositories(root)).repositories;
  const named = clone.map(name => find(registered, name));
  const result = { root, scanned: [], depth, recorded: [], skipped: [], cloned: [], located: [], failed: [], missing: [] };
  for (const directory of directories) {
    const scanned = await scanRepositories(root, expandHome(directory), { depth });
    result.scanned.push(scanned.scanned);
    result.recorded.push(...scanned.recorded);
    result.skipped.push(...scanned.skipped);
  }
  const missing = async () => (await listRepositories(root)).repositories.filter(item => item.status === 'missing');
  const attempt = async (repository, action) => {
    try { return (await action()).repository; }
    catch (error) {
      if (!error.code) throw error;
      const message = redact(error.message);
      result.failed.push({ id: repository.id, code: error.code, message });
      tell(`${error.code}: ${message}`);
      return null;
    }
  };
  for (const repository of named) {
    if (!(await missing()).some(item => item.id === repository.id)) continue;
    const done = await attempt(repository, () => cloneRepository(root, repository.id));
    if (done) result.cloned.push({ id: done.id, path: done.path });
  }
  if (ask) {
    for (const repository of await missing()) {
      for (;;) {
        const answer = await ask(repository);
        const line = answer?.trim() ?? '';
        if (!line) break;
        const [word, ...rest] = line.split(/\s+/);
        if (word === 'clone') {
          const destination = rest.length ? resolve(expandHome(line.slice(word.length).trim())) : undefined;
          const done = await attempt(repository, () => cloneRepository(root, repository.id, destination));
          if (done) { result.cloned.push({ id: done.id, path: done.path }); break; }
        } else {
          const path = resolve(expandHome(line));
          const main = await isDirectory(path) && await checkout(path) ? await resolveMain(path) : null;
          if (main?.reason) { result.failed.push({ id: repository.id, code: 'NOT_A_CHECKOUT', message: `${path} is ${main.reason}` }); tell(`${path} is ${main.reason}`); continue; }
          const done = await attempt(repository, () => locateRepository(root, repository.id, main?.path ?? path));
          if (done) { result.located.push({ id: done.id, path: done.path }); break; }
        }
      }
    }
  }
  const left = await missing();
  result.skipped = result.skipped.filter(item => !item.id || left.some(other => other.id === item.id));
  result.failed = result.failed.filter(item => left.some(other => other.id === item.id));
  result.missing = left.map(item => ({ id: item.id, upstream: item.key, remedies: remedies(item.id) }));
  return result;
}

// The routing skill's description budget, in code points (the Agent Skills limit).
const DESCRIPTION_MAX = 1024;
const LEAD = 'Use when the user mentions one of their own repositories: ';
const TAIL = '. Gives its local checkout and upstream so you work there instead of searching the filesystem.';
const shardName = index => index ? `${ROUTING_SKILL}-${index + 1}` : ROUTING_SKILL;

// A repository's candidate names from its effective triggers: the primary name (title,
// else first alias, else id), then the remaining aliases and keywords, deduplicated
// case-insensitively against the names before them.
function candidates(repository) {
  const { id, triggers } = repository;
  const primary = triggers.title ?? triggers.aliases[0] ?? id;
  // Bounded names guarantee every minimal entry fits a description on its own; a long id doesn't.
  if (primary === id && points(id) > TITLE_MAX) fail('INVALID_REPOSITORY', unnamed(id));
  // Within one repository, names compare as between repositories of its kind.
  const key = repository.mount ? nameKey : caseKey;
  const seen = new Set([key(primary)]);
  const fresh = names => names.filter(name => !seen.has(key(name)) && seen.add(key(name)));
  const aliases = fresh(triggers.aliases);
  return { primary, aliases, keywords: fresh(triggers.keywords) };
}
const describe = (marker, entries) => LEAD + marker + entries
  .map(({ primary, names }) => names.length ? `${primary} (${names.join(', ')})` : primary).join('; ') + TAIL;
const fits = (marker, entries) => points(describe(marker, entries)) <= DESCRIPTION_MAX;
const minimal = item => ({ primary: item.primary, names: item.aliases.slice(0, 1) });

// Contiguous groups of items, in order, each with at most `cap` code points of minimal
// description under `marker`: greedy, so each group is as full as the cap allows.
function partition(items, marker, cap) {
  const groups = [[]];
  for (const item of items) {
    const current = groups.at(-1);
    if (current.length && points(describe(marker, [...current, item].map(minimal))) > cap) groups.push([item]);
    else current.push(item);
  }
  return groups;
}

// Splits repositories (in id order) into the fewest shards whose minimal entries fit one
// description each, balanced: the smallest cap that still needs no more shards decides the
// split, so names are left out evenly rather than all from the first shard. Then each shard
// is filled in rounds: every second alias, every third, ..., then every first keyword,
// every second, .... A name that doesn't fit is skipped and the round goes on. Shard markers
// are reserved at their widest, so a later shard can never overflow an earlier one.
//
// Mounted repositories never cost the workspace's own a name, nor make its skill large: they
// share one shard with them only when everything fits one description, no workspace name is
// skipped and their part of the body is small (SHARED_BODY_MAX); otherwise the workspace's
// repositories get their own shards first, then the mounts' theirs. A mounted shard's body is
// bounded (SHARD_BODY_MAX bytes, SHARD_LINES_MAX lines, estimated per repository), and there are
// at most MOUNT_SHARDS_MAX mounted shards; repositories past them are reachable through `repos`
// and `repos open`, which the last mounted shard says.
export const MOUNT_SHARDS_MAX = 4;
const SHARD_BODY_MAX = 24 * 1024;
const SHARD_LINES_MAX = 400;
const SHARED_BODY_MAX = 4 * 1024;
// A repository's row in the body's YAML table.
const tableRow = ({ id, title, aliases, keywords, upstream, path, mount, alternateIds }) => ({ id, title, aliases, ...(keywords.length ? { keywords } : {}), upstream,
  ...(mount ? { mount } : {}), ...(alternateIds ? { alternateIds } : {}), path: path ?? 'missing' });
// What a repository adds to a skill, estimated: its metadata line, its table row and its four
// command lines (a launcher path of up to 200 bytes and its id in each).
function bodyCost({ repository }) {
  const row = stringify([tableRow(repository)], { lineWidth: 0 });
  const metadata = Buffer.byteLength([repository.id, repository.upstream, ...repository.aliases, ...repository.keywords].join(', ')) + 80;
  return { bytes: metadata + Buffer.byteLength(row) + 4 * (220 + Buffer.byteLength(repository.id)), lines: row.split('\n').length + 5 };
}
const costOf = items => items.map(bodyCost).reduce((sum, cost) => ({ bytes: sum.bytes + cost.bytes, lines: sum.lines + cost.lines }), { bytes: 0, lines: 0 });
const isMounted = set => Boolean(set[0]?.repository.mount);
// Consecutive pieces of a group, each within the body bounds (one repository at least).
function byBody(group) {
  const pieces = [[]];
  let used = { bytes: 0, lines: 0 };
  for (const item of group) {
    const cost = bodyCost(item);
    if (pieces.at(-1).length && (used.bytes + cost.bytes > SHARD_BODY_MAX || used.lines + cost.lines > SHARD_LINES_MAX)) { pieces.push([]); used = { bytes: 0, lines: 0 }; }
    pieces.at(-1).push(item);
    used = { bytes: used.bytes + cost.bytes, lines: used.lines + cost.lines };
  }
  return pieces;
}
export function routingShards(repositories) {
  const items = repositories.filter(repository => !repository.unroutable).map(repository => ({ repository, ...candidates(repository) }));
  if (!items.length) return [];
  const own = items.filter(item => !item.repository.mount);
  const mounted = items.filter(item => item.repository.mount);
  if (!own.length || !mounted.length) return layout([items]);
  const together = layout([items]);
  if (together.length === 1 && !own.some(item => together[0].skipped[item.repository.id]) && costOf(mounted).bytes <= SHARED_BODY_MAX) return together;
  return layout([own, mounted]);
}
// The fewest balanced groups of one set of items whose minimal entries fit under `widest`.
function balanced(items, widest) {
  if (fits(widest, items.map(minimal))) return [items];
  const count = partition(items, widest, DESCRIPTION_MAX).length;
  let low = Math.max(...items.map(item => points(describe(widest, [minimal(item)]))));
  let high = DESCRIPTION_MAX;
  while (low < high) {
    const cap = Math.floor((low + high) / 2);
    if (partition(items, widest, cap).length <= count) high = cap; else low = cap + 1;
  }
  return partition(items, widest, low);
}
// Shards for sets of items, each set split on its own: one unmarked shard when there is one set
// whose minimal entries all fit one description (and, mounted, whose body is within bounds),
// else marked shards; a mounted set gets at most MOUNT_SHARDS_MAX of them.
function layout(sets) {
  const oversized = set => isMounted(set) && (costOf(set).bytes > SHARD_BODY_MAX || costOf(set).lines > SHARD_LINES_MAX);
  let groups = sets;
  let marker = () => '';
  let omitted = [];
  if (sets.length > 1 || !fits('', sets[0].map(minimal)) || oversized(sets[0])) {
    const digits = String(sets.reduce((sum, set) => sum + set.length, 0)).length;
    const widest = `(${'9'.repeat(digits)} of ${'9'.repeat(digits)}) `;
    groups = [];
    for (const set of sets) {
      let parts = balanced(set, widest);
      if (isMounted(set)) {
        parts = parts.flatMap(byBody);
        if (parts.length > MOUNT_SHARDS_MAX) { omitted = parts.slice(MOUNT_SHARDS_MAX).flat().map(item => item.repository.id); parts = parts.slice(0, MOUNT_SHARDS_MAX); }
      }
      groups.push(...parts);
    }
    marker = index => `(${index + 1} of ${groups.length}) `;
  }
  const last = groups.length - 1;
  return groups.map((group, index) => {
    const entries = group.map(minimal);
    const skipped = {};
    const tryAdd = (at, name) => {
      entries[at].names.push(name);
      if (fits(marker(index), entries)) return;
      entries[at].names.pop();
      (skipped[group[at].repository.id] ??= []).push(name);
    };
    // In a shard they share, the workspace's own repositories fill their rounds first.
    for (const own of [true, false]) {
      const members = group.map((item, at) => ({ item, at })).filter(({ item }) => !item.repository.mount === own);
      const rounds = Math.max(0, ...members.map(({ item }) => item.aliases.length));
      for (let round = 1; round < rounds; round++) members.forEach(({ item, at }) => item.aliases[round] !== undefined && tryAdd(at, item.aliases[round]));
      const keywordRounds = Math.max(0, ...members.map(({ item }) => item.keywords.length));
      for (let round = 0; round < keywordRounds; round++) members.forEach(({ item, at }) => item.keywords[round] !== undefined && tryAdd(at, item.keywords[round]));
    }
    return { name: shardName(index), description: describe(marker(index), entries), repositories: group.map(item => item.repository),
      primaries: Object.fromEntries(group.map(item => [item.repository.id, item.primary])), skipped, of: groups.length,
      ...(index === last && omitted.length ? { omitted } : {}) };
  });
}

// One shard's SKILL.md. Deterministic: same inputs, same bytes. Frontmatter uses only
// Agent Skills keys (name, description, metadata as a string-to-string map). `entry` is how
// agents reach the workspace without its path: the MCP server's name, the launcher command
// and the operation marked `resolve` ({tool, command}); every command goes through the
// launcher, so the text keeps working when the workspace moves.
// Inline code that survives backticks in the text (a path can hold one).
function code(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `\`${text}\``;
}
// The workspace line: the path as is, or as a JSON string when it can't sit on one line as is.
export const workspaceLine = root => `- Workspace: ${/[\n\r]|^["\s]|\s$/.test(root) ? JSON.stringify(root) : root}`;
// A command word as a POSIX shell reads it: plain, or single-quoted.
const word = value => /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
// The concept read command: hub and concept ID for a workspace hub, the ref for a mount's.
const readArgs = item => item.mount ? word(`${item.hub}:/${item.concept}`) : `${item.hub} ${item.concept}`;
// Recovery guidance for each declared mount that is not fetched or is broken: the exact fetch
// command through the launcher, never a change of directory.
function mountGuidance(unavailable, run) {
  if (!unavailable.length) return '';
  return `
## Mounted hubs not available on this machine

Repositories from these mounted hubs are not listed here until their pinned content is
fetched. When the user needs one, fetch it (this reaches the mount's source); fetching
rebuilds this skill:

${unavailable.map(mount => `- \`${mount.name}\` (${mount.status}): ${code(run(`mounts fetch ${mount.name}`))}`).join('\n')}
`;
}
function routingSkill(root, shard, names, entry, { unavailable = [], disputes = [] } = {}) {
  const { repositories, primaries } = shard;
  // Shown aliases are already only the ones that name the repository (see registry).
  const effective = item => item.aliases;
  const listing = item => [effective(item).length ? `aliases: ${effective(item).join(', ')}` : '', item.keywords.length ? `keywords: ${item.keywords.join(', ')}` : '',
    item.mount ? `mount: ${item.mount}` : ''].filter(Boolean).join('; ');
  const metadata = Object.fromEntries(repositories.map(item => [item.id,
    `${item.upstream} ${item.path ? `at ${item.path}` : '(missing on this machine)'}${listing(item) ? `; ${listing(item)}` : ''}`]));
  const run = command => `${entry.launcher} ${command}`;
  const table = repositories.map(tableRow);
  const missing = repositories.filter(item => !item.path);
  const here = new Set(repositories.map(item => item.id));
  // Disputes over this shard's repositories, each naming only this shard's ids (a few at most),
  // so a hostile mount can't grow one shard's body without bound.
  const DISPUTES_SHOWN = 50;
  const ambiguous = disputes.map(dispute => ({ ...dispute, local: dispute.ids.filter(id => here.has(id)) })).filter(dispute => dispute.local.length);
  const mounted = [...new Set(repositories.filter(item => item.mount).map(item => item.mount))];
  // A mount's names are someone else's text: set as code, so they never read as Markdown.
  const label = item => item.mount ? code(primaries[item.id]) : primaries[item.id];
  const others = names.filter(name => name !== shard.name);
  return `---\n${stringify({ name: shard.name, description: shard.description, metadata }, { lineWidth: 0 })}---\n
# My repositories${shard.of > 1 ? ` (${names.indexOf(shard.name) + 1} of ${shard.of})` : ''}

Generated by Context Kit from the workspace's \`type: Repository\` concepts and this
machine's checkouts. Do not edit; it is rewritten when repositories change.
${others.length ? `
This skill lists some of the user's repositories; the others are in ${others.map(name => `\`${name}\``).join(', ')}.
${code(run('repos'))} lists them all.
` : ''}
When the user mentions one of these repositories, by title, alias or keyword, open it
first and work in its \`path\`. Do not search the filesystem for it. To open one, call the
\`${entry.resolve.tool}\` tool of the \`${entry.server}\` MCP server, or run
${code(run(entry.resolve.command))}. Both work from any directory.${entry.named ? ` At a terminal,
\`${entry.named}\` is the same launcher when its directory is on \`PATH\`.` : ''}
When reviewing with a role the repository declares, such as \`reviewer\`, add
\`--role <role>\` (the tool's \`role\`).

\`\`\`yaml
${stringify(table, { lineWidth: 0 }).trimEnd()}
\`\`\`

## Before changing a repository

Open it before anything else, even for a quick fix. One call resolves its checkout
and points at the checkout's \`AGENTS.md\` (or \`CLAUDE.md\`), the repository's
concept and its tracked files. A session started outside a checkout does not load
its instructions, so read the ones it points at and follow the workflow they
describe end to end; do not offer its steps as optional.

${repositories.map(item => `- ${label(item)}: open with ${code(run(entry.resolve.command.replace('<repo>', () => word(item.id))))}`).join('\n')}

Read a concept with the launcher:

${repositories.map(item => `- ${label(item)}: ${code(`${run('read')} ${readArgs(item)}`)}`).join('\n')}
${ambiguous.length ? `
## Names that need an id

${ambiguous.slice(0, DISPUTES_SHOWN).map(dispute => {
    const shown = dispute.local.slice(0, 5).map(code);
    const more = dispute.ids.length - shown.length;
    return `- ${code(dispute.name)} may mean ${shown.join(' or ')}${more ? ` or ${more} more (${code(run('repos'))} lists them)` : ''}; ask which, then use the id.`;
  }).join('\n')}${ambiguous.length > DISPUTES_SHOWN ? `\n- ${ambiguous.length - DISPUTES_SHOWN} more names need an id; ${code(run('repos'))} and its warnings list them.` : ''}
` : ''}${missing.length ? `
## Missing on this machine

Ask before cloning or recording anything:

${missing.map(item => `- ${label(item)}: clone it with ${code(`${run('repos clone')} ${word(item.id)}`)}, or if the user has it elsewhere, record that with ${code(`${run('repos locate')} ${word(item.id)} <path>`)}.`).join('\n')}
` : ''}${mountGuidance(unavailable, run)}${shard.omitted ? `
## More from mounted hubs

${shard.omitted.length} more ${shard.omitted.length === 1 ? 'repository' : 'repositories'} from mounted hubs ${shard.omitted.length === 1 ? 'is' : 'are'} not listed in these skills, to keep
them small. ${code(run('repos'))} lists every repository, and ${code(run('repos open <id>'))} opens any of them.
` : ''}
## More

- A new repository of the user's isn't listed until it has a \`type: Repository\`
  concept with \`resource\` (its upstream) and \`aliases\`; suggest adding one, then
  ${code(run('repos sync'))} to rebuild this skill.
${mounted.length ? `- A repository whose id starts with ${mounted.map(name => code(`${name}:/`)).join(', ')} comes from a mounted hub;
  it changes in that hub's own repository, and ${code(run('mounts upgrade <mount>'))} brings the change here.
` : ''}- A command that fails with \`WORKSPACE_MOVED\` means the workspace moved: ask the
  user to run \`agents install\` once from its new location.
${workspaceLine(root)}
`;
}

export const isRoutingName = name => name === ROUTING_SKILL || new RegExp(`^${ROUTING_SKILL}-[1-9][0-9]*$`).test(name);
// Declared mounts that are not fetched or are broken.
const unavailableMounts = listing => (listing?.mounts ?? []).filter(mount => mount.status !== 'fetched');
// The routing skill for a workspace whose only repositories would come from mounts not available
// here: what is missing and the exact fetch commands, so an agent started anywhere can recover.
function recoverySkill(root, unavailable, entry) {
  const run = command => `${entry.launcher} ${command}`;
  // Mount names are lowercase words and hyphens; as many as fit, with room kept for the count.
  const describe = list => `Use when the user mentions one of their own repositories: the ones from the mounted hubs ${list} are not available on this machine yet. Gives the command that fetches them.`;
  const shown = [];
  for (const mount of unavailable) if (points(describe([...shown, mount.name].join(', ') + ' and 99999 more')) <= DESCRIPTION_MAX) shown.push(mount.name);
  const more = unavailable.length - shown.length;
  const description = describe(`${shown.join(', ')}${more ? ` and ${more} more` : ''}`);
  return `---\n${stringify({ name: ROUTING_SKILL, description }, { lineWidth: 0 })}---\n
# My repositories

Generated by Context Kit from the workspace's \`type: Repository\` concepts and this
machine's checkouts. Do not edit; it is rewritten when repositories change.

No repository is listed on this machine yet: the workspace registers none of its own,
and its mounted hubs below are not fetched here.
${mountGuidance(unavailable, run)}
## More

- After fetching, ${code(run('repos'))} lists the repositories; ${code(run('repos sync'))} rebuilds this skill.
- A command that fails with \`WORKSPACE_MOVED\` means the workspace moved: ask the
  user to run \`agents install\` once from its new location.
${workspaceLine(root)}
`;
}
// The names of the routing skills a listing (listRepositories' result, or its repositories)
// renders to, without writing anything.
export function routingSkillNames(listing) {
  const shards = routingShards(Array.isArray(listing) ? listing : listing.repositories).map(shard => shard.name);
  return shards.length || !unavailableMounts(listing).length ? shards : [ROUTING_SKILL];
}

// Renders generated skills into .state/generated and returns them, each with the names its
// description had no room for (`skipped`, by repository id); removes ones no longer generated.
// `entry` names the MCP server, launcher and resolve operation (see routingSkill). Mounts that
// are not available here add recovery guidance, and alone still make a my-repos skill.
export async function generatedSkills(root, entry) {
  let listing = { repositories: [], mounts: [], disputes: [] };
  try { listing = await listRepositories(root); } catch (error) { if (error.code !== 'NO_HUBS') throw error; }
  const unavailable = unavailableMounts(listing);
  const shards = routingShards(listing.repositories);
  const names = shards.length ? shards.map(shard => shard.name) : unavailable.length ? [ROUTING_SKILL] : [];
  const generated = join(root, '.state', 'generated');
  for (const item of await readdir(generated, { withFileTypes: true }).catch(() => [])) {
    if (item.isDirectory() && isRoutingName(item.name) && !names.includes(item.name)) await rm(join(generated, item.name), { recursive: true, force: true });
  }
  const rendered = shards.length ? shards.map(shard => ({ name: shard.name, skipped: shard.skipped, text: routingSkill(root, shard, names, entry, { unavailable, disputes: listing.disputes }) }))
    : unavailable.length ? [{ name: ROUTING_SKILL, skipped: {}, text: recoverySkill(root, unavailable, entry) }] : [];
  const skills = [];
  for (const { name, skipped, text } of rendered) {
    const directory = join(generated, name);
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'SKILL.md');
    if (await readFile(file, 'utf8').catch(() => null) !== text) await writeFile(file, text);
    skills.push({ name, path: await realpath(directory), generated: true, skipped });
  }
  return skills;
}
// Every skipped name across generated skills, by repository id.
export const skippedNames = skills => Object.assign({}, ...skills.filter(skill => skill.generated).map(skill => skill.skipped ?? {}));
