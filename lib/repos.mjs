// Repositories: every `type: Repository` concept is registered by its upstream (`resource`)
// and `aliases`. Where each one is checked out is recorded per machine in the workspace's
// untracked .state/checkouts.json, and a generated `my-repos` skill tells agents.
import { appendFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { loadHubs, KIT_ROOT } from './hubs.mjs';
import { concept as conceptText, timestamp, isActor } from './okf.mjs';
import { fail } from './files.mjs';

const exec = promisify(execFile);
export const ROUTING_SKILL = 'my-repos';
const git = async (cwd, args) => (await exec('git', args, { cwd, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim();
// Output that is one path, with only git's line ending removed: a path may hold newlines or edge spaces.
const gitPath = async (cwd, args) => (await exec('git', args, { cwd, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.replace(/\n$/, '');
// A last-resort guard on free text: output names remotes by remoteIdentity and never
// echoes git's diagnostics, but anything else that might hold a URL passes through this.
export function redact(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/([?&](?:access_token|private_token|token)=)[^&\s]+/gi, '$1***')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g, '***');
}

// host/owner/name for remote URLs (SSH, scp-like or HTTP, any case, with or without .git);
// file:<path> for local upstreams. null when the value is not a git upstream. The result
// never holds userinfo, a port, a query or a fragment, so it is what output shows of a remote.
// A host is a hostname or a bracketed IPv6 address, never anything holding userinfo.
const HOST = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}])?|\[[0-9a-f:.]+\])$/iu;
export function normalizeUpstream(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const tidy = path => path.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (raw.startsWith('/')) return `file:${tidy(raw)}`;
  if (raw.startsWith('file://')) {
    // file://[host]/path: a host that isn't a plain hostname (userinfo, say) is not an upstream.
    const authority = raw.slice(7).split('/')[0];
    if (authority && !HOST.test(authority)) return null;
    return `file:${decodeURIComponent(tidy(raw).slice(7))}`;
  }
  let host, path;
  const url = raw.match(/^(?:https?|ssh|git|git\+ssh):\/\/([^/]*)(.*)$/is);
  if (url) {
    // Userinfo ends at the authority's last @, so a password holding an unescaped @ never becomes
    // the host; one holding an unescaped / leaves no valid host, or an @ in the path.
    const authority = url[1].slice(url[1].lastIndexOf('@') + 1);
    const port = authority.match(/^(.*?)(?::\d*)?$/s);
    host = port[1];
    path = url[2].replace(/[?#][\s\S]*$/, '');
  } else {
    const scp = raw.match(/^[^/:@]+@([^/:@]+):([\s\S]*)$/);
    if (!scp) return null;
    host = scp[1];
    path = scp[2].replace(/[?#][\s\S]*$/, '');
  }
  if (!HOST.test(host) || path.includes('@')) return null;
  path = tidy(path).replace(/^\/+/, '');
  return path.includes('/') ? `${host}/${path}`.toLowerCase() : null;
}
// How output names a remote: its normalized identity, never the URL as given.
export function remoteIdentity(value) {
  try { return normalizeUpstream(value) ?? 'an unrecognized remote'; } catch { return 'an unrecognized remote'; }
}
const repoName = key => key.slice(key.lastIndexOf('/') + 1);

// Name bounds, in code points: every repository's minimal routing entry then fits a
// description on its own.
export const TITLE_MAX = 80;
export const NAME_MAX = 60;
const points = text => [...text].length;
const unnamed = id => `${id}: has no title of at most ${TITLE_MAX} characters or alias of at most ${NAME_MAX}, and its id is too long to name it in the routing skill; give it a shorter title or an alias`;

// Registered repositories, sorted by id, plus problems with their fields. Each problem
// names the concept and field; validate fails on them, listings skip repositories without
// a valid upstream or aliases. `triggers` holds a repository's effective trigger names:
// the names renderers may use, never raw concept fields. Until hub-federation narrows
// them, that is every title, alias and keyword within its bound, and every keyword that
// names no other repository.
export function registry(hubs) {
  const repositories = [];
  const problems = [];
  for (const hub of hubs) {
    for (const [path, data] of [...hub.concepts].sort(([a], [b]) => a.localeCompare(b))) {
      if (data.type !== 'Repository' || path.startsWith('inbox/')) continue;
      const id = `${hub.manifest.id}/${path.slice(0, -3)}`;
      const key = normalizeUpstream(data.resource);
      const aliases = data.aliases ?? [];
      // Absent means none; an explicit null or any other non-list is reported.
      let keywords = 'keywords' in data ? data.keywords : [];
      if (!key) problems.push(`${id}: resource must be the repository's git upstream, e.g. https://github.com/<owner>/<name>`);
      if (!Array.isArray(keywords) || keywords.some(keyword => typeof keyword !== 'string' || !keyword.trim())) {
        problems.push(`${id}: keywords must be a list of strings`);
        keywords = [];
      }
      if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim())) problems.push(`${id}: aliases must be a list of names`);
      else if (key) repositories.push({ id, hub: hub.manifest.id, concept: path.slice(0, -3), title: typeof data.title === 'string' ? data.title.trim() : repoName(key),
        upstream: data.resource.trim(), key, name: repoName(key), aliases: aliases.map(alias => alias.trim()), keywords: keywords.map(keyword => keyword.trim()) });
    }
  }
  const claims = new Map();
  for (const repository of repositories) {
    for (const name of new Set([repository.title, ...repository.aliases].filter(Boolean).map(item => item.toLowerCase()))) {
      if (!claims.has(name)) claims.set(name, []);
      claims.get(name).push(repository.id);
    }
  }
  for (const [name, ids] of claims) if (ids.length > 1) problems.push(`"${name}" is claimed by ${ids.join(' and ')}; give each repository its own aliases`);
  // Every hub is a workspace hub today; hub-federation's mounts will warn and drop instead.
  for (const repository of repositories) {
    const { id, title, aliases, keywords } = repository;
    if (points(title) > TITLE_MAX) problems.push(`${id}: title is over ${TITLE_MAX} characters`);
    for (const alias of aliases) if (points(alias) > NAME_MAX) problems.push(`${id}: alias "${alias}" is over ${NAME_MAX} characters`);
    const colliding = new Set();
    for (const keyword of keywords) {
      if (points(keyword) > NAME_MAX) problems.push(`${id}: keyword "${keyword}" is over ${NAME_MAX} characters`);
      const others = (claims.get(keyword.toLowerCase()) ?? []).filter(other => other !== id);
      if (others.length) { colliding.add(keyword); problems.push(`${id}: keyword "${keyword}" names ${others.join(' and ')}; keywords must not be another repository's title or alias`); }
    }
    repository.triggers = {
      title: title && points(title) <= TITLE_MAX ? title : null,
      aliases: aliases.filter(alias => points(alias) <= NAME_MAX),
      keywords: keywords.filter(keyword => points(keyword) <= NAME_MAX && !colliding.has(keyword)),
    };
    // The id is the last fallback name; past the title bound it could overflow a description alone.
    if (!repository.triggers.title && !repository.triggers.aliases.length && points(id) > TITLE_MAX) problems.push(unnamed(id));
  }
  return { repositories: repositories.sort((a, b) => a.id.localeCompare(b.id)), problems };
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

// Repositories with their recorded checkout, or path null when none is recorded or it is gone.
export async function listRepositories(root) {
  let hubs;
  try { hubs = await loadHubs(root); } catch (error) { if (error.code === 'NO_HUBS') hubs = []; else throw error; }
  const { repositories, problems } = registry(hubs);
  const checkouts = await loadCheckouts(root);
  const listed = [];
  for (const repository of repositories) {
    const recorded = checkouts[repository.key];
    const path = recorded && await isDirectory(recorded) ? recorded : null;
    listed.push({ ...repository, path, status: path ? 'located' : 'missing' });
  }
  return { root, repositories: listed, warnings: problems };
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
const view = ({ id, title, upstream, aliases, path, status }) => ({ id, title, upstream, aliases, path, status });

function find(repositories, name) {
  const wanted = name.trim().toLowerCase();
  const matches = repositories.filter(item => item.id === name ||
    [item.title, item.name, ...item.aliases].some(other => other.toLowerCase() === wanted));
  if (!matches.length) fail('UNKNOWN_REPOSITORY', `No registered repository is called ${name} (run repos to list them)`);
  if (matches.length > 1) fail('AMBIGUOUS_REPOSITORY', `${name} could be ${matches.map(item => item.id).join(' or ')}; use the id`);
  return matches[0];
}
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
  try { await exec('git', ['clone', '--quiet', repository.upstream, destination], { timeout: 600000, maxBuffer: 16 * 1024 * 1024 }); }
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
  const hubs = await loadHubs(root);
  const hub = hubs.find(item => item.manifest.id === hubId);
  if (!hub) fail('UNKNOWN_HUB', `Unknown hub: ${hubId}`);
  let found = null;
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
  const key = normalizeUpstream(upstream);
  if (!key) fail('INVALID_INPUT', `Not a git upstream: ${upstream}`);
  if (found && !found.keys.has(key)) fail('REMOTE_MISMATCH', `${path} has remotes ${remoteList(found)}, not ${remoteIdentity(upstream)}`);
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
  return { root, concept: relative(root, file), repository };
}

// A linked worktree's main worktree, as `git worktree list` reports it, or why there is none
// to record; null when path is not a linked worktree. Git reports a `--separate-git-dir`
// checkout's git directory as its main worktree, so the main must itself be a checkout.
async function mainWorktree(path) {
  const gitDir = await gitPath(path, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = await gitPath(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (await realpath(gitDir) === await realpath(common)) return null;
  // -z keeps every path character: attributes end with NUL, entries with an empty attribute.
  const [main] = (await exec('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: path, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.split('\0\0');
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

// The directory and its subdirectories down to depth levels, breadth-first and sorted, never
// entering hidden directories, node_modules or a checkout below the directory itself. A linked
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
        if ((found || broken) && candidate !== base) continue;
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
const remedies = id => [`repos locate ${id} <path>`, `repos clone ${id} [<path>]`];

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
function candidates({ id, triggers }) {
  const primary = triggers.title ?? triggers.aliases[0] ?? id;
  // Bounded names guarantee every minimal entry fits a description on its own; a long id doesn't.
  if (primary === id && points(id) > TITLE_MAX) fail('INVALID_REPOSITORY', unnamed(id));
  const seen = new Set([primary.toLowerCase()]);
  const fresh = names => names.filter(name => !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()));
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
// every second, .... A name that doesn't fit is skipped and the round goes on. One shard iff
// every minimal entry fits together. Shard markers are reserved at their widest, so a later
// shard can never overflow an earlier one.
export function routingShards(repositories) {
  const items = repositories.map(repository => ({ repository, ...candidates(repository) }));
  if (!items.length) return [];
  let groups = [items];
  let marker = () => '';
  if (!fits('', items.map(minimal))) {
    const digits = String(items.length).length;
    const widest = `(${'9'.repeat(digits)} of ${'9'.repeat(digits)}) `;
    const count = partition(items, widest, DESCRIPTION_MAX).length;
    let low = Math.max(...items.map(item => points(describe(widest, [minimal(item)]))));
    let high = DESCRIPTION_MAX;
    while (low < high) {
      const cap = Math.floor((low + high) / 2);
      if (partition(items, widest, cap).length <= count) high = cap; else low = cap + 1;
    }
    groups = partition(items, widest, low);
    marker = index => `(${index + 1} of ${groups.length}) `;
  }
  return groups.map((group, index) => {
    const entries = group.map(minimal);
    const skipped = {};
    const tryAdd = (at, name) => {
      entries[at].names.push(name);
      if (fits(marker(index), entries)) return;
      entries[at].names.pop();
      (skipped[group[at].repository.id] ??= []).push(name);
    };
    const rounds = Math.max(0, ...group.map(item => item.aliases.length));
    for (let round = 1; round < rounds; round++) group.forEach((item, at) => item.aliases[round] !== undefined && tryAdd(at, item.aliases[round]));
    const keywordRounds = Math.max(0, ...group.map(item => item.keywords.length));
    for (let round = 0; round < keywordRounds; round++) group.forEach((item, at) => item.keywords[round] !== undefined && tryAdd(at, item.keywords[round]));
    return { name: shardName(index), description: describe(marker(index), entries), repositories: group.map(item => item.repository),
      primaries: Object.fromEntries(group.map(item => [item.repository.id, item.primary])), skipped, of: groups.length };
  });
}

// One shard's SKILL.md. Deterministic: same inputs, same bytes. Frontmatter uses only
// Agent Skills keys (name, description, metadata as a string-to-string map).
function routingSkill(root, shard, names) {
  const { repositories, primaries } = shard;
  const listing = item => [item.aliases.length ? `aliases: ${item.aliases.join(', ')}` : '', item.keywords.length ? `keywords: ${item.keywords.join(', ')}` : ''].filter(Boolean).join('; ');
  const metadata = Object.fromEntries(repositories.map(item => [item.id,
    `${item.upstream} ${item.path ? `at ${item.path}` : '(missing on this machine)'}${listing(item) ? `; ${listing(item)}` : ''}`]));
  const command = `cd ${JSON.stringify(root)} && npm run -s hub -- repos`;
  const read = `cd ${JSON.stringify(root)} && npm run -s hub -- read`;
  const table = repositories.map(({ id, title, aliases, keywords, upstream, path }) => ({ id, title, aliases, ...(keywords.length ? { keywords } : {}), upstream, path: path ?? 'missing' }));
  const missing = repositories.filter(item => !item.path);
  const others = names.filter(name => name !== shard.name);
  return `---\n${stringify({ name: shard.name, description: shard.description, metadata }, { lineWidth: 0 })}---\n
# My repositories${shard.of > 1 ? ` (${names.indexOf(shard.name) + 1} of ${shard.of})` : ''}

Generated by Context Kit from the workspace's \`type: Repository\` concepts and this
machine's checkouts. Do not edit; it is rewritten when repositories change.
${others.length ? `
This skill lists some of the user's repositories; the others are in ${others.map(name => `\`${name}\``).join(', ')}.
\`${command}\` lists them all.
` : ''}
When the user mentions one of these repositories, by title, alias or keyword, work in
its \`path\`. Do not search the filesystem for it.

\`\`\`yaml
${stringify(table, { lineWidth: 0 }).trimEnd()}
\`\`\`

## Before changing a repository

A session started outside a checkout does not load its instructions, so read them
first, even for a quick fix: the checkout's \`AGENTS.md\` (or \`CLAUDE.md\`) and the
repository's concept. Follow the workflow they describe end to end; do not offer
its steps as optional. Read a concept from the workspace:

${repositories.map(item => `- ${primaries[item.id]}: \`${read} ${item.hub} ${item.concept}\``).join('\n')}
${missing.length ? `
## Missing on this machine

Ask before cloning or recording anything:

${missing.map(item => `- ${primaries[item.id]}: clone it with \`${command} clone ${item.id}\`, or if the user has it elsewhere, record that with \`${command} locate ${item.id} <path>\`.`).join('\n')}
` : ''}
## More

- A new repository of the user's isn't listed until it has a \`type: Repository\`
  concept with \`resource\` (its upstream) and \`aliases\`; suggest adding one, then
  \`npm run -s hub -- repos sync\` in the workspace to rebuild this skill.
- Workspace: ${root}
`;
}

const isRoutingName = name => name === ROUTING_SKILL || new RegExp(`^${ROUTING_SKILL}-[1-9][0-9]*$`).test(name);
// The names of the routing skills the repositories render to, without writing anything.
export function routingSkillNames(repositories) {
  return routingShards(repositories).map(shard => shard.name);
}

// Renders generated skills into .state/generated and returns them, each with the names its
// description had no room for (`skipped`, by repository id); removes ones no longer generated.
export async function generatedSkills(root) {
  let repositories = [];
  try { repositories = (await listRepositories(root)).repositories; } catch (error) { if (error.code !== 'NO_HUBS') throw error; }
  const shards = routingShards(repositories);
  const names = shards.map(shard => shard.name);
  const generated = join(root, '.state', 'generated');
  for (const entry of await readdir(generated, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && isRoutingName(entry.name) && !names.includes(entry.name)) await rm(join(generated, entry.name), { recursive: true, force: true });
  }
  const skills = [];
  for (const shard of shards) {
    const directory = join(generated, shard.name);
    const text = routingSkill(root, shard, names);
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'SKILL.md');
    if (await readFile(file, 'utf8').catch(() => null) !== text) await writeFile(file, text);
    skills.push({ name: shard.name, path: await realpath(directory), generated: true, skipped: shard.skipped });
  }
  return skills;
}
// Every skipped name across generated skills, by repository id.
export const skippedNames = skills => Object.assign({}, ...skills.filter(skill => skill.generated).map(skill => skill.skipped ?? {}));
