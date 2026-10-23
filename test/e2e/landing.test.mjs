import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));

// A strict fake gh. Fixtures are keyed by "METHOD path" and hold an ordered sequence of
// responses: { body }, { pages: [...] } (served whole with --paginate --slurp, else only the
// first page), { status, message, body } (an HTTP error as gh reports it), { drop: true }
// (a lost connection) or a page that is { drop: true } (a connection lost mid-pagination).
// Every call is logged; a call with no fixture, or past the end of its sequence, is logged
// as unexpected and exits nonzero.
const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_GH_DIR;
const log = entry => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(entry) + '\\n');
const args = process.argv.slice(2);
if (args[0] !== 'api') { log({ unexpected: true, args }); process.stderr.write('fake gh: only api is served\\n'); process.exit(97); }
let method = 'GET', endpoint, paginate = false, slurp = false, input = false;
const fields = {};
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--method' || args[i] === '-X') method = args[++i];
  else if (args[i] === '-f') { const [name, ...value] = args[++i].split('='); fields[name] = value.join('='); }
  else if (args[i] === '--paginate') paginate = true;
  else if (args[i] === '--slurp') slurp = true;
  else if (args[i] === '--input') input = args[++i] === '-';
  else if (!args[i].startsWith('-') && endpoint === undefined) endpoint = args[i];
  else { log({ unexpected: true, args }); process.exit(97); }
}
const body = input ? JSON.parse(fs.readFileSync(0, 'utf8') || 'null') : undefined;
const key = method + ' ' + endpoint;
const fixtures = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures.json'), 'utf8'));
const stateFile = path.join(dir, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const index = state[key] ?? 0;
const sequence = fixtures[key];
if (!sequence || index >= sequence.length) {
  log({ unexpected: true, key, reason: sequence ? 'sequence overrun' : 'no fixture' });
  process.stderr.write('fake gh: unexpected call ' + key + '\\n');
  process.exit(97);
}
state[key] = index + 1;
fs.writeFileSync(stateFile, JSON.stringify(state));
log({ key, method, endpoint, paginate, ...(body === undefined ? {} : { body }), ...(Object.keys(fields).length ? { fields } : {}), served: index });
const response = sequence[index];
const lost = () => { process.stderr.write('Put "https://api.github.com/' + endpoint + '": read tcp: connection reset by peer\\n'); process.exit(1); };
if (response.drop) lost();
if (response.status) {
  process.stdout.write(JSON.stringify(response.body ?? { message: response.message, status: String(response.status) }));
  process.stderr.write('gh: ' + response.message + ' (HTTP ' + response.status + ')\\n');
  process.exit(1);
}
if (response.pages) {
  if (!paginate) { process.stdout.write(JSON.stringify(response.pages[0])); process.exit(0); }
  if (!slurp) { log({ unexpected: true, key, reason: 'paginated without --slurp' }); process.exit(97); }
  const served = [];
  for (const page of response.pages) { if (page && page.drop) { process.stdout.write(JSON.stringify(served).slice(0, -1)); lost(); } served.push(page); }
  process.stdout.write(JSON.stringify(served));
  process.exit(0);
}
if (response.body !== null && response.body !== undefined) process.stdout.write(JSON.stringify(response.body));
`;

const R = 'repos/acme/widgets';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const TIP2 = 'd'.repeat(40);
const M = 'e'.repeat(40);
const OLD = 'f'.repeat(40);

// Shapes trimmed from real fayedintoyou/context-kit responses.
const repository = (extra = {}) => ({ full_name: 'acme/widgets', default_branch: 'main', private: false,
  allow_squash_merge: true, allow_rebase_merge: false, allow_merge_commit: false, delete_branch_on_merge: false, ...extra });
const ref = (name, sha) => ({ ref: `refs/heads/${name}`, object: { sha, type: 'commit' } });
const pull = (extra = {}) => ({ number: 7, state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean',
  merge_commit_sha: null, changed_files: 1, html_url: 'https://github.com/acme/widgets/pull/7', labels: [],
  title: 'Widget guide', body: null, user: { login: 'faye' },
  base: { ref: 'main', sha: OLD, repo: { full_name: 'acme/widgets' } },
  head: { ref: 'feature', sha: A, repo: { full_name: 'acme/widgets' } }, ...extra });
const file = (filename, status = 'modified', previous_filename) => ({ filename, status, ...(previous_filename ? { previous_filename } : {}) });
const checkRun = (id, name, suite, conclusion = 'success', extra = {}) => ({ id, name, head_sha: A,
  status: conclusion === null ? 'in_progress' : 'completed', conclusion,
  html_url: `https://github.com/acme/widgets/actions/runs/${suite}/job/${id}`, app: { slug: 'github-actions' }, check_suite: { id: suite }, ...extra });
const workflowRun = (id, suite, path, event = 'pull_request', run_attempt = 1) => ({ id, name: 'checks', path, event, run_attempt,
  check_suite_id: suite, head_sha: A, status: 'completed', conclusion: 'success' });
const checkPages = (runs, size = 100) => ({ pages: chunk(runs, size).map(page => ({ total_count: runs.length, check_runs: page })) });
const workflowPages = runs => ({ pages: [{ total_count: runs.length, workflow_runs: runs }] });
const chunk = (items, size) => items.length ? Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size)) : [[]];
const content = policy => ({ type: 'file', encoding: 'base64', path: '.context-kit/landing.json', content: Buffer.from(JSON.stringify(policy)).toString('base64') });
const notFound = { status: 404, message: 'Not Found' };
const comment = (id, body, at = `2026-10-19T10:${String(id % 60).padStart(2, '0')}:00Z`) => ({ id, body, created_at: at,
  html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`, user: { login: 'faye' } });
const record = (fields = {}) => {
  const values = { 'Reviewed-SHA': A, Phase: 'output', Reviewer: 'reviewer-model, run 12', Outcome: 'approved',
    Findings: '2 found / 2 resolved / 0 deferred', Evidence: 'https://example.com/review/12', ...fields };
  return ['<!-- context-kit:review -->', ...Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`)].join('\n');
};

// The changed files are read from the three-dot compare of the base with the pinned head.
const FILES = `GET ${R}/compare/${OLD}...${A}?per_page=100`;
// A compare commit as GitHub lists it: its message, its git author and the GitHub user behind it.
const commitEntry = (sha, message, { name = 'Faye', email = 'faye@example.com', login = 'faye' } = {}) => ({ sha,
  commit: { message, author: { name, email, date: '2026-10-19T09:00:00Z' } }, author: login === null ? null : { login } });
const diff = (files, commits = [commitEntry(A, 'Edit the guide')]) => ({ status: 'ahead', ahead_by: commits.length, behind_by: 0,
  total_commits: commits.length, merge_base_commit: { sha: OLD }, commits, files });
const TEST = { name: 'test', app: 'github-actions', workflow: '.github/workflows/checks.yml', event: 'pull_request' };
const POLICY = { expectedChecks: [TEST], routine: { paths: ['docs/**', 'README.md'], excludePaths: ['openspec/**'] } };

// The routine happy path: docs-only #7 at A, its expected check passed, merging cleanly.
// Each key holds as many responses as the path reads it; tests replace what they need.
function routes({ policy = POLICY, files = [file('docs/guide.md')], runs = [checkRun(101, 'test', 900)],
  workflows = [workflowRun(50, 900, '.github/workflows/checks.yml')], pr = {}, comments = [], reviews = [] } = {}) {
  const head = pull({ changed_files: files.length, ...pr });
  return {
    [`GET ${R}`]: [{ body: repository() }, { body: repository() }],
    [`GET ${R}/git/ref/heads/main`]: [{ body: ref('main', TIP) }, { body: ref('main', TIP) }],
    [`GET ${R}/contents/.context-kit/landing.json?ref=${TIP}`]: [policy === null ? notFound : { body: content(policy) }],
    [`GET ${R}/pulls/7`]: [{ body: head }, { body: head }],
    [`GET ${R}/rules/branches/main?per_page=100`]: [{ pages: [[]] }, { pages: [[]] }],
    ['POST graphql']: [{ body: { data: { repository: { mergeQueue: null } } } }, { body: { data: { repository: { mergeQueue: null } } } }],
    [FILES]: [{ body: diff(files) }],
    [`GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`]: [checkPages(runs), checkPages(runs)],
    [`GET ${R}/actions/runs?head_sha=${A}&per_page=100`]: [workflowPages(workflows), workflowPages(workflows)],
    [`GET ${R}/issues/7/comments?per_page=100`]: [{ pages: [comments] }, { pages: [comments] }],
    [`GET ${R}/pulls/7/reviews?per_page=100`]: [{ pages: [reviews] }, { pages: [reviews] }],
    [`GET ${R}/pulls?state=open&base=feature&per_page=100`]: [{ pages: [[]] }],
    [`PUT ${R}/pulls/7/merge`]: [{ body: { sha: M, merged: true, message: 'Pull Request successfully merged' } }],
    [`GET ${R}/compare/main...${M}`]: [{ body: { status: 'identical', ahead_by: 0, behind_by: 0 } }],
    [`GET ${R}/git/ref/heads/feature`]: [{ body: ref('feature', A) }, { body: ref('feature', A) }],
    [`GET ${R}/pulls?state=open&head=acme%3Afeature&per_page=100`]: [{ pages: [[]] }],
    [`DELETE ${R}/git/refs/heads/feature`]: [{ body: null }],
  };
}

