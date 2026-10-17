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

// host/owner/name for remote URLs (SSH, scp-like or HTTP, any case, with or without .git);
// file:<path> for local upstreams. null when the value is not a git upstream.
export function normalizeUpstream(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (url.startsWith('/')) return `file:${url}`;
  if (url.startsWith('file://')) return `file:${decodeURIComponent(url.slice(7))}`;
  const remote = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)$/i);
  if (!remote || !/^(?:https?|ssh|git|git\+ssh):\/\//i.test(url) && !/^[^/:]+@[^/:]+:/.test(url)) return null;
  const path = remote[2].replace(/^\/+/, '');
  return path.includes('/') ? `${remote[1]}/${path}`.toLowerCase() : null;
}
const repoName = key => key.slice(key.lastIndexOf('/') + 1);

// Registered repositories, sorted by id, plus problems with their fields. Each problem
// names the concept and field; validate fails on them, listings skip those repositories.
export function registry(hubs) {
  const repositories = [];
  const problems = [];
  for (const hub of hubs) {
    for (const [path, data] of [...hub.concepts].sort(([a], [b]) => a.localeCompare(b))) {
      if (data.type !== 'Repository' || path.startsWith('inbox/')) continue;
      const id = `${hub.manifest.id}/${path.slice(0, -3)}`;
      const key = normalizeUpstream(data.resource);
      const aliases = data.aliases ?? [];
      if (!key) problems.push(`${id}: resource must be the repository's git upstream, e.g. https://github.com/<owner>/<name>`);
      if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim())) problems.push(`${id}: aliases must be a list of names`);
      else if (key) repositories.push({ id, hub: hub.manifest.id, concept: path.slice(0, -3), title: typeof data.title === 'string' ? data.title : repoName(key),
        upstream: data.resource.trim(), key, name: repoName(key), aliases: aliases.map(alias => alias.trim()) });
    }
  }
  const claims = new Map();
  for (const repository of repositories) {
    for (const name of new Set([repository.title, ...repository.aliases].map(item => item.toLowerCase()))) {
      if (!claims.has(name)) claims.set(name, []);
      claims.get(name).push(repository.id);
    }
  }
  for (const [name, ids] of claims) if (ids.length > 1) problems.push(`"${name}" is claimed by ${ids.join(' and ')}; give each repository its own aliases`);
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
const view = ({ id, title, upstream, aliases, path, status }) => ({ id, title, upstream, aliases, path, status });

function find(repositories, name) {
  const wanted = name.trim().toLowerCase();
  const matches = repositories.filter(item => item.id === name ||
    [item.title, item.name, ...item.aliases].some(other => other.toLowerCase() === wanted));
  if (!matches.length) fail('UNKNOWN_REPOSITORY', `No registered repository is called ${name} (run repos to list them)`);
  if (matches.length > 1) fail('AMBIGUOUS_REPOSITORY', `${name} could be ${matches.map(item => item.id).join(' or ')}; use the id`);
  return matches[0];
}
// The checkout's top level and its remotes' normalized URLs, or null when not a git checkout.
async function checkout(path) {
  try {
    const top = await realpath(await git(path, ['rev-parse', '--show-toplevel']));
    if (top !== await realpath(path)) return null;
    const remotes = (await git(path, ['remote', '-v'])).split('\n').map(line => line.split(/\s+/)[1]).filter(Boolean);
    return { path: top, remotes: [...new Set(remotes)], keys: new Set(remotes.map(normalizeUpstream).filter(Boolean)) };
  } catch { return null; }
}

