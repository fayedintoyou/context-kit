// Lands a pull request only through its gates: the tested head, the repository's expected
// checks on it, and for substantial work an approving output review record or a posted skip.
// Every GitHub read and write goes through one small `gh api` runner with explicit
// repos/<owner>/<name>/… paths, and evidence that can't be read completely refuses.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fail } from './files.mjs';

const exec = promisify(execFile);
export const POLICY_PATH = '.context-kit/landing.json';
const POLL_SECONDS = 20;
const FILE_LIST_CAP = 3000;
const REVIEW_MARK = '<!-- context-kit:review -->';
const SKIP_MARK = '<!-- context-kit:review-skipped -->';
const NO_CHECKS_MARK = '<!-- context-kit:no-checks -->';
const METHODS = ['squash', 'rebase', 'merge'];
const SHA = /^[0-9a-f]{40}$/;
const MERGE_QUEUE_QUERY = 'query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){mergeQueue(branch:$b){id}}}';

// The runner: spawns `gh` from PATH. A nonzero exit carries GitHub's HTTP status when gh
// printed one; otherwise it is a transport failure (a dropped connection, a missing gh).
class GhError extends Error {
  constructor(message, { status = null, body = null } = {}) { super(message); this.status = status; this.body = body; }
}
export function ghRunner(env = process.env) {
  return (method, path, { paginate = false, input, fields = {} } = {}) => new Promise((resolve, reject) => {
    const args = ['api', '--method', method, path, ...(paginate ? ['--paginate', '--slurp'] : []), ...(input === undefined ? [] : ['--input', '-']),
      ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`])];
    let child;
    try { child = spawn('gh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(new GhError(`gh could not start: ${error.message}`)); return; }
    const out = []; const err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(new GhError(`gh could not start: ${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) {
        const status = Number(stderr.match(/\(HTTP (\d{3})\)/)?.[1]) || null;
        let body = null;
        try { body = stdout.trim() ? JSON.parse(stdout) : null; } catch { /* Not JSON. */ }
        reject(new GhError(`${method} ${path}: ${stderr.split('\n').pop() || `gh exited ${code}`}`, { status, body }));
        return;
      }
      if (!stdout.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new GhError(`${method} ${path}: malformed JSON from gh`)); }
    });
    child.stdin.on('error', () => { /* gh may exit before reading. */ });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

// One repository identity: --repo, else the origin remote of the checkout here. GH_REPO
// naming another repository is ambiguous, and every call names the repository explicitly.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function fromRemote(url) {
  const match = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}
async function resolveRepo(repo, cwd, env) {
  let resolved = repo;
  if (resolved !== undefined) {
    if (!REPO.test(resolved)) fail('INVALID_INPUT', `--repo is owner/name: ${resolved}`);
  } else {
    let url;
    try { url = (await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 10000 })).stdout; }
    catch { fail('INVALID_INPUT', `No --repo, and ${cwd} has no origin remote; pass --repo owner/name`); }
    resolved = fromRemote(url);
    if (!resolved) fail('INVALID_INPUT', `origin is not a GitHub repository (${url.trim()}); pass --repo owner/name`);
  }
  if (env.GH_REPO) {
    const named = env.GH_REPO.split('/').slice(-2).join('/');
    if (named.toLowerCase() !== resolved.toLowerCase()) {
      fail('REPO_AMBIGUOUS', `GH_REPO names ${env.GH_REPO}, but this landing resolved ${resolved}${repo === undefined ? ' from the origin remote' : ''}; unset GH_REPO or make them agree`);
    }
  }
  return resolved;
}

// The landing policy, validated strictly.
const reason = z.string().trim().min(1).max(500);
const checkRun = z.object({ kind: z.literal('check_run').optional(), name: z.string().min(1).max(200), app: z.string().min(1).max(100),
  workflow: z.string().min(1).max(300).optional(), event: z.string().min(1).max(100).optional(), skippable: reason.optional() }).strict()
  .superRefine((entry, context) => {
    if (entry.app === 'github-actions' && (!entry.workflow || !entry.event)) context.addIssue({ code: 'custom', message: `${entry.name}: a github-actions check names its workflow and event` });
    if (entry.app !== 'github-actions' && (entry.workflow || entry.event)) context.addIssue({ code: 'custom', message: `${entry.name}: workflow and event apply only to github-actions checks` });
  });