// An isolated machine: HOME, gh config, a dummy token and a PATH led by the fake, so the
// real gh and real credentials are unreachable.
async function machine(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-landing-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), FAKE_GH);
  await chmod(join(bin, 'gh'), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: join(base, 'home'), GH_TOKEN: 'isolated-test-value', GH_CONFIG_DIR: join(base, 'gh-config'),
    CLAUDE_CONFIG_DIR: join(base, 'claude'), XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'data'), FAKE_GH_DIR: base };
  await mkdir(env.HOME);
  const calls = async () => (await readFile(join(base, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const land = async (fixtures, args, { cwd = base, extraEnv = {} } = {}) => {
    await writeFile(join(base, 'fixtures.json'), JSON.stringify(fixtures));
    await rm(join(base, 'state.json'), { force: true });
    await rm(join(base, 'calls.jsonl'), { force: true });
    let result;
    try {
      const { stdout } = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'pr', 'land', ...args], { env: { ...env, ...extraEnv }, cwd });
      result = { code: 0, json: JSON.parse(stdout) };
    } catch (error) {
      result = { code: error.code, error: JSON.parse(error.stderr.trim().split('\n').pop()).error };
    }
    const log = await calls();
    assert.deepEqual(log.filter(call => call.unexpected), [], 'the fake gh saw no unexpected call');
    return { ...result, calls: log, merged: log.some(call => call.key === `PUT ${R}/pulls/7/merge`), keys: log.map(call => call.key) };
  };
  return { base, env, land };
}
const LAND = ['7', '--sha', A, '--repo', 'acme/widgets'];
const refused = (result, code) => {
  assert.equal(result.code, 1, JSON.stringify(result.json ?? result.error));
  assert.equal(result.error.code, code, result.error.message);
  assert.equal(result.merged, false, 'no merge call');
};
const landed = result => {
  assert.equal(result.code, 0, JSON.stringify(result.error));
  assert.ok(result.merged, 'a merge call');
  return result.json;
};

// spec: pull-request-landing / A routine pull request lands
test('a routine pull request lands pinned to its SHA, confirmed and cleaned up', async t => {
  const { land } = await machine(t);
  const result = await land(routes(), LAND);
  const json = landed(result);
  const merge = result.calls.find(call => call.method === 'PUT');
  assert.deepEqual(merge.body, { sha: A, merge_method: 'squash' });
  assert.equal(json.status, 'merged');
  assert.deepEqual(json.merge, { sha: M, method: 'squash' });
  assert.deepEqual(json.policy, { path: '.context-kit/landing.json', branch: 'main', sha: TIP });
  assert.deepEqual(json.branch, { ref: 'feature', deleted: true });
  assert.deepEqual(json.checks.map(check => [check.check, check.state, check.id]), [['test (github-actions, .github/workflows/checks.yml on pull_request)', 'passed', 101]]);
  assert.equal(json.substantial.value, false);
  assert.deepEqual(json.review, { required: false, status: 'not_required', exemption: { paths: ['docs/**', 'README.md'], excludePaths: ['openspec/**'] }, others: [] });
  // The refresh re-reads the head, base and checks before the merge; the confirmation follows it.
  const order = result.keys;
  assert.ok(order.lastIndexOf(`GET ${R}/pulls/7`) < order.indexOf(`PUT ${R}/pulls/7/merge`));
  assert.ok(order.indexOf(`GET ${R}/compare/main...${M}`) > order.indexOf(`PUT ${R}/pulls/7/merge`));
  // The head ref is read again after the sharing query, immediately before the delete.
  assert.deepEqual(order.slice(-3), [`GET ${R}/pulls?state=open&head=acme%3Afeature&per_page=100`, `GET ${R}/git/ref/heads/feature`, `DELETE ${R}/git/refs/heads/feature`]);
  assert.ok(result.calls.every(call => call.endpoint.startsWith(`${R}`) || call.endpoint === 'graphql'), 'every call names the repository');
  assert.deepEqual(result.calls.find(call => call.endpoint === 'graphql').fields,
    { query: 'query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){mergeQueue(branch:$b){id}}}', o: 'acme', r: 'widgets', b: 'main' });
});

// spec: pull-request-landing / Wrong head, base or file list
test('a wrong head, a non-default base and a short file list refuse without merging', async t => {
  const { land } = await machine(t);
  refused(await land(routes({ pr: { head: { ref: 'feature', sha: B, repo: { full_name: 'acme/widgets' } } } }), LAND), 'HEAD_MISMATCH');
  refused(await land(routes({ pr: { base: { ref: 'release', sha: OLD, repo: { full_name: 'acme/widgets' } } } }), LAND), 'NOT_DEFAULT_BASE');
  const short = routes({ files: [file('docs/a.md'), file('docs/b.md')] });
  short[`GET ${R}/pulls/7`] = [{ body: pull({ changed_files: 3 }) }];
  const result = await land(short, LAND);
  refused(result, 'EVIDENCE_INCOMPLETE');
  assert.match(result.error.message, /reports 3 changed files but the compare of f{7}\.\.\.a{7} lists 2/);
});

test('a closed pull request, a conflicting one and a truncated listing refuse', async t => {
  const { land } = await machine(t);
  refused(await land(routes({ pr: { state: 'closed', merged: true } }), LAND), 'NOT_OPEN');
  refused(await land(routes({ pr: { mergeable: false, mergeable_state: 'dirty' } }), LAND), 'CONFLICTING');
  const huge = routes();
  huge[`GET ${R}/pulls/7`] = [{ body: pull({ changed_files: 301 }) }];
  const result = await land(huge, LAND);
  refused(result, 'EVIDENCE_INCOMPLETE');
  assert.match(result.error.message, /compare lists at most 300/);
});

test('evidence is collected across pages, and a connection lost mid-listing refuses', async t => {
  const { land } = await machine(t);
  const files = Array.from({ length: 150 }, (_, i) => file(`docs/page-${i}.md`));
  const paged = routes({ files });
  const runs = [...Array.from({ length: 120 }, (_, i) => checkRun(1000 + i, `lint ${i}`, 901)), checkRun(101, 'test', 900)];
  paged[`GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`] = [checkPages(runs), checkPages(runs)];
  const json = landed(await land(paged, LAND));
  assert.equal(json.checks[0].state, 'passed');

  const dropped = routes();
  dropped[`GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`] = [{ pages: [{ total_count: 101, check_runs: runs.slice(0, 100) }, { drop: true }] }];
  refused(await land(dropped, LAND), 'EVIDENCE_INCOMPLETE');
  const lostDiff = routes();
  lostDiff[FILES] = [{ drop: true }];
  refused(await land(lostDiff, LAND), 'EVIDENCE_INCOMPLETE');

  const failing = routes();
  failing[`GET ${R}/issues/7/comments?per_page=100`] = [{ status: 502, message: 'Bad Gateway' }];
  refused(await land(failing, LAND), 'EVIDENCE_INCOMPLETE');
});