export async function locateRepository(root, name, path) {
  const { repositories } = await listRepositories(root);
  const repository = find(repositories, name);
  if (!await isDirectory(path)) fail('NOT_A_CHECKOUT', `Not a directory: ${path}`);
  const found = await checkout(resolve(path));
  if (!found) fail('NOT_A_CHECKOUT', `${path} is not the top of a git checkout`);
  if (!found.keys.has(repository.key)) {
    fail('REMOTE_MISMATCH', `${path} has remotes ${found.remotes.join(', ') || '(none)'}, not ${repository.upstream}`);
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
  catch (error) { fail('CLONE_FAILED', `git clone ${repository.upstream}: ${(error.stderr || error.message).trim().split('\n').pop()}`); }
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
  if (found && !found.keys.has(key)) fail('REMOTE_MISMATCH', `${path} has remotes ${found.remotes.join(', ')}, not ${upstream}`);
  const { repositories } = registry(hubs);
  const existing = repositories.find(item => item.key === key);
  if (existing) fail('REPOSITORY_EXISTS', `${upstream} is already registered as ${existing.id}`);
  const name = repoName(key);
  title = (title ?? name).trim();
  aliases = [...new Set(aliases.map(alias => alias.trim()).filter(Boolean))];
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

// The directory and its immediate subdirectories only, never hidden ones or node_modules.
export async function scanRepositories(root, directory) {
  const base = resolve(directory);
  if (!await isDirectory(base)) fail('INVALID_PATH', `Not a directory: ${directory}`);
  const { repositories } = await listRepositories(root);
  const checkouts = await loadCheckouts(root);
  const candidates = [base, ...(await readdir(base, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => join(base, entry.name)).sort()];
  const recorded = [];
  for (const candidate of candidates) {
    const open = repositories.filter(item => item.status === 'missing' && !recorded.some(done => done.id === item.id));
    if (!open.length) break;
    const found = await checkout(candidate);
    const match = found && open.find(item => found.keys.has(item.key));
    if (!match) continue;
    checkouts[match.key] = found.path;
    recorded.push({ id: match.id, path: found.path });
  }
  if (recorded.length) await saveCheckouts(root, checkouts);
  const missing = repositories.filter(item => item.status === 'missing' && !recorded.some(done => done.id === item.id)).map(item => item.id);
  return { root, scanned: base, recorded, missing };
}

// The routing skill's text, or null with no repositories. Deterministic: same inputs, same bytes.
function routingSkill(root, repositories) {
  if (!repositories.length) return null;
  const named = withAliases => repositories.map(item => {
    const others = item.aliases.filter(alias => alias.toLowerCase() !== item.title.toLowerCase());
    return withAliases && others.length ? `${item.title} (${others.join(', ')})` : item.title;
  }).join('; ');
  const lead = 'Use when the user mentions one of their own repositories: ';
  const tail = '. Gives its local checkout and upstream so you work there instead of searching the filesystem.';
  let description = lead + named(true) + tail;
  if (description.length > 1000) description = lead + named(false) + ' (aliases in the skill)' + tail;
  const metadata = Object.fromEntries(repositories.map(item => [item.id, `${item.upstream} ${item.path ? `at ${item.path}` : '(missing on this machine)'}`]));
  const command = `cd ${JSON.stringify(root)} && npm run -s hub -- repos`;
  const table = repositories.map(({ id, title, aliases, upstream, path }) => ({ id, title, aliases, upstream, path: path ?? 'missing' }));
  const missing = repositories.filter(item => !item.path);
  return `---\n${stringify({ name: ROUTING_SKILL, description, metadata }, { lineWidth: 0 })}---\n
# My repositories

Generated by Context Kit from the workspace's \`type: Repository\` concepts and this
machine's checkouts. Do not edit; it is rewritten when repositories change.

When the user mentions one of these repositories, by title or alias, work in its
\`path\`. Do not search the filesystem for it.

\`\`\`yaml
${stringify(table, { lineWidth: 0 }).trimEnd()}
\`\`\`
${missing.length ? `
## Missing on this machine

Ask before cloning or recording anything:

${missing.map(item => `- ${item.title}: clone it with \`${command} clone ${item.id}\`, or if the user has it elsewhere, record that with \`${command} locate ${item.id} <path>\`.`).join('\n')}
` : ''}
## More

- Read a repository's concept for how to work on it: \`npm run -s hub -- read ${repositories[0].hub} ${repositories[0].concept}\` (from the workspace).
- A new repository of the user's isn't listed until it has a \`type: Repository\`
  concept with \`resource\` (its upstream) and \`aliases\`; suggest adding one, then
  \`npm run -s hub -- repos sync\` in the workspace to rebuild this skill.
- Workspace: ${root}
`;
}

// Renders generated skills into .state/generated and returns them; removes ones no longer generated.
export async function generatedSkills(root) {
  let repositories = [];
  try { repositories = (await listRepositories(root)).repositories; } catch (error) { if (error.code !== 'NO_HUBS') throw error; }
  const directory = join(root, '.state', 'generated', ROUTING_SKILL);
  const text = routingSkill(root, repositories);
  if (text === null) { await rm(directory, { recursive: true, force: true }); return []; }
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'SKILL.md');
  if (await readFile(file, 'utf8').catch(() => null) !== text) await writeFile(file, text);
  return [{ name: ROUTING_SKILL, path: await realpath(directory), generated: true }];
}