const commitStatus = z.object({ kind: z.literal('status'), context: z.string().min(1).max(200), creator: z.string().min(1).max(100).optional() }).strict();
const globs = z.array(z.string().min(1).max(300)).max(200);
const policySchema = z.object({
  expectedChecks: z.array(z.union([commitStatus, checkRun])).max(100),
  routine: z.object({ paths: globs, excludePaths: globs.optional() }).strict().optional(),
}).strict();
function parsePolicy(text, where) {
  let data;
  try { data = JSON.parse(text); } catch (error) { fail('INVALID_POLICY', `${where}: not JSON (${error.message})`); }
  const parsed = policySchema.safeParse(data);
  if (!parsed.success) fail('INVALID_POLICY', `${where}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(policy)'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

const segments = ref => ref.split('/').map(encodeURIComponent).join('/');
const label = entry => entry.kind === 'status' ? `status ${entry.context}${entry.creator ? ` by ${entry.creator}` : ''}`
  : `${entry.name} (${entry.app}${entry.workflow ? `, ${entry.workflow} on ${entry.event}` : ''})`;

// Evidence reads. Any read error, malformed response or count mismatch refuses: missing
// data never means passing or routine.
function incomplete(message, details) { fail('EVIDENCE_INCOMPLETE', message, details); }
function evidence(context) {
  const { gh, base } = context;
  const read = async (path, check) => {
    let body;
    try { body = await gh('GET', `${base}${path}`); } catch (error) { incomplete(`Could not read ${base}${path}: ${error.message}`); }
    if (check && !check(body)) incomplete(`Unexpected response from ${base}${path}`);
    return body;
  };
  // A list read through --paginate --slurp: pages of arrays, or pages of objects whose
  // `field` is the array and whose total_count must match what was collected.
  const list = async (path, field) => {
    let pages;
    try { pages = await gh('GET', `${base}${path}`, { paginate: true }); } catch (error) { incomplete(`Could not read ${base}${path}: ${error.message}`); }
    if (!Array.isArray(pages) || !pages.length) incomplete(`Unexpected response from ${base}${path}`);
    if (!field) {
      if (!pages.every(Array.isArray)) incomplete(`Unexpected response from ${base}${path}`);
      return pages.flat();
    }
    if (!pages.every(page => page && Array.isArray(page[field]))) incomplete(`Unexpected response from ${base}${path}`);
    const items = pages.flatMap(page => page[field]);
    if (typeof pages[0].total_count === 'number' && pages[0].total_count !== items.length) {
      incomplete(`${base}${path} reported ${pages[0].total_count} ${field} but listed ${items.length}`);
    }
    return items;
  };
  return { read, list };
}
const isPull = body => body && typeof body.number === 'number' && typeof body.state === 'string' && body.head?.sha && body.base?.ref;

async function readPolicy(context, sha) {
  let body;
  try { body = await context.gh('GET', `${context.base}/contents/${POLICY_PATH}?ref=${sha}`); }
  catch (error) {
    if (error.status === 404) return null;
    incomplete(`Could not read ${POLICY_PATH} at ${sha}: ${error.message}`);
  }
  if (!body || body.type !== 'file' || typeof body.content !== 'string') fail('INVALID_POLICY', `${POLICY_PATH} at ${sha} is not a file`);
  return parsePolicy(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'), `${POLICY_PATH} at ${sha}`);
}

// Check evidence on one SHA: check runs (every one, not GitHub's latest filter), the
// combined commit status, and, when the policy names Actions checks, the workflow runs
// that give a check run its workflow path and event.
async function readChecks(context, policy, sha) {
  const { list } = evidence(context);
  const kinds = new Set(policy.expectedChecks.map(entry => entry.kind ?? 'check_run'));
  const runs = kinds.has('check_run') ? await list(`/commits/${sha}/check-runs?filter=all&per_page=100`, 'check_runs') : [];
  const statuses = kinds.has('status') ? await list(`/commits/${sha}/status?per_page=100`, 'statuses') : [];
  const workflows = policy.expectedChecks.some(entry => entry.app === 'github-actions')
    ? await list(`/actions/runs?head_sha=${sha}&per_page=100`, 'workflow_runs') : [];
  // Fields that matching and ordering rely on must be present, or nothing is decided from them.
  const bad = runs.find(run => typeof run?.id !== 'number' || typeof run.name !== 'string' || typeof run.app?.slug !== 'string'
    || typeof run.status !== 'string' || typeof run.check_suite?.id !== 'number');
  if (bad) incomplete(`A check run is missing its id, name, app, status or check suite: ${JSON.stringify(bad).slice(0, 200)}`);
  if (statuses.some(status => typeof status?.context !== 'string' || typeof status.state !== 'string')) incomplete('A commit status is missing its context or state');
  const suites = new Set(runs.map(run => run.check_suite.id));
  const unjoinable = workflows.find(run => suites.has(run?.check_suite_id) && (typeof run.path !== 'string' || !run.path || typeof run.event !== 'string' || !run.event));
  if (unjoinable) incomplete(`Workflow run ${unjoinable.id} is missing its path or event, so its check runs can't be identified`);
  return { runs, statuses, workflows };
}
function evaluateChecks(policy, { runs, statuses, workflows }) {
  const suites = new Map(workflows.map(run => [run.check_suite_id, { workflow: String(run.path ?? '').replace(/@.*$/, ''), event: run.event, run: run.id }]));
  const results = [];
  for (const entry of policy.expectedChecks) {
    const base = { check: label(entry), entry };
    if (entry.kind === 'status') {
      const status = statuses.find(item => item.context === entry.context);
      if (!status || (entry.creator && status.creator?.login !== entry.creator)) { results.push({ ...base, state: 'missing' }); continue; }
      const state = status.state === 'success' ? 'passed' : status.state === 'pending' ? 'pending' : 'failed';
      results.push({ ...base, state, conclusion: status.state, id: status.id, url: status.target_url ?? null });
      continue;
    }
    const named = runs.filter(run => run.name === entry.name && run.app?.slug === entry.app);
    let matched = named;
    let untraceable = [];
    if (entry.app === 'github-actions') {
      untraceable = named.filter(run => !suites.has(run.check_suite?.id));
      matched = named.filter(run => {
        const identity = suites.get(run.check_suite?.id);
        return identity && identity.workflow === entry.workflow && identity.event === entry.event;
      });
    }
    const latest = matched.reduce((best, run) => !best || run.id > best.id ? run : best, null);
    if (!latest) { results.push({ ...base, state: 'missing' }); continue; }
    const newer = untraceable.filter(run => run.id > latest.id);
    if (newer.length) {
      results.push({ ...base, state: 'untraceable', id: latest.id, newer: newer.map(run => run.id) });
      continue;
    }
    const found = { id: latest.id, url: latest.html_url ?? null, conclusion: latest.status === 'completed' ? latest.conclusion : latest.status };
    if (latest.status !== 'completed') results.push({ ...base, ...found, state: 'pending' });
    else if (latest.conclusion === 'success') results.push({ ...base, ...found, state: 'passed' });
    else if (['skipped', 'neutral'].includes(latest.conclusion) && entry.skippable) results.push({ ...base, ...found, state: 'skipped', reason: entry.skippable });
    else results.push({ ...base, ...found, state: 'failed', ...(['skipped', 'neutral'].includes(latest.conclusion) ? { reason: 'skipped, and the policy gives this check no skip reason' } : {}) });
  }
  return results;
}
const publicCheck = ({ entry, ...result }) => result;
// The checks gate: an untraceable newer run is incomplete evidence; then failures, missing
// checks and pending ones, each naming its entries.
function checksOutcome(results) {
  const pick = state => results.filter(result => result.state === state);
  const names = list => list.map(result => result.check).join('; ');
  if (pick('untraceable').length) {
    return { code: 'EVIDENCE_INCOMPLETE', message: `A newer check run of the same name can't be traced to its workflow, so it may supersede the match: ${names(pick('untraceable'))}` };
  }
  if (pick('failed').length) return { code: 'CHECKS_FAILED', message: `Expected checks did not pass: ${pick('failed').map(result => `${result.check}: ${result.reason ?? result.conclusion}`).join('; ')}` };
  if (pick('missing').length) return { code: 'CHECKS_MISSING', message: `Expected checks never ran on this head from their named producer: ${names(pick('missing'))}` };
  if (pick('pending').length) return { code: 'CHECKS_PENDING', message: `Expected checks are still pending: ${names(pick('pending'))}` };
  return null;
}
const signature = results => JSON.stringify(results.map(result => [result.check, result.state, result.id ?? null, result.conclusion ?? null]));

// Substantial by default: routine only when every path, old and new, is exempt. Workflow
// files, the policy directory, OpenSpec change deltas and the `substantial` label override.
function globExpression(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
const matchesAny = (patterns, path) => (patterns ?? []).some(pattern => globExpression(pattern).test(path));
function classify(policy, files, labels) {
  const paths = [...new Set(files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean)))];
  const signals = [];
  for (const path of paths) {
    if (path.startsWith('.github/')) signals.push({ file: path, reason: 'workflow or repository configuration (.github/)' });
    else if (path.startsWith('.context-kit/')) signals.push({ file: path, reason: 'landing policy (.context-kit/)' });
    else if (/^openspec\/changes\/.+\/specs\/.+/.test(path)) signals.push({ file: path, reason: 'OpenSpec change delta' });
  }
  if (labels.includes('substantial')) signals.push({ label: 'substantial', reason: 'the substantial label' });
  const routine = policy.routine;
  const files_ = paths.filter(path => !routine || !matchesAny(routine.paths, path) || matchesAny(routine.excludePaths, path))
    .map(path => ({ file: path, reason: !routine ? 'the policy has no routine exemption' : matchesAny(routine.excludePaths, path) ? 'excluded from the routine exemption' : 'outside the routine exemption' }));
  if (!paths.length) files_.push({ file: null, reason: 'no changed files' });
  if (signals.length || files_.length) return { value: true, files: files_, signals };
  return { value: false, exemption: { paths: routine.paths, excludePaths: routine.excludePaths ?? [] } };
}