// spec: pull-request-landing / A required merge queue
test('a ruleset requiring a merge queue refuses', async t => {
  const { land } = await machine(t);
  const queued = routes();
  queued[`GET ${R}/rules/branches/main?per_page=100`] = [{ pages: [[{ type: 'deletion', ruleset_id: 1 }, { type: 'merge_queue', ruleset_id: 2, parameters: { merge_method: 'SQUASH' } }]] }];
  refused(await land(queued, LAND), 'MERGE_QUEUE_UNSUPPORTED');
  // A private repository without a paid plan can't have rulesets, as GitHub's 403 says.
  const free = routes();
  const upgrade = { status: 403, message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' };
  free[`GET ${R}/rules/branches/main?per_page=100`] = [upgrade, upgrade];
  landed(await land(free, LAND));
  const unreadable = routes();
  unreadable[`GET ${R}/rules/branches/main?per_page=100`] = [{ status: 500, message: 'Server Error' }];
  refused(await land(unreadable, LAND), 'EVIDENCE_INCOMPLETE');
});

// spec: pull-request-landing / Movement before the merge
test('movement found by the refresh refuses with no merge call', async t => {
  const { land } = await machine(t);
  const head = routes();
  head[`GET ${R}/pulls/7`] = [{ body: pull() }, { body: pull({ head: { ref: 'feature', sha: B, repo: { full_name: 'acme/widgets' } } }) }];
  refused(await land(head, LAND), 'HEAD_MOVED');
  const base = routes();
  base[`GET ${R}/git/ref/heads/main`] = [{ body: ref('main', TIP) }, { body: ref('main', TIP2) }];
  refused(await land(base, LAND), 'BASE_MOVED');
  const checks = routes();
  checks[`GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`] = [checkPages([checkRun(101, 'test', 900)]),
    checkPages([checkRun(101, 'test', 900), checkRun(102, 'test', 900, null)])];
  let result = await land(checks, LAND);
  refused(result, 'CHECKS_CHANGED');
  assert.deepEqual(result.error.details.after.map(check => check.state), ['pending']);
  // Mergeability is gated on the fresh read too: conflicting, or still unknown after its re-reads.
  const dirty = routes();
  dirty[`GET ${R}/pulls/7`] = [{ body: pull() }, { body: pull({ mergeable: false, mergeable_state: 'dirty' }) }];
  refused(await land(dirty, LAND), 'CONFLICTING');
  const unknown = pull({ mergeable: null, mergeable_state: 'unknown' });
  const undecided = routes();
  undecided[`GET ${R}/pulls/7`] = [{ body: pull() }, { body: unknown }, { body: unknown }, { body: unknown }];
  result = await land(undecided, LAND);
  refused(result, 'EVIDENCE_INCOMPLETE');
  assert.match(result.error.message, /not computed whether #7 can merge/);
  assert.equal(result.keys.filter(key => key === `GET ${R}/pulls/7`).length, 4, 'the fresh read is retried twice');
});

// spec: pull-request-landing / GitHub rejects the pinned merge
test('a head that moves after the refresh is rejected by GitHub as MERGE_REJECTED', async t => {
  const { land } = await machine(t);
  const moved = routes();
  moved[`PUT ${R}/pulls/7/merge`] = [{ status: 409, message: 'Head branch was modified. Review and try the merge again.' }];
  const result = await land(moved, LAND);
  assert.equal(result.error.code, 'MERGE_REJECTED');
  assert.ok(result.merged, 'the merge call was made');
  assert.match(result.error.message, /A merge call was made.*409/);
  assert.equal(result.calls.filter(call => call.method === 'PUT').length, 1);
});

// spec: pull-request-landing / Conflicting repository
test('a GH_REPO naming another repository refuses before any call', async t => {
  const { land } = await machine(t);
  const result = await land(routes(), LAND, { extraEnv: { GH_REPO: 'acme/other' } });
  assert.equal(result.error.code, 'REPO_AMBIGUOUS');
  assert.deepEqual(result.calls, []);
  landed(await land(routes(), LAND, { extraEnv: { GH_REPO: 'github.com/acme/widgets' } }));
});

async function checkout(base, origin, policy) {
  const path = join(base, 'widgets');
  await mkdir(join(path, '.context-kit'), { recursive: true });
  await exec('git', ['init', '-q'], { cwd: path });
  await exec('git', ['remote', 'add', 'origin', origin], { cwd: path });
  if (policy) await writeFile(join(path, '.context-kit/landing.json'), JSON.stringify(policy));
  return path;
}

// spec: pull-request-landing / A pull request can't loosen its own gate
test('the default branch policy decides, not the local checkout or the head', async t => {
  const { base, land } = await machine(t);
  // The checkout's own policy expects nothing; the repository comes from its origin remote.
  const local = await checkout(base, 'git@github.com:acme/widgets.git', { expectedChecks: [] });
  const fixtures = routes({ runs: [] });
  const result = await land(fixtures, ['7', '--sha', A], { cwd: local });
  refused(result, 'CHECKS_MISSING');
  assert.ok(!result.keys.some(key => key.includes(`ref=${A}`)), 'the head\'s policy is never read');
  const json = landed(await land(routes(), ['7', '--sha', A], { cwd: local }));
  assert.deepEqual(json.policy, { path: '.context-kit/landing.json', branch: 'main', sha: TIP });
  assert.equal(json.repo, 'acme/widgets');
});

test('the repository comes from --repo or origin, from any directory', async t => {
  const { base, land } = await machine(t);
  const elsewhere = join(base, 'elsewhere');
  await mkdir(elsewhere);
  const none = await land(routes(), ['7', '--sha', A], { cwd: elsewhere });
  assert.equal(none.error.code, 'INVALID_INPUT');
  assert.match(none.error.message, /no origin remote; pass --repo/);
  landed(await land(routes(), LAND, { cwd: elsewhere }));
  const local = await checkout(base, 'https://github.com/acme/widgets.git');
  landed(await land(routes(), ['7', '--sha', A], { cwd: local }));
});

// spec: pull-request-landing / The first policy
test('the first policy needs --bootstrap-policy, and that pull request is substantial', async t => {
  const { land } = await machine(t);
  const files = [file('.context-kit/landing.json', 'added')];
  refused(await land(routes({ policy: null, files }), LAND), 'NO_POLICY');
  const bootstrap = routes({ policy: null, files, comments: [comment(1, record())] });
  bootstrap[`GET ${R}/contents/.context-kit/landing.json?ref=${A}`] = [{ body: content(POLICY) }];
  const json = landed(await land(bootstrap, [...LAND, '--bootstrap-policy']));
  assert.deepEqual(json.policy, { path: '.context-kit/landing.json', bootstrap: true, head: A });
  assert.equal(json.substantial.value, true);
  assert.deepEqual(json.substantial.signals, [{ file: '.context-kit/landing.json', reason: 'landing policy (.context-kit/)' }]);
  assert.equal(json.review.status, 'approved');
  // Once the default branch has a policy, bootstrapping is refused.
  const late = await land(routes(), [...LAND, '--bootstrap-policy']);
  refused(late, 'INVALID_INPUT');
  assert.match(late.error.message, /--bootstrap-policy applies only while main has no policy/);
});

test('an invalid policy refuses', async t => {
  const { land } = await machine(t);
  for (const policy of [{ expectedChecks: [], extra: true }, { expectedChecks: [{ name: 'test', app: 'github-actions' }] },
    { expectedChecks: [{ kind: 'status', context: 'ci', skippable: 'no' }] }]) {
    refused(await land(routes({ policy }), LAND), 'INVALID_POLICY');
  }
  const broken = routes();
  broken[`GET ${R}/contents/.context-kit/landing.json?ref=${TIP}`] = [{ body: { type: 'file', encoding: 'base64', content: Buffer.from('{ not json').toString('base64') } }];
  refused(await land(broken, LAND), 'INVALID_POLICY');
});

// spec: pull-request-landing / A check that never ran
test('an expected check that never ran refuses, naming it', async t => {
  const { land } = await machine(t);
  const result = await land(routes({ runs: [checkRun(120, 'lint', 900)] }), LAND);
  refused(result, 'CHECKS_MISSING');
  assert.match(result.error.message, /test \(github-actions, \.github\/workflows\/checks\.yml on pull_request\)/);
});

// spec: pull-request-landing / A same-named check from elsewhere
test('a same-named check from another workflow, event or app never matches', async t => {
  const { land } = await machine(t);
  const otherWorkflow = routes({ runs: [checkRun(101, 'test', 901)], workflows: [workflowRun(51, 901, '.github/workflows/deploy.yml')] });
  refused(await land(otherWorkflow, LAND), 'CHECKS_MISSING');
  // As on context-kit itself: the same job ran for push and for pull_request.
  const push = routes({ runs: [checkRun(101, 'test', 902)], workflows: [workflowRun(52, 902, '.github/workflows/checks.yml', 'push')] });
  refused(await land(push, LAND), 'CHECKS_MISSING');
  const app = routes({ runs: [checkRun(101, 'test', 900, 'success', { app: { slug: 'circleci-checks' } })] });
  refused(await land(app, LAND), 'CHECKS_MISSING');
  // A failing same-named check from another workflow doesn't block the one expected either.
  const mixed = routes({ runs: [checkRun(101, 'test', 900), checkRun(130, 'test', 901, 'failure')],
    workflows: [workflowRun(50, 900, '.github/workflows/checks.yml@refs/heads/main'), workflowRun(51, 901, '.github/workflows/deploy.yml')] });
  const json = landed(await land(mixed, LAND));
  assert.equal(json.checks[0].id, 101, 'the @ref suffix is dropped before matching');
});

// spec: pull-request-landing / A newer check that can't be traced
test('a newer same-named check run that cannot be joined to a workflow run refuses', async t => {
  const { land } = await machine(t);
  const result = await land(routes({ runs: [checkRun(101, 'test', 900), checkRun(140, 'test', 999, 'failure')] }), LAND);
  refused(result, 'EVIDENCE_INCOMPLETE');
  assert.match(result.error.message, /can't be traced/);
  // An older unjoined one doesn't matter.
  landed(await land(routes({ runs: [checkRun(90, 'test', 999, 'failure'), checkRun(101, 'test', 900)] }), LAND));
});

// spec: pull-request-landing / A workflow run indexed late
test('--wait polls until GitHub lists the workflow run behind a finished check, then lands', async t => {
  const { land } = await machine(t);
  const runs = `GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`;
  const workflows = `GET ${R}/actions/runs?head_sha=${A}&per_page=100`;
  const lagging = routes();
  // As on #55 and #56: the check run is done, but the head_sha listing hasn't caught up.
  lagging[runs] = [lagging[runs][0], lagging[runs][0], lagging[runs][0]];
  lagging[workflows] = [workflowPages([]), lagging[workflows][0], lagging[workflows][0]];
  const result = await land(lagging, [...LAND, '--wait', '--timeout', '0.02']);
  const json = landed(result);
  assert.deepEqual(json.checks.map(check => [check.state, check.id]), [['passed', 101]]);
  assert.equal(result.keys.filter(key => key === workflows).length, 3, 'read, polled once, then refreshed');
});

// spec: pull-request-landing / An untraced check without waiting
test('a check run no workflow run claims yet refuses CHECKS_UNTRACEABLE, never passing', async t => {
  const { land } = await machine(t);
  const untraced = routes({ workflows: [] });
  let result = await land(untraced, LAND);
  refused(result, 'CHECKS_UNTRACEABLE');
  assert.match(result.error.message, /hasn't indexed the workflow run.*--wait: test \(github-actions/);
  assert.deepEqual(result.error.details.checks.map(check => [check.state, check.untraced]), [['untraced', [101]]]);
  // The same job traced to its push run while its pull_request run isn't listed yet.
  const halfIndexed = routes({ runs: [checkRun(101, 'test', 902), checkRun(102, 'test', 903)], workflows: [workflowRun(52, 902, '.github/workflows/checks.yml', 'push')] });
  refused(await land(halfIndexed, LAND), 'CHECKS_UNTRACEABLE');
  // With --wait it never passes untraced: it times out with the same code.
  const never = routes({ workflows: [] });
  never[`GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`] = [checkPages([checkRun(101, 'test', 999)]), checkPages([checkRun(101, 'test', 999)])];
  result = await land(never, [...LAND, '--wait', '--timeout', '0.02']);
  refused(result, 'CHECKS_UNTRACEABLE');
  assert.match(result.error.message, /timed out waiting/);
  // A check with no run at all is still missing, and --wait doesn't wait for it.
  result = await land(routes({ runs: [checkRun(120, 'lint', 900)] }), [...LAND, '--wait', '--timeout', '0.02']);
  refused(result, 'CHECKS_MISSING');
  assert.equal(result.keys.filter(key => key.includes('check-runs')).length, 1, 'refused on the first read');
});

// spec: pull-request-landing / A re-run supersedes a failure
test('the latest check run decides: a re-run supersedes a failure, and the reverse', async t => {
  const { land } = await machine(t);
  const rerun = [workflowRun(50, 900, '.github/workflows/checks.yml', 'pull_request', 2)];
  const json = landed(await land(routes({ runs: [checkRun(101, 'test', 900, 'failure'), checkRun(102, 'test', 900)], workflows: rerun }), LAND));
  assert.equal(json.checks[0].id, 102);
  refused(await land(routes({ runs: [checkRun(101, 'test', 900), checkRun(102, 'test', 900, 'failure')], workflows: rerun }), LAND), 'CHECKS_FAILED');
});

// spec: pull-request-landing / A newer run outweighs an older one's attempts
test('a newer workflow run outweighs an older run\'s success on its third attempt', async t => {
  const { land } = await machine(t);
  const workflows = [workflowRun(50, 900, '.github/workflows/checks.yml', 'pull_request', 3), workflowRun(60, 910, '.github/workflows/checks.yml', 'pull_request', 1)];
  const older = [checkRun(101, 'test', 900, 'failure'), checkRun(102, 'test', 900, 'failure'), checkRun(103, 'test', 900)];
  refused(await land(routes({ runs: [...older, checkRun(110, 'test', 910, 'failure')], workflows }), LAND), 'CHECKS_FAILED');
  refused(await land(routes({ runs: [...older, checkRun(110, 'test', 910, null)], workflows }), LAND), 'CHECKS_PENDING');
});

// spec: pull-request-landing / A skipped check
test('a skipped check passes only where the policy gives a reason', async t => {
  const { land } = await machine(t);
  const preview = { name: 'preview', app: 'github-actions', workflow: '.github/workflows/checks.yml', event: 'pull_request', skippable: 'previews deploy only when the branch has changes' };
  const runs = [checkRun(101, 'test', 900), checkRun(105, 'preview', 900, 'skipped')];
  const json = landed(await land(routes({ policy: { ...POLICY, expectedChecks: [TEST, preview] }, runs }), LAND));
  assert.deepEqual(json.checks.map(check => [check.state, check.reason]), [['passed', undefined], ['skipped', 'previews deploy only when the branch has changes']]);
  const { skippable, ...strict } = preview;
  const result = await land(routes({ policy: { ...POLICY, expectedChecks: [TEST, strict] }, runs }), LAND);
  refused(result, 'CHECKS_FAILED');
  assert.match(result.error.message, /no skip reason/);
});

test('commit statuses match by context and creator', async t => {
  const { land } = await machine(t);
  const policy = { ...POLICY, expectedChecks: [{ kind: 'status', context: 'ci/legacy', creator: 'legacy-bot' }] };
  const status = (state, login = 'legacy-bot') => ({ pages: [{ state, total_count: 1, statuses: [{ id: 9, context: 'ci/legacy', state, created_at: '2026-10-19T10:00:00Z', creator: { login }, target_url: 'https://ci.example/9' }] }] });
  const ok = routes({ policy });
  ok[`GET ${R}/commits/${A}/status?per_page=100`] = [status('success'), status('success')];
  assert.equal(landed(await land(ok, LAND)).checks[0].state, 'passed');
  const impostor = routes({ policy });
  impostor[`GET ${R}/commits/${A}/status?per_page=100`] = [status('success', 'someone')];
  refused(await land(impostor, LAND), 'CHECKS_MISSING');
  const failed = routes({ policy });
  failed[`GET ${R}/commits/${A}/status?per_page=100`] = [status('error')];
  refused(await land(failed, LAND), 'CHECKS_FAILED');
});

// spec: pull-request-landing / Waiting for checks
test('--wait lands when a pending check succeeds in time, and times out otherwise', async t => {
  const { land } = await machine(t);
  const key = `GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`;
  const workflows = `GET ${R}/actions/runs?head_sha=${A}&per_page=100`;
  const pending = checkPages([checkRun(101, 'test', 900, null)]);
  const done = checkPages([checkRun(101, 'test', 900)]);
  const timely = routes();
  timely[key] = [pending, done, done];
  timely[workflows] = [...timely[workflows], timely[workflows][0]];
  const json = landed(await land(timely, [...LAND, '--wait', '--timeout', '0.02']));
  assert.equal(json.checks[0].state, 'passed');
  const late = routes();
  late[key] = [pending, pending];
  const result = await land(late, [...LAND, '--wait', '--timeout', '0.02']);
  refused(result, 'CHECKS_PENDING');
  assert.match(result.error.message, /timed out/);
  refused(await land(routes({ runs: [checkRun(101, 'test', 900, null)] }), LAND), 'CHECKS_PENDING');
});

// spec: pull-request-landing / No checks expected
test('with no checks expected, landing needs a posted --no-checks reason', async t => {
  const { land } = await machine(t);
  const none = { expectedChecks: [], routine: POLICY.routine };
  refused(await land(routes({ policy: none }), LAND), 'CHECKS_NONE_EXPECTED');
  const posting = routes({ policy: none });
  posting[`POST ${R}/issues/7/comments`] = [{ body: { id: 77, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' } }];
  const result = await land(posting, [...LAND, '--no-checks', 'validated by hand, see https://example.com/log']);
  const json = landed(result);
  const posted = result.calls.find(call => call.key === `POST ${R}/issues/7/comments`);
  assert.equal(posted.body.body, `<!-- context-kit:no-checks --> No checks expected for ${A}: validated by hand, see https://example.com/log`);
  assert.ok(result.keys.indexOf(posted.key) < result.keys.indexOf(`PUT ${R}/pulls/7/merge`));
  assert.deepEqual(json.checks, { none: true, reason: 'validated by hand, see https://example.com/log', url: 'https://github.com/acme/widgets/pull/7#issuecomment-77' });
  assert.ok(!result.keys.some(key => key.includes('check-runs')));
  // With checks expected, --no-checks is refused.
  const refusedNoChecks = await land(routes(), [...LAND, '--no-checks', 'nope']);
  refused(refusedNoChecks, 'INVALID_INPUT');
});

// spec: pull-request-landing / Source changes are substantial
test('source changes are substantial even labelled routine, and the refusal names the files', async t => {
  const { land } = await machine(t);
  const result = await land(routes({ files: [file('lib/landing.mjs'), file('docs/guide.md')], pr: { labels: [{ name: 'routine' }] } }), LAND);
  refused(result, 'REVIEW_MISSING');
  assert.match(result.error.message, /substantial \(lib\/landing\.mjs\)/);
  assert.deepEqual(result.error.details.substantial.files, [{ file: 'lib/landing.mjs', reason: 'outside the routine exemption' }]);
});

test('workflow files, the policy, OpenSpec deltas, renames and the substantial label are substantial', async t => {
  const { land } = await machine(t);
  const cases = [
    [[file('.github/workflows/checks.yml')], {}, '.github/workflows/checks.yml'],
    [[file('.context-kit/landing.json')], {}, '.context-kit/landing.json'],
    [[file('openspec/changes/pr-land/specs/pull-request-landing/spec.md')], {}, 'openspec/changes/pr-land/specs/pull-request-landing/spec.md'],
    [[file('openspec/changes/pr-land/tasks.md')], {}, 'openspec/changes/pr-land/tasks.md'],
    [[file('docs/new.md', 'renamed', 'lib/old.mjs')], {}, 'lib/old.mjs'],
    [[file('lib/gone.mjs', 'removed')], {}, 'lib/gone.mjs'],
    [[file('docs/guide.md')], { labels: [{ name: 'substantial' }] }, 'label substantial'],
  ];
  for (const [files, pr, named] of cases) {
    const result = await land(routes({ files, pr }), LAND);
    refused(result, 'REVIEW_MISSING');
    assert.ok(result.error.message.includes(named), `${named}: ${result.error.message}`);
  }
});

// spec: pull-request-landing / A docs-only change is routine
test('a change only to exempt paths is routine and names the exemption', async t => {
  const { land } = await machine(t);
  const json = landed(await land(routes({ files: [file('docs/a.md'), file('README.md'), file('docs/b.md', 'renamed', 'docs/old.md')] }), LAND));
  assert.deepEqual(json.substantial, { value: false, exemption: { paths: ['docs/**', 'README.md'], excludePaths: ['openspec/**'] } });
  assert.equal(json.review.status, 'not_required');
});

// spec: pull-request-landing / A docs-only change is routine
test('exempt and excluded globs match file names holding a newline', async t => {
  const { land } = await machine(t);
  const json = landed(await land(routes({ files: [file('docs/odd\nname.md')] }), LAND));
  assert.equal(json.substantial.value, false);
  const result = await land(routes({ files: [file('openspec/odd\nname.md')] }), LAND);
  refused(result, 'REVIEW_MISSING');
  assert.deepEqual(result.error.details.substantial.files, [{ file: 'openspec/odd\nname.md', reason: 'excluded from the routine exemption' }]);
});

// spec: pull-request-landing / A docs-only change is routine
test('a ? in an exempt glob matches one whole character, astral ones included', async t => {
  const { land } = await machine(t);
  const policy = { ...POLICY, routine: { paths: ['docs/?.md'], excludePaths: [] } };
  for (const name of ['docs/a.md', 'docs/😀.md', 'docs/𝔬.md']) assert.equal(landed(await land(routes({ policy, files: [file(name)] }), LAND)).substantial.value, false, name);
  refused(await land(routes({ policy, files: [file('docs/ab.md')] }), LAND), 'REVIEW_MISSING');
});

// spec: pull-request-landing / Stale, planning and malformed records
test('stale, plan-phase and malformed records are reported and do not count', async t => {
  const { land } = await machine(t);
  const comments = [comment(1, record({ 'Reviewed-SHA': OLD })), comment(2, record({ Phase: 'plan' })), comment(3, record({ Evidence: null }))];
  const result = await land(routes({ files: [file('lib/x.mjs')], comments }), LAND);
  refused(result, 'REVIEW_MISSING');
  assert.deepEqual(result.error.details.records.map(item => [item.status, item.url.split('-').pop()]), [['stale', '1'], ['not_applicable', '2'], ['malformed', '3']]);
  assert.match(result.error.details.records[2].reason, /missing Evidence/);
});

// spec: pull-request-landing / A later record supersedes an approval
test('the newest record for the head decides', async t => {
  const { land } = await machine(t);
  const approval = comment(1, record());
  const changes = comment(2, record({ Outcome: 'changes-requested', Reviewer: 'second look' }));
  refused(await land(routes({ files: [file('lib/x.mjs')], comments: [approval, changes] }), LAND), 'REVIEW_MISSING');
  // A later approval, here a review body, merges citing that record.
  const review = { id: 5, body: record({ Outcome: 'approved-with-deferrals', Reviewer: 'third look' }), submitted_at: '2026-10-19T11:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-5', user: { login: 'faye' }, state: 'COMMENTED' };
  const json = landed(await land(routes({ files: [file('lib/x.mjs')], comments: [approval, changes], reviews: [review] }), LAND));
  assert.equal(json.review.status, 'approved');
  assert.equal(json.review.record.url, 'https://github.com/acme/widgets/pull/7#pullrequestreview-5');
  assert.equal(json.review.record.reviewer, 'third look');
  assert.deepEqual(json.review.others.map(item => [item.status, item.outcome]), [['superseded', 'approved'], ['superseded', 'changes-requested']]);
});

// spec: pull-request-landing / An explicit skip
test('--skip-review posts the skip before the merge and reports it', async t => {
  const { land } = await machine(t);
  const skipping = routes({ files: [file('lib/x.mjs')] });
  skipping[`POST ${R}/issues/7/comments`] = [{ body: { id: 88, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-88' } }];
  const result = await land(skipping, [...LAND, '--skip-review', 'one-line typo fix in an error message']);
  const json = landed(result);
  const posted = result.calls.find(call => call.key === `POST ${R}/issues/7/comments`);
  assert.equal(posted.body.body, `<!-- context-kit:review-skipped --> Review skipped for ${A}: one-line typo fix in an error message`);
  assert.ok(result.keys.indexOf(posted.key) < result.keys.indexOf(`PUT ${R}/pulls/7/merge`));
  assert.deepEqual([json.review.status, json.review.reason, json.review.url], ['skipped', 'one-line typo fix in an error message', 'https://github.com/acme/widgets/pull/7#issuecomment-88']);
  // A failed post merges nothing.
  const unposted = routes({ files: [file('lib/x.mjs')] });
  unposted[`POST ${R}/issues/7/comments`] = [{ status: 403, message: 'Resource not accessible by integration' }];
  refused(await land(unposted, [...LAND, '--skip-review', 'typo']), 'POST_FAILED');
});

// spec: pull-request-landing / A branch that can't be deleted
test('a shared, forked or moved head branch is kept and the cleanup is incomplete', async t => {
  const { land } = await machine(t);
  const shared = routes();
  shared[`GET ${R}/pulls?state=open&head=acme%3Afeature&per_page=100`] = [{ pages: [[{ number: 9, head: { ref: 'feature' } }]] }];
  const noDelete = result => { assert.ok(!result.keys.some(key => key.startsWith('DELETE')), 'no DELETE call'); return landed(result); };
  let json = noDelete(await land(shared, LAND));
  assert.equal(json.status, 'merged_cleanup_incomplete');
  assert.match(json.branch.kept, /#9/);

  const fork = routes({ pr: { head: { ref: 'feature', sha: A, repo: { full_name: 'someone/widgets' } } } });
  delete fork[`GET ${R}/pulls?state=open&base=feature&per_page=100`];
  json = noDelete(await land(fork, LAND));
  assert.equal(json.status, 'merged_cleanup_incomplete');
  assert.match(json.branch.kept, /someone\/widgets/);

  const moved = routes();
  moved[`GET ${R}/git/ref/heads/feature`] = [{ body: ref('feature', B) }];
  json = noDelete(await land(moved, LAND));
  assert.equal(json.status, 'merged_cleanup_incomplete');
  assert.match(json.branch.kept, /moved/);

  // A push between the first read and the delete: the re-read just before it keeps the branch.
  const late = routes();
  late[`GET ${R}/git/ref/heads/feature`] = [{ body: ref('feature', A) }, { body: ref('feature', B) }];
  json = noDelete(await land(late, LAND));
  assert.equal(json.status, 'merged_cleanup_incomplete');
  assert.match(json.branch.kept, new RegExp(`moved to ${B}`));

  // A default branch that isn't shown to contain the merge keeps the branch.
  for (const status of ['diverged', 'ahead']) {
    const unconfirmed = routes();
    unconfirmed[`GET ${R}/compare/main...${M}`] = [{ body: { status } }];
    json = noDelete(await land(unconfirmed, LAND));
    assert.equal(json.status, 'merged_cleanup_incomplete');
    assert.match(json.branch.kept, /isn't confirmed to contain the merge/);
    assert.match(json.warnings[0], new RegExp(status));
  }

  // A refused delete is "already deleted" only when the ref is confirmed gone.
  const refusedDelete = routes();
  refusedDelete[`DELETE ${R}/git/refs/heads/feature`] = [{ status: 422, message: 'Reference update failed' }];
  refusedDelete[`GET ${R}/git/ref/heads/feature`] = [{ body: ref('feature', A) }, { body: ref('feature', A) }, { body: ref('feature', A) }];
  json = landed(await land(refusedDelete, LAND));
  assert.equal(json.status, 'merged_cleanup_incomplete');
  assert.match(json.branch.kept, /delete failed/);
  assert.equal(json.branch.alreadyDeleted, undefined);
  refusedDelete[`GET ${R}/git/ref/heads/feature`] = [{ body: ref('feature', A) }, { body: ref('feature', A) }, notFound];
  json = landed(await land(refusedDelete, LAND));
  assert.equal(json.status, 'merged');
  assert.deepEqual(json.branch, { ref: 'feature', deleted: false, alreadyDeleted: true });
  // Only a 404 establishes absence: a malformed answer after a refused delete keeps it.
  refusedDelete[`GET ${R}/git/ref/heads/feature`] = [{ body: ref('feature', A) }, { body: ref('feature', A) }, { body: {} }];
  json = landed(await land(refusedDelete, LAND));
  assert.equal(json.status, 'merged_cleanup_incomplete');
  assert.match(json.branch.kept, /Unexpected response/);
  // So does a malformed first read, with no delete.
  const malformedRef = routes();
  malformedRef[`GET ${R}/git/ref/heads/feature`] = [{ body: {} }];
  json = noDelete(await land(malformedRef, LAND));
  assert.equal(json.status, 'merged_cleanup_incomplete');
  assert.equal(json.branch.alreadyDeleted, undefined);

  // Already deleted (repository auto-deletion) is noted, and the landing is complete.
  const gone = routes();
  gone[`GET ${R}/git/ref/heads/feature`] = [notFound];
  json = landed(await land(gone, LAND));
  assert.equal(json.status, 'merged');
  assert.deepEqual(json.branch, { ref: 'feature', deleted: false, alreadyDeleted: true });
});

// spec: pull-request-landing / Dependent pull requests
test('dependents are snapshotted before the merge and reported with their new base', async t => {
  const { land } = await machine(t);
  const fixtures = routes();
  fixtures[`GET ${R}/pulls?state=open&base=feature&per_page=100`] = [{ pages: [[{ number: 8, base: { ref: 'feature' } }]] }];
  fixtures[`GET ${R}/pulls/8`] = [{ body: pull({ number: 8, base: { ref: 'main', sha: TIP, repo: { full_name: 'acme/widgets' } } }) }];
  const result = await land(fixtures, LAND);
  const json = landed(result);
  assert.deepEqual(json.dependents, [{ number: 8, oldBase: 'feature', newBase: 'main', state: 'open', needsRevalidation: true }]);
  assert.ok(result.keys.indexOf(`GET ${R}/pulls?state=open&base=feature&per_page=100`) < result.keys.indexOf(`PUT ${R}/pulls/7/merge`));
});

// spec: pull-request-landing / A lost merge response
test('a lost merge response counts only if merged at the requested head, and is never retried', async t => {
  const { land } = await machine(t);
  const lost = after => {
    const fixtures = routes();
    fixtures[`PUT ${R}/pulls/7/merge`] = [{ drop: true }];
    fixtures[`GET ${R}/pulls/7`] = [...fixtures[`GET ${R}/pulls/7`], { body: after }];
    return fixtures;
  };
  const json = landed(await land(lost(pull({ state: 'closed', merged: true, merge_commit_sha: M })), LAND));
  assert.deepEqual(json.merge, { sha: M, method: 'squash', reconciled: true });
  assert.equal(json.status, 'merged');

  const notMerged = await land(lost(pull()), LAND);
  assert.equal(notMerged.error.code, 'MERGE_UNKNOWN');
  assert.match(notMerged.error.message, /A merge call was made.*not retried/);
  assert.deepEqual(notMerged.error.details.seen, { state: 'open', merged: false, head: A, mergeCommit: null });

  const elsewhere = await land(lost(pull({ state: 'closed', merged: true, merge_commit_sha: M, head: { ref: 'feature', sha: B, repo: { full_name: 'acme/widgets' } } })), LAND);
  assert.equal(elsewhere.error.code, 'MERGE_UNKNOWN');
  assert.equal(elsewhere.error.details.seen.head, B);
  for (const result of [notMerged, elsewhere]) assert.equal(result.calls.filter(call => call.method === 'PUT').length, 1);
});

// Every response the command relies on is parsed by one schema per endpoint: from a valid
// fixture, each required field in turn is removed, given the wrong type, emptied or made
// negative, and each refuses EVIDENCE_INCOMPLETE with no merge call.
const clone = value => JSON.parse(JSON.stringify(value));
const VARIANTS = {
  string: [['missing'], ['type', 42], ['empty', '']],
  number: [['missing'], ['type', '7'], ['negative', -1]],
  boolean: [['missing'], ['type', 'true']],
  array: [['missing'], ['type', {}]],
  object: [['missing'], ['type', 'x']],
  null: [['missing'], ['type', 42]],
};
const kindOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function corrupted(fixtures, key, at, field, kinds) {
  const path = [...at, ...field.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part)];
  const valid = path.reduce((value, part) => value?.[part], fixtures[key][0]);
  assert.notEqual(valid, undefined, `${key} ${field} exists in the valid fixture`);
  return VARIANTS[kindOf(valid)].filter(([kind]) => !kinds || kinds.includes(kind)).map(([kind, value]) => {
    const copy = clone(fixtures);
    const parent = path.slice(0, -1).reduce((item, part) => item[part], copy[key][0]);
    if (kind === 'missing') delete parent[path.at(-1)]; else parent[path.at(-1)] = value;
    return { label: `${key.split('?')[0]} ${field} ${kind}`, fixtures: copy };
  });
}
async function pool(items, size, run) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await run(queue.shift()); }));
}

test('every GitHub response is parsed strictly: a corrupted field refuses with no merge call', async t => {
  const statusPolicy = { ...POLICY, expectedChecks: [TEST, { kind: 'status', context: 'ci/legacy' }] };
  const statusPage = { pages: [{ state: 'success', total_count: 1, statuses: [{ id: 9, context: 'ci/legacy', state: 'success', created_at: '2026-10-19T10:00:00Z' }] }] };
  const withStatus = routes({ policy: statusPolicy });
  withStatus[`GET ${R}/commits/${A}/status?per_page=100`] = [statusPage, statusPage];
  const withDependent = routes();
  withDependent[`GET ${R}/pulls?state=open&base=feature&per_page=100`] = [{ pages: [[{ number: 8, base: { ref: 'feature' } }]] }];
  const withRule = routes();
  withRule[`GET ${R}/rules/branches/main?per_page=100`] = [{ pages: [[{ type: 'deletion' }]] }, { pages: [[{ type: 'deletion' }]] }];
  const review = { id: 5, body: record(), submitted_at: '2026-10-19T11:00:00Z', html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-5', user: { login: 'faye' } };
  const table = [
    [routes(), `GET ${R}`, ['body'], ['default_branch', 'allow_squash_merge', 'allow_rebase_merge', 'allow_merge_commit']],
    [routes(), `GET ${R}/git/ref/heads/main`, ['body'], ['object', 'object.sha']],
    [routes(), `GET ${R}/contents/.context-kit/landing.json?ref=${TIP}`, ['body'], ['type', 'encoding', ['content', ['missing', 'type']]]],
    [routes({ pr: { labels: [{ name: 'docs' }] } }), `GET ${R}/pulls/7`, ['body'], ['number', 'state', 'merged', 'draft', 'mergeable', 'mergeable_state',
      'merge_commit_sha', 'changed_files', 'labels', 'labels.0.name', 'title', 'body', 'user', 'user.login', 'base', 'base.ref', 'base.sha', 'head', 'head.ref', 'head.sha', 'head.repo', 'head.repo.full_name']],
    [withRule, `GET ${R}/rules/branches/main?per_page=100`, ['pages', 0, 0], ['type']],
    [routes(), 'POST graphql', ['body'], ['data', 'data.repository', 'data.repository.mergeQueue']],
    [routes(), FILES, ['body'], ['status', 'merge_base_commit', 'merge_base_commit.sha', 'total_commits', 'commits', 'files']],
    [routes(), FILES, ['body', 'commits', 0], ['sha', 'commit', ['commit.message', ['missing', 'type']], 'commit.author', ['commit.author.email', ['missing', 'type']]]],
    [routes({ files: [file('docs/new.md', 'renamed', 'docs/old.md')] }), FILES, ['body', 'files', 0], ['filename', 'status', 'previous_filename']],
    [routes(), `GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`, ['pages', 0], ['total_count', 'check_runs']],
    [routes(), `GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`, ['pages', 0, 'check_runs', 0],
      ['id', 'name', 'status', 'conclusion', 'app', 'app.slug', 'check_suite', 'check_suite.id']],
    [routes(), `GET ${R}/actions/runs?head_sha=${A}&per_page=100`, ['pages', 0], ['total_count', 'workflow_runs']],
    [routes(), `GET ${R}/actions/runs?head_sha=${A}&per_page=100`, ['pages', 0, 'workflow_runs', 0], ['id', 'check_suite_id', 'path', 'event', 'run_attempt']],
    [withStatus, `GET ${R}/commits/${A}/status?per_page=100`, ['pages', 0], ['total_count', 'statuses']],
    [withStatus, `GET ${R}/commits/${A}/status?per_page=100`, ['pages', 0, 'statuses', 0], ['id', 'context', 'state', 'created_at']],
    [routes({ comments: [comment(1, record())] }), `GET ${R}/issues/7/comments?per_page=100`, ['pages', 0, 0], ['id', ['body', ['missing', 'type']], 'created_at']],
    [routes({ reviews: [review] }), `GET ${R}/pulls/7/reviews?per_page=100`, ['pages', 0, 0], ['id', ['body', ['missing', 'type']], 'submitted_at']],
    [withDependent, `GET ${R}/pulls?state=open&base=feature&per_page=100`, ['pages', 0, 0], ['number', 'base', 'base.ref']],
  ];
  const cases = table.flatMap(([fixtures, key, at, fields]) => fields.flatMap(field =>
    Array.isArray(field) ? corrupted(fixtures, key, at, field[0], field[1]) : corrupted(fixtures, key, at, field)));

  // The review's five cases, explicitly.
  const undated = routes({ files: [file('lib/x.mjs')] });
  const approval = comment(1, record());
  delete approval.created_at;
  const undatedPage = { pages: [[approval, comment(2, record({ Outcome: 'changes-requested' }))]] };
  undated[`GET ${R}/issues/7/comments?per_page=100`] = [undatedPage, undatedPage];
  cases.push({ label: 'an approval without created_at beside a later changes-requested', fixtures: undated });
  const statusless = routes({ files: [{ filename: 'docs/new.md' }] });
  cases.push({ label: 'a file without a status', fixtures: statusless });
  const unlabelled = routes({ files: [file('docs/a.md')] });
  const { labels, ...noLabels } = pull({ changed_files: 1 });
  unlabelled[`GET ${R}/pulls/7`] = [{ body: noLabels }, { body: noLabels }];
  cases.push({ label: 'a pull request without labels', fixtures: unlabelled });
  const uncounted = routes();
  const uncountedPage = { pages: [{ check_runs: [checkRun(101, 'test', 900)] }] };
  uncounted[`GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`] = [uncountedPage, uncountedPage];
  cases.push({ label: 'check runs without total_count', fixtures: uncounted });
  cases.push({ label: 'a failed check run with id -1', fixtures: routes({ runs: [checkRun(101, 'test', 900), checkRun(-1, 'test', 900, 'failure')] }) });
  const errorsObject = routes();
  errorsObject['POST graphql'] = [{ body: { data: { repository: { mergeQueue: null } }, errors: { message: 'Something went wrong' } } }];
  cases.push({ label: 'GraphQL errors that are not an array', fixtures: errorsObject });
  // Duplicates and conflicts: a second copy never satisfies a count or hides another answer.
  const doubled = routes({ files: [file('docs/a.md'), file('docs/a.md')] });
  cases.push({ label: 'the same file listed twice', fixtures: doubled });
  cases.push({ label: 'one check run id, success then failure', fixtures: routes({ runs: [checkRun(101, 'test', 900), checkRun(101, 'test', 900, 'failure')] }) });
  const twoStatuses = routes({ policy: statusPolicy });
  const dupStatus = { pages: [{ state: 'failure', total_count: 2, statuses: [statusPage.pages[0].statuses[0], { ...statusPage.pages[0].statuses[0], state: 'failure' }] }] };
  twoStatuses[`GET ${R}/commits/${A}/status?per_page=100`] = [dupStatus, dupStatus];
  cases.push({ label: 'one status id twice', fixtures: twoStatuses });
  cases.push({ label: 'one comment id twice', fixtures: routes({ files: [file('lib/x.mjs')], comments: [comment(1, record()), comment(1, record({ Outcome: 'changes-requested' }))] }) });
  cases.push({ label: 'one review id twice', fixtures: routes({ files: [file('lib/x.mjs')], reviews: [review, { ...review, body: record({ Outcome: 'changes-requested' }) }] }) });
  // One workflow run id under two suites with different workflows would hide the newer failure.
  cases.push({ label: 'one workflow run id under two check suites', fixtures: routes({ runs: [checkRun(101, 'test', 900), checkRun(140, 'test', 901, 'failure')],
    workflows: [workflowRun(50, 900, '.github/workflows/checks.yml'), workflowRun(50, 901, '.github/workflows/deploy.yml')] }) });
  // A later claim for the failing run's suite would otherwise relabel it and hide the failure.
  cases.push({ label: 'two workflow runs claiming one check suite', fixtures: routes({ runs: [checkRun(101, 'test', 900), checkRun(140, 'test', 901, 'failure')],
    workflows: [workflowRun(50, 900, '.github/workflows/checks.yml'), workflowRun(60, 901, '.github/workflows/checks.yml'), workflowRun(61, 901, '.github/workflows/deploy.yml')] }) });
  cases.push({ label: 'two workflow runs claiming one check suite with different events', fixtures: routes({
    workflows: [workflowRun(50, 900, '.github/workflows/checks.yml'), workflowRun(51, 900, '.github/workflows/checks.yml', 'push')] }) });
  // Falsy elements and empty identity fields too.
  for (const junk of [false, 0, '', null]) {
    cases.push({ label: `a file listing holding ${JSON.stringify(junk)}`, fixtures: routes({ files: [file('docs/a.md'), junk] }) });
    cases.push({ label: `a check-run listing holding ${JSON.stringify(junk)}`, fixtures: routes({ runs: [checkRun(101, 'test', 900), junk] }) });
  }

  assert.ok(cases.length > 120, `${cases.length} cases`);
  await pool(cases, 6, async ({ label, fixtures }) => {
    const { land } = await machine(t);
    const result = await land(fixtures, LAND);
    assert.equal(result.error?.code, 'EVIDENCE_INCOMPLETE', `${label}: ${JSON.stringify(result.error ?? result.json?.status)}`);
    assert.equal(result.merged, false, `${label}: no merge call`);
  });

  // After the merge nothing can be refused, so a malformed answer keeps the branch.
  const { land } = await machine(t);
  const unconfirmed = routes();
  unconfirmed[`GET ${R}/compare/main...${M}`] = [{ body: { status: 'bogus' } }];
  const result = await land(unconfirmed, LAND);
  assert.equal(landed(result).status, 'merged_cleanup_incomplete');
  assert.ok(!result.keys.some(key => key.startsWith('DELETE')));
});

// spec: pull-request-landing / A required merge queue
test('a merge queue from classic branch protection refuses, and an unreadable answer fails closed', async t => {
  const { land } = await machine(t);
  const classic = routes();
  classic['POST graphql'] = [{ body: { data: { repository: { mergeQueue: { id: 'MQ_kwDOAbCd' } } } } }];
  const result = await land(classic, LAND);
  refused(result, 'MERGE_QUEUE_UNSUPPORTED');
  assert.match(result.error.message, /has a merge queue/);
  // Any GraphQL error fails closed, whatever it says; so does an answer carrying errors.
  const unavailable = routes();
  unavailable['POST graphql'] = [{ status: 200, message: 'Merge queue is not available for this repository',
    body: { data: { repository: { mergeQueue: null } }, errors: [{ type: 'FORBIDDEN', message: 'Merge queue is not available for this repository' }] } }];
  refused(await land(unavailable, LAND), 'EVIDENCE_INCOMPLETE');
  const withErrors = routes();
  withErrors['POST graphql'] = [{ body: { data: { repository: { mergeQueue: null } }, errors: [{ message: 'Something partial' }] } }];
  refused(await land(withErrors, LAND), 'EVIDENCE_INCOMPLETE');
  const failing = routes();
  failing['POST graphql'] = [{ status: 502, message: 'Bad Gateway' }];
  refused(await land(failing, LAND), 'EVIDENCE_INCOMPLETE');
  const odd = routes();
  odd['POST graphql'] = [{ body: { data: {} } }];
  refused(await land(odd, LAND), 'EVIDENCE_INCOMPLETE');
});

// spec: pull-request-landing / A later record supersedes an approval
test('the refresh re-reads review records and labels, and refuses on what arrived', async t => {
  const { land } = await machine(t);
  // A changes-requested record posted while --wait was polling.
  const key = `GET ${R}/commits/${A}/check-runs?filter=all&per_page=100`;
  const workflows = `GET ${R}/actions/runs?head_sha=${A}&per_page=100`;
  const waiting = routes({ files: [file('lib/x.mjs')], comments: [comment(1, record())] });
  waiting[key] = [checkPages([checkRun(101, 'test', 900, null)]), checkPages([checkRun(101, 'test', 900)]), checkPages([checkRun(101, 'test', 900)])];
  waiting[workflows] = [...waiting[workflows], waiting[workflows][0]];
  waiting[`GET ${R}/issues/7/comments?per_page=100`] = [{ pages: [[comment(1, record())]] },
    { pages: [[comment(1, record()), comment(2, record({ Outcome: 'changes-requested', Reviewer: 'second look' }))]] }];
  let result = await land(waiting, [...LAND, '--wait', '--timeout', '0.02']);
  refused(result, 'REVIEW_MISSING');
  assert.match(result.error.message, /requests changes/);
  // A substantial label added to a routine change before the refresh.
  const labelled = routes();
  labelled[`GET ${R}/pulls/7`] = [{ body: pull() }, { body: pull({ labels: [{ name: 'substantial' }] }) }];
  result = await land(labelled, LAND);
  refused(result, 'REVIEW_MISSING');
  assert.match(result.error.message, /label substantial/);
  // With --skip-review given, a change that became substantial posts its skip before the merge.
  labelled[`POST ${R}/issues/7/comments`] = [{ body: { id: 89, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-89' } }];
  result = await land(labelled, [...LAND, '--skip-review', 'label added late; reviewed by hand']);
  const json = landed(result);
  assert.deepEqual([json.review.status, json.review.url], ['skipped', 'https://github.com/acme/widgets/pull/7#issuecomment-89']);
  assert.ok(result.keys.indexOf(`POST ${R}/issues/7/comments`) < result.keys.indexOf(`PUT ${R}/pulls/7/merge`));
});

test('an unknown mergeability is re-read twice, then refuses', async t => {
  const { land } = await machine(t);
  const unknown = { mergeable: null, mergeable_state: 'unknown' };
  const pending = routes();
  pending[`GET ${R}/pulls/7`] = [{ body: pull(unknown) }, { body: pull(unknown) }, { body: pull(unknown) }];
  let result = await land(pending, LAND);
  refused(result, 'EVIDENCE_INCOMPLETE');
  assert.match(result.error.message, /not computed whether #7 can merge/);
  assert.equal(result.keys.filter(key => key === `GET ${R}/pulls/7`).length, 3);
  const resolved = routes();
  resolved[`GET ${R}/pulls/7`] = [{ body: pull(unknown) }, { body: pull(unknown) }, { body: pull() }, { body: pull() }];
  result = await land(resolved, LAND);
  landed(result);
  assert.equal(result.keys.filter(key => key === `GET ${R}/pulls/7`).length, 4);
});

// spec: pull-request-landing / Movement before the merge
test('the refresh re-reads the default branch and the merge settings', async t => {
  const { land } = await machine(t);
  const renamed = routes();
  renamed[`GET ${R}`] = [{ body: repository() }, { body: repository({ default_branch: 'trunk' }) }];
  let result = await land(renamed, LAND);
  refused(result, 'BASE_MOVED');
  assert.match(result.error.message, /default branch changed from main to trunk/);
  const settings = routes();
  settings[`GET ${R}`] = [{ body: repository() }, { body: repository({ allow_squash_merge: false, allow_merge_commit: true }) }];
  result = await land(settings, LAND);
  refused(result, 'INVALID_INPUT');
  assert.match(result.error.message, /no longer allows squash merges \(now merge\)/);
});

// spec: pull-request-landing / Wrong head, base or file list
test('the changed files come from the compare pinned to the head SHA, never the mutable listing', async t => {
  const { land } = await machine(t);
  const result = await land(routes({ files: [file('docs/a.md')] }), LAND);
  landed(result);
  assert.ok(result.keys.includes(FILES), 'the compare of base...head is read');
  assert.ok(!result.keys.some(key => key.includes('/pulls/7/files')), 'the pull request\'s file listing is not');
  // A compare listing other files than the pull request's count refuses.
  const more = routes({ files: [file('docs/a.md')] });
  more[FILES] = [{ body: diff([file('docs/a.md'), file('lib/x.mjs')]) }];
  refused(await land(more, LAND), 'EVIDENCE_INCOMPLETE');
});

test('pr land is never offered over MCP, even with writes on', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-landing-mcp-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config') };
  delete env.CONTEXT_KIT_ROOT;
  const workspace = join(base, 'workspace');
  await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'init', workspace], { env });
  const client = new Client({ name: 'landing-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', workspace, '--allow-write'], env, stderr: 'pipe' }));
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('capture_note'), 'writes are on');
  assert.ok(!names.includes('land_pull_request'));
  const call = await client.callTool({ name: 'land_pull_request', arguments: { number: 7, sha: A } });
  assert.equal(call.isError, true);
  assert.equal(JSON.parse(call.content[0].text).error.code, 'UNKNOWN_OPERATION');
});

// A squash keeps only the message it is given. The pull request's slice trailers go into it, so
// the default branch carries its own landing evidence without gh.
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const trailered = (commits, body = null, files = [file('docs/guide.md')]) => {
  const fixtures = routes({ pr: { body }, files });
  fixtures[FILES] = [{ body: diff(files, commits) }];
  return fixtures;
};
// A repository with change `deliver` planned as slices `storage` then `api`, and only git on PATH.
async function slicedRepository(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-squash-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink((await exec('sh', ['-c', 'command -v git'])).stdout.trim(), join(bin, 'git'));
  const env = { PATH: bin, HOME: base, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'), GIT_CONFIG_NOSYSTEM: '1',
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  const put = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  const requirement = name => `### Requirement: ${name}\nThe service SHALL support ${name.toLowerCase()}.\n\n#### Scenario: Use ${name}\n- **WHEN** a caller uses ${name.toLowerCase()}\n- **THEN** it works\n`;
  await put('openspec/config.yaml', 'schema: spec-driven\n');
  await put('openspec/specs/locations/spec.md', `# Locations\n\n## Purpose\nFind locations by text for callers of the location service.\n\n## Requirements\n\n${requirement('Search')}`);
  await put('openspec/changes/deliver/proposal.md', '# Why\n\nDeliver radius search.\n');
  await put('openspec/changes/deliver/specs/locations/spec.md', `## ADDED Requirements\n${requirement('Radius')}\n${requirement('Ordering')}`);
  await put('openspec/changes/deliver/slices.yaml', 'slices:\n  - id: storage\n    implements: [locations / Radius]\n  - id: api\n    implements: [locations / Ordering]\n    depends_on: [storage]\n');
  const git = (args, input) => new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    if (input !== undefined) child.stdin.end(input);
  });
  await git(['init', '-q', '-b', 'main']);
  await git(['add', '.']);
  await git(['commit', '-qm', 'Propose deliver']);
  const status = async () => JSON.parse((await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, 'specs', 'status', 'deliver'], { env })).stdout);
  return { root, put, git, status };
}

// spec: pull-request-landing / Slice trailers survive a squash
test('a squash merge writes the pull request slice trailers into its message, and the landing reads without gh', async t => {
  const { land } = await machine(t);
  const commits = [
    commitEntry(C1, 'Add storage\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage\n'),
    commitEntry(C2, 'Test storage\n\nCovers the radius.\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage\n\nCo-authored-by: Claude <noreply@anthropic.com>\n'),
    commitEntry(A, 'Tidy the guide', { name: 'Kit', email: 'kit@example.com', login: 'kit' }),
  ];
  const result = await land(trailered(commits, 'Adds storage.\r\n\r\nOpenSpec-Change: deliver\r\nOpenSpec-Slice: storage\r\n'), LAND);
  const json = landed(result);
  const merge = result.calls.find(call => call.method === 'PUT').body;
  assert.equal(merge.sha, A, 'still pinned to the head');
  assert.equal(merge.merge_method, 'squash');
  assert.equal(merge.commit_title, 'Widget guide (#7)');
  const trailers = 'OpenSpec-Change: deliver\nOpenSpec-Slice: storage\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: Kit <kit@example.com>';
  assert.ok(merge.commit_message.endsWith(`\n\n${trailers}`), merge.commit_message);
  assert.equal(merge.commit_message.match(/^OpenSpec-Slice: storage$/gm).length, 1, 'each trailer once');
  assert.ok(merge.commit_message.startsWith('* Add storage\n\n* Test storage\n\nCovers the radius.\n\n* Tidy the guide\n\n'), merge.commit_message);
  assert.deepEqual(json.merge, { sha: M, method: 'squash', trailers: { changes: ['deliver'], slices: ['storage'] } });

  // The default branch after that squash: one commit with that message and no trailer commits
  // from the branch, read with no gh on PATH.
  const repo = await slicedRepository(t);
  const before = await repo.status();
  assert.equal(before.slices.find(slice => slice.id === 'storage').state, 'ready');
  await repo.put('src/storage.mjs', 'export const storage = true;\n');
  await repo.git(['add', '.']);
  await repo.git(['commit', '-q', '-F', '-'], `${merge.commit_title}\n\n${merge.commit_message}\n`);
  const after = await repo.status();
  assert.deepEqual(after.pullRequests, { status: 'not_collected', reason: 'gh is not installed' });
  assert.deepEqual(Object.fromEntries(after.slices.map(slice => [slice.id, slice.state])), { storage: 'landed', api: 'ready' });
});

// spec: pull-request-landing / No trailers are invented
test('a squash of a pull request without slice trailers keeps GitHub\'s own message, as do rebase merges', async t => {
  const { land } = await machine(t);
  const plain = landed(await land(routes(), LAND));
  assert.deepEqual(plain.merge, { sha: M, method: 'squash' });
  const result = await land(trailered([commitEntry(A, 'Edit the guide\n\nMentions OpenSpec-Slice: storage in prose.')], 'No trailers here.'), LAND);
  landed(result);
  assert.deepEqual(result.calls.find(call => call.method === 'PUT').body, { sha: A, merge_method: 'squash' });
  // A rebase keeps each commit's own message, trailers included, so none is written.
  const rebase = trailered([commitEntry(A, 'Add storage\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage')]);
  rebase[`GET ${R}`] = [{ body: repository({ allow_rebase_merge: true, allow_squash_merge: false }) }, { body: repository({ allow_rebase_merge: true, allow_squash_merge: false }) }];
  const rebased = await land(rebase, LAND);
  landed(rebased);
  assert.deepEqual(rebased.calls.find(call => call.method === 'PUT').body, { sha: A, merge_method: 'rebase' });
});

// spec: pull-request-landing / Conflicting or malformed trailers
test('slices named for different changes, a slice without a change, or a malformed trailer refuse before anything is posted', async t => {
  const { land } = await machine(t);
  const cases = [
    ['TRAILERS_CONFLICT', [commitEntry(C1, 'One\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage'), commitEntry(A, 'Two\n\nOpenSpec-Change: other\nOpenSpec-Slice: api')]],
    ['TRAILERS_CONFLICT', [commitEntry(A, 'One\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage')], 'OpenSpec-Change: other\nOpenSpec-Slice: storage'],
    ['TRAILERS_CONFLICT', [commitEntry(A, 'One\n\nOpenSpec-Slice: storage')]],
    ['TRAILERS_INVALID', [commitEntry(A, 'One\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage')], 'OpenSpec-Change: <change>\nOpenSpec-Slice: <slice>'],
    ['TRAILERS_INVALID', [commitEntry(A, 'One\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage api')]],
  ];
  for (const [code, commits, body] of cases) {
    // Substantial, with a skip reason that would be posted once the gates pass.
    const result = await land(trailered(commits, body ?? null, [file('lib/x.mjs')]), [...LAND, '--skip-review', 'trailer check']);
    refused(result, code);
    assert.ok(!result.keys.includes(`POST ${R}/issues/7/comments`), 'nothing posted');
  }
  // An unsliced change beside the sliced one is carried, as a squash always combined them.
  const party = await land(trailered([commitEntry(C1, 'One\n\nOpenSpec-Change: shared:embed\nOpenSpec-Slice: game-guest'), commitEntry(A, 'Two\n\nOpenSpec-Change: accept-host')]), LAND);
  assert.deepEqual(landed(party).merge.trailers, { changes: ['shared:embed', 'accept-host'], slices: ['game-guest'] });
});

// A squash whose commits can't all be read from the pinned compare refuses rather than drop trailers.
test('a squash whose compare lists fewer commits than it counts refuses', async t => {
  const { land } = await machine(t);
  const fixtures = trailered([commitEntry(A, 'One\n\nOpenSpec-Change: deliver\nOpenSpec-Slice: storage')]);
  fixtures[FILES][0].body.total_commits = 120;
  refused(await land(fixtures, LAND), 'EVIDENCE_INCOMPLETE');
});