// Review records: comments and review bodies carrying the block. Only output records for
// the head with an approving outcome count, and for that SHA the newest decides.
const FIELDS = ['Reviewed-SHA', 'Phase', 'Reviewer', 'Outcome', 'Findings', 'Evidence'];
function parseRecord(body) {
  const at = body.indexOf(REVIEW_MARK);
  if (at < 0) return null;
  const fields = {};
  for (const line of body.slice(at + REVIEW_MARK.length).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z-]+):\s*(.*?)\s*$/);
    if (match && FIELDS.includes(match[1]) && !(match[1] in fields)) fields[match[1]] = match[2];
  }
  const missing = FIELDS.filter(field => !fields[field]);
  if (missing.length) return { malformed: `missing ${missing.join(', ')}` };
  if (!SHA.test(fields['Reviewed-SHA'].toLowerCase())) return { malformed: 'Reviewed-SHA is not a 40-hex SHA' };
  if (!['plan', 'output'].includes(fields.Phase)) return { malformed: `Phase is plan or output, not ${fields.Phase}` };
  if (!['approved', 'approved-with-deferrals', 'changes-requested'].includes(fields.Outcome)) return { malformed: `unknown Outcome ${fields.Outcome}` };
  return { sha: fields['Reviewed-SHA'].toLowerCase(), phase: fields.Phase, reviewer: fields.Reviewer, outcome: fields.Outcome, findings: fields.Findings, evidence: fields.Evidence };
}
function reviewRecords(comments, reviews, sha) {
  const sources = [
    ...comments.map(item => ({ id: item.id, url: item.html_url, at: item.created_at, author: item.user?.login, body: item.body })),
    ...reviews.map(item => ({ id: item.id, url: item.html_url, at: item.submitted_at, author: item.user?.login, body: item.body })),
  ].filter(item => typeof item.body === 'string' && item.body.includes(REVIEW_MARK))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id - b.id);
  const others = [];
  const current = [];
  for (const source of sources) {
    const record = parseRecord(source.body);
    const where = { url: source.url, author: source.author ?? null };
    if (record.malformed) others.push({ ...where, status: 'malformed', reason: record.malformed });
    else if (record.sha !== sha) others.push({ ...where, status: 'stale', reviewedSha: record.sha, reviewer: record.reviewer });
    else if (record.phase !== 'output') others.push({ ...where, status: 'not_applicable', reason: 'plan-phase record', reviewer: record.reviewer });
    else current.push({ ...where, reviewer: record.reviewer, outcome: record.outcome, findings: record.findings, evidence: record.evidence });
  }
  const newest = current.at(-1) ?? null;
  for (const record of current.slice(0, -1)) others.push({ url: record.url, status: 'superseded', outcome: record.outcome, reviewer: record.reviewer });
  return { newest, others };
}

async function post(context, number, body) {
  try { return await context.gh('POST', `${context.base}/issues/${number}/comments`, { input: { body } }); }
  catch (error) { fail('POST_FAILED', `Could not post to pull request #${number}, so nothing was merged: ${error.message}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function landPullRequest(args, { env = process.env, cwd = process.cwd() } = {}) {
  const sha = args.sha.toLowerCase();
  const repo = await resolveRepo(args.repo, cwd, env);
  const context = { gh: ghRunner(env), base: `repos/${repo}` };
  const { read, list } = evidence(context);
  const number = args.number;

  // The repository, its default branch's tip, and the policy at that tip.
  const repository = await read('', body => body && typeof body.default_branch === 'string');
  const branch = repository.default_branch;
  const tipOf = async () => (await read(`/git/ref/heads/${segments(branch)}`, body => SHA.test(body?.object?.sha ?? ''))).object.sha;
  const baseTip = await tipOf();
  let policy = await readPolicy(context, baseTip);
  let provenance = { path: POLICY_PATH, branch, sha: baseTip };
  if (args.bootstrapPolicy) {
    if (policy) fail('INVALID_INPUT', `--bootstrap-policy applies only while ${branch} has no policy, and ${POLICY_PATH} exists at ${baseTip}`);
    policy = await readPolicy(context, sha);
    if (!policy) fail('NO_POLICY', `Neither ${branch} (${baseTip}) nor the head ${sha} has ${POLICY_PATH}`);
    provenance = { path: POLICY_PATH, bootstrap: true, head: sha };
  } else if (!policy) {
    fail('NO_POLICY', `${branch} has no ${POLICY_PATH} at ${baseTip}; add one (land that pull request with --bootstrap-policy)`);
  }
  if (policy.expectedChecks.length && args.noChecks !== undefined) fail('INVALID_INPUT', '--no-checks applies only when the policy expects no checks');
  const allowed = METHODS.filter(method => repository[`allow_${method === 'merge' ? 'merge_commit' : `${method}_merge`}`]);
  const method = args.method ?? allowed[0];
  if (!method || !allowed.includes(method)) fail('INVALID_INPUT', `${repo} allows ${allowed.join(', ') || 'no merge method'}${args.method ? `, not ${args.method}` : ''}`);

  // The pull request; mergeability is computed lazily by GitHub, so an unknown one is re-read.
  const readPull = () => read(`/pulls/${number}`, isPull);
  let pr = await readPull();
  for (let attempt = 0; pr.state === 'open' && pr.mergeable === null && attempt < 2; attempt++) { await sleep(2000); pr = await readPull(); }

  // Gates 1–5.
  if (pr.state !== 'open') fail('NOT_OPEN', `#${number} is ${pr.merged ? 'already merged' : pr.state}`);
  if (pr.base.ref !== branch) fail('NOT_DEFAULT_BASE', `#${number} targets ${pr.base.ref}, not the default branch ${branch}`);
  let rules;
  try { rules = await context.gh('GET', `${context.base}/rules/branches/${segments(branch)}?per_page=100`, { paginate: true }); }
  catch (error) {
    // A private repository without a paid plan can't have rulesets, and GitHub says so.
    if (error.status === 403 && /upgrade to github pro|make this repository public/i.test(error.body?.message ?? error.message)) rules = [[]];
    else incomplete(`Could not read the rules for ${branch}: ${error.message}`);
  }
  if (!Array.isArray(rules) || !rules.every(Array.isArray)) incomplete(`Unexpected response from ${context.base}/rules/branches/${branch}`);
  if (rules.flat().some(rule => rule?.type === 'merge_queue')) fail('MERGE_QUEUE_UNSUPPORTED', `${branch} requires a merge queue; pr land merges directly, so use the queue`);
  // Classic branch protection can require a queue too; only GraphQL shows whether one exists.
  const [owner, name] = repo.split('/');
  let queue;
  try { queue = await context.gh('POST', 'graphql', { fields: { query: MERGE_QUEUE_QUERY, o: owner, r: name, b: branch } }); }
  catch (error) {
    const messages = (error.body?.errors ?? []).map(item => String(item?.message ?? ''));
    if (messages.length && messages.every(message => /not available|upgrade to github pro/i.test(message))) queue = { data: { repository: { mergeQueue: null } } };
    else incomplete(`Could not read whether ${branch} has a merge queue: ${error.message}`);
  }
  if (!queue?.data?.repository || !('mergeQueue' in queue.data.repository) || queue.errors?.length) incomplete(`Unexpected merge queue response for ${branch}`);
  if (queue.data.repository.mergeQueue !== null) fail('MERGE_QUEUE_UNSUPPORTED', `${branch} has a merge queue; pr land merges directly, so use the queue`);
  if (pr.head.sha !== sha) fail('HEAD_MISMATCH', `#${number}'s head is ${pr.head.sha}, not ${sha}`);
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') fail('CONFLICTING', `#${number} conflicts with ${branch}`);

  // Everything else, read once: dependents are snapshotted now, before any merge can retarget them.
  if (pr.mergeable !== true) incomplete(`GitHub has not computed whether #${number} can merge; try again shortly`);
  const sameRepo = pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase();
  if (typeof pr.changed_files !== 'number') incomplete(`#${number} does not report its changed-file count`);
  if (pr.changed_files > FILE_LIST_CAP) incomplete(`#${number} changes ${pr.changed_files} files; GitHub lists at most ${FILE_LIST_CAP}`);
  const files = await list(`/pulls/${number}/files?per_page=100`);
  const badFile = files.find(item => typeof item?.filename !== 'string' || !item.filename
    || (item.status === 'renamed' && (typeof item.previous_filename !== 'string' || !item.previous_filename)));
  if (badFile) incomplete(`A changed file is missing its filename, or a rename its previous filename: ${JSON.stringify(badFile).slice(0, 200)}`);
  if (files.length !== pr.changed_files) incomplete(`#${number} reports ${pr.changed_files} changed files but ${files.length} were listed`);
  let checkEvidence = policy.expectedChecks.length ? await readChecks(context, policy, sha) : null;
  const comments = await list(`/issues/${number}/comments?per_page=100`);
  const reviews = await list(`/pulls/${number}/reviews?per_page=100`);
  const dependents = sameRepo ? (await list(`/pulls?state=open&base=${encodeURIComponent(pr.head.ref)}&per_page=100`))
    .map(item => ({ number: item.number, base: item.base?.ref })) : [];

  // Gate 7: the expected checks, waiting on pending ones with --wait.
  let checks = [];
  if (!policy.expectedChecks.length) {
    if (args.noChecks === undefined) fail('CHECKS_NONE_EXPECTED', `${provenance.path} expects no checks; land with --no-checks "<alternative validation and link>"`);
  } else {
    const deadline = Date.now() + (args.timeout ?? 30) * 60000;
    for (;;) {
      checks = evaluateChecks(policy, checkEvidence);
      const outcome = checksOutcome(checks);
      if (!outcome) break;
      if (outcome.code === 'CHECKS_PENDING' && args.wait && Date.now() < deadline) {
        await sleep(Math.min(POLL_SECONDS * 1000, deadline - Date.now()));
        checkEvidence = await readChecks(context, policy, sha);
        continue;
      }
      fail(outcome.code, outcome.message + (outcome.code === 'CHECKS_PENDING' && args.wait ? ' (timed out waiting)' : ''), { checks: checks.map(publicCheck) });
    }
  }

  // Gate 8: review, for substantial work. Decided again from fresh labels and records at the refresh.
  const decideReview = (labels, comments, reviews) => {
    const substantial = classify(policy, files, labels.map(item => item.name));
    const records = reviewRecords(comments, reviews, sha);
    if (!substantial.value) return { substantial, review: { required: false, status: 'not_required', exemption: substantial.exemption, others: records.others } };
    if (records.newest && records.newest.outcome !== 'changes-requested') return { substantial, review: { required: true, status: 'approved', record: records.newest, others: records.others } };
    if (args.skipReview !== undefined) return { substantial, review: { required: true, status: 'skipped', reason: args.skipReview, ...(records.newest ? { record: records.newest } : {}), others: records.others } };
    const why = [...substantial.signals.map(item => item.file ?? `label ${item.label}`), ...substantial.files.map(item => item.file ?? item.reason)];
    const latest = records.newest ? ` The newest record for this head requests changes (${records.newest.url}).` : '';
    const reported = records.others.length ? ` Other records: ${records.others.map(item => `${item.status} ${item.url}`).join('; ')}.` : '';
    fail('REVIEW_MISSING', `#${number} is substantial (${why.join(', ')}) and has no approving output review record for ${sha}.${latest}${reported} Post one, or land with --skip-review "<reason>".`,
      { substantial, records: records.others, ...(records.newest ? { newest: records.newest } : {}) });
  };
  let { substantial, review } = decideReview(pr.labels ?? [], comments, reviews);
  const postSkip = async () => {
    const comment = await post(context, number, `${SKIP_MARK} Review skipped for ${sha}: ${args.skipReview}`);
    review.url = comment?.html_url ?? null;
  };

  // Posted before merging, so the record exists whatever happens next.
  const skipPosted = review.status === 'skipped';
  if (skipPosted) await postSkip();
  let noChecks = null;
  if (!policy.expectedChecks.length) {
    const comment = await post(context, number, `${NO_CHECKS_MARK} No checks expected for ${sha}: ${args.noChecks}`);
    noChecks = { reason: args.noChecks, url: comment?.html_url ?? null };
  }

  // Refresh immediately before the merge: any movement refuses with no merge call.
  const fresh = await read(`/pulls/${number}`, isPull);
  if (fresh.state !== 'open') fail('NOT_OPEN', `#${number} became ${fresh.merged ? 'merged' : fresh.state} before the merge`);
  if (fresh.base.ref !== branch) fail('BASE_MOVED', `#${number} was retargeted to ${fresh.base.ref}`);
  const tip = await tipOf();
  if (tip !== baseTip) fail('BASE_MOVED', `${branch} moved from ${baseTip} to ${tip} after the policy was read; run pr land again`);
  if (fresh.head.sha !== sha) fail('HEAD_MOVED', `#${number}'s head moved to ${fresh.head.sha}`);
  if (policy.expectedChecks.length) {
    const again = evaluateChecks(policy, await readChecks(context, policy, sha));
    if (signature(again) !== signature(checks)) fail('CHECKS_CHANGED', 'The expected checks changed on the head before the merge; run pr land again', { before: checks.map(publicCheck), after: again.map(publicCheck) });
  }
  // A record or label that arrived while waiting decides too: a later changes-requested, or
  // a substantial label on a routine change, refuses here.
  const url = review.url;
  ({ substantial, review } = decideReview(fresh.labels ?? [], await list(`/issues/${number}/comments?per_page=100`), await list(`/pulls/${number}/reviews?per_page=100`)));
  if (review.status === 'skipped') { if (skipPosted) review.url = url; else await postSkip(); }

  // The merge, pinned to the SHA. A rejection is final; a lost response is reconciled.
  let merged;
  try {
    merged = await context.gh('PUT', `${context.base}/pulls/${number}/merge`, { input: { sha, merge_method: method } });
    if (!merged?.merged || !SHA.test(merged.sha ?? '')) throw new GhError('Unexpected merge response');
    merged = { sha: merged.sha, method };
  } catch (error) {
    if (error.status && error.status < 500) fail('MERGE_REJECTED', `A merge call was made, and GitHub rejected it (HTTP ${error.status}): ${error.body?.message ?? error.message}`);
    let seen;
    try { seen = await context.gh('GET', `${context.base}/pulls/${number}`); } catch (reread) { seen = null; error.message += `; re-reading failed: ${reread.message}`; }
    if (!(seen?.merged && seen.head?.sha === sha && SHA.test(seen.merge_commit_sha ?? ''))) {
      fail('MERGE_UNKNOWN', `A merge call was made and its response was lost (${error.message}); not retried. Seen: ${seen ? `state ${seen.state}, merged ${Boolean(seen.merged)}, head ${seen.head?.sha}` : 'nothing'}`,
        { seen: seen ? { state: seen.state, merged: Boolean(seen.merged), head: seen.head?.sha ?? null, mergeCommit: seen.merge_commit_sha ?? null } : null });
    }
    merged = { sha: seen.merge_commit_sha, method, reconciled: true };
  }

  // After the merge: confirm, clean up only what is safe, and report dependents.
  const warnings = [];
  let cleanupIncomplete = false;
  // compare/<default>...<merge>: identical or behind means the default branch contains it.
  let contained = false;
  try {
    const compare = await context.gh('GET', `${context.base}/compare/${segments(branch)}...${merged.sha}`);
    contained = ['identical', 'behind'].includes(compare?.status);
    if (!contained) warnings.push(`${branch} does not contain the merge ${merged.sha} (${compare?.status})`);
  } catch (error) { warnings.push(`Could not confirm ${branch} contains ${merged.sha}: ${error.message}`); }
  if (!contained) cleanupIncomplete = true;

  // The head ref goes only when it's this repository's, unmoved and unshared, and the merge is
  // confirmed. It is re-read immediately before the delete; GitHub has no conditional delete,
  // so the moment between that read and the delete is the remaining window.
  let branchResult;
  const ref = pr.head.ref;
  const headRef = async () => {
    try { return (await context.gh('GET', `${context.base}/git/ref/heads/${segments(ref)}`))?.object?.sha ?? null; }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  if (!sameRepo) branchResult = { ref, kept: `the head is in ${pr.head.repo?.full_name ?? 'a deleted fork'}, not ${repo}` };
  else {
    try {
      const current = await headRef();
      if (current === null) branchResult = { ref, deleted: false, alreadyDeleted: true };
      else if (current !== sha) branchResult = { ref, kept: `it moved to ${current} after the merge` };
      else if (!contained) branchResult = { ref, kept: `${branch} isn't confirmed to contain the merge` };
      else {
        const sharing = (await list(`/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${ref}`)}&per_page=100`)).filter(item => item.number !== number);
        const again = sharing.length ? null : await headRef();
        if (sharing.length) branchResult = { ref, kept: `open pull requests also use it as their head: ${sharing.map(item => `#${item.number}`).join(', ')}` };
        else if (again === null) branchResult = { ref, deleted: false, alreadyDeleted: true };
        else if (again !== sha) branchResult = { ref, kept: `it moved to ${again} after the merge` };
        else {
          try { await context.gh('DELETE', `${context.base}/git/refs/heads/${segments(ref)}`); branchResult = { ref, deleted: true }; }
          catch (error) {
            // A refused delete counts as already deleted only if the ref is confirmed gone.
            if (await headRef() === null) branchResult = { ref, deleted: false, alreadyDeleted: true };
            else branchResult = { ref, kept: `the delete failed: ${error.message}` };
          }
        }
      }
    } catch (error) { branchResult = { ref, kept: `cleanup failed: ${error.message}` }; }
  }
  if (branchResult.kept) cleanupIncomplete = true;

  const dependentResults = [];
  for (const dependent of dependents) {
    try {
      const now = await context.gh('GET', `${context.base}/pulls/${dependent.number}`);
      dependentResults.push({ number: dependent.number, oldBase: dependent.base, newBase: now?.base?.ref ?? null, state: now?.state ?? null, needsRevalidation: true });
    } catch (error) {
      dependentResults.push({ number: dependent.number, oldBase: dependent.base, newBase: null, needsRevalidation: true });
      warnings.push(`Could not re-read dependent #${dependent.number}: ${error.message}`);
      cleanupIncomplete = true;
    }
  }

  return {
    status: cleanupIncomplete ? 'merged_cleanup_incomplete' : 'merged', repo, number, sha, policy: provenance,
    merge: merged, checks: noChecks ? { none: true, ...noChecks } : checks.map(publicCheck), substantial, review,
    branch: branchResult, dependents: dependentResults, warnings,
  };
}
