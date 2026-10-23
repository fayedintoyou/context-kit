// Lands a pull request only through its gates: the tested head, the repository's expected
// checks on it, and for substantial work an approving output review record or a posted skip.
// Every GitHub read and write goes through one small `gh api` runner with explicit
// repos/<owner>/<name>/… paths, and evidence that can't be read completely refuses.
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { fail } from './files.mjs';
import { git, gitEnvironment } from './git-env.mjs';
import { matchesAny } from './globs.mjs';

export const POLICY_PATH = '.context-kit/landing.json';
const POLL_SECONDS = 20;
// GitHub's compare lists at most 300 changed files for a comparison, all on its first page.
const FILE_LIST_CAP = 300;
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
    // gh reads git for the default repository; an inherited GIT_DIR must not choose it.
    try { child = spawn('gh', args, { env: gitEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'] }); }
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
    try { url = (await git(cwd, ['remote', 'get-url', 'origin'], { timeout: 10000 })).stdout; }
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

// Evidence. Every GitHub response the command relies on is parsed through one strict schema
// per endpoint, here; a read error, a parse failure or a count mismatch refuses
// EVIDENCE_INCOMPLETE before anything is classified, matched or merged. Missing data never
// means passing or routine.
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonEmpty = z.string().min(1);
const commit = z.string().regex(SHA);
const isoDate = z.iso.datetime({ offset: true });
const login = z.object({ login: z.string() }).nullable().optional();
export const SCHEMAS = {
  repository: z.object({ default_branch: nonEmpty, allow_squash_merge: z.boolean(), allow_rebase_merge: z.boolean(), allow_merge_commit: z.boolean() }),
  ref: z.object({ object: z.object({ sha: commit }) }),
  contents: z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string() }),
  pull: z.object({ number: positive, state: z.enum(['open', 'closed']), merged: z.boolean(), draft: z.boolean(),
    mergeable: z.boolean().nullable(), mergeable_state: nonEmpty, merge_commit_sha: commit.nullable(), changed_files: count,
    title: nonEmpty, body: z.string().nullable(), user: z.object({ login: nonEmpty }),
    labels: z.array(z.object({ name: nonEmpty })), base: z.object({ ref: nonEmpty, sha: commit }),
    head: z.object({ ref: nonEmpty, sha: commit, repo: z.object({ full_name: nonEmpty }).nullable() }) }),
  pullNumber: z.object({ number: positive }),
  dependent: z.object({ number: positive, base: z.object({ ref: nonEmpty }) }),
  rule: z.object({ type: nonEmpty }),
  mergeQueue: z.object({ data: z.object({ repository: z.object({ mergeQueue: z.object({ id: nonEmpty }).nullable() }) }), errors: z.array(z.unknown()).optional() }),
  file: z.object({ filename: nonEmpty, status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']), previous_filename: nonEmpty.nullable().optional() })
    .refine(file => !['renamed', 'copied'].includes(file.status) || file.previous_filename, 'a rename or copy names its previous filename'),
  checkRun: z.object({ id: positive, name: nonEmpty, status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
    conclusion: z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']).nullable(),
    app: z.object({ slug: nonEmpty }), check_suite: z.object({ id: positive }), html_url: z.string().nullable().optional() }),
  workflowRun: z.object({ id: positive, check_suite_id: positive, path: nonEmpty, event: nonEmpty, run_attempt: positive }),
  status: z.object({ id: positive, context: nonEmpty, state: z.enum(['error', 'failure', 'pending', 'success']), created_at: isoDate,
    target_url: z.string().nullable().optional(), creator: login }),
  comment: z.object({ id: positive, body: z.string(), created_at: isoDate, html_url: z.string().optional(), user: login }),
  // A pending review has no submitted_at; one holding a record must have it, to be ordered.
  review: z.object({ id: positive, body: z.string(), submitted_at: isoDate.nullable().optional(), html_url: z.string().optional(), user: login })
    .refine(review => !review.body.includes(REVIEW_MARK) || review.submitted_at, 'a review holding a record has submitted_at'),
  compare: z.object({ status: z.enum(['diverged', 'ahead', 'behind', 'identical']) }),
  diff: z.object({ status: z.enum(['diverged', 'ahead', 'behind', 'identical']), merge_base_commit: z.object({ sha: commit }), total_commits: count,
    commits: z.array(z.object({ sha: commit, commit: z.object({ message: z.string(), author: z.object({ name: z.string(), email: z.string() }).nullable() }), author: login })) }),
  merge: z.object({ sha: commit, merged: z.literal(true) }),
  posted: z.object({ id: positive, html_url: z.string() }),
};
function incomplete(message, details) { fail('EVIDENCE_INCOMPLETE', message, details); }
function parse(schema, body, where) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) incomplete(`Unexpected response from ${where}: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(response)'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}
function evidence(context) {
  const { gh, base } = context;
  const read = async (path, schema) => {
    let body;
    try { body = await gh('GET', `${base}${path}`); } catch (error) { incomplete(`Could not read ${base}${path}: ${error.message}`); }
    return parse(schema, body, `${base}${path}`);
  };
  // A list read through --paginate --slurp: pages of arrays of `item`, or pages of objects whose
  // `field` holds them and whose required total_count must equal what was collected. With
  // `unique`, two items with the same key are a conflict, never a choice.
  const list = async (path, item, { field, unique } = {}) => {
    let pages;
    try { pages = await gh('GET', `${base}${path}`, { paginate: true }); } catch (error) { incomplete(`Could not read ${base}${path}: ${error.message}`); }
    let items;
    if (!field) items = parse(z.array(z.array(item)).min(1), pages, `${base}${path}`).flat();
    else {
      const parsed = parse(z.array(z.object({ total_count: count, [field]: z.array(item) })).min(1), pages, `${base}${path}`);
      items = parsed.flatMap(page => page[field]);
      const counted = parsed.find(page => page.total_count !== items.length);
      if (counted) incomplete(`${base}${path} reported ${counted.total_count} ${field} but listed ${items.length}`);
    }
    if (unique) {
      const seen = new Set();
      for (const value of items.map(unique)) {
        if (seen.has(value)) incomplete(`${base}${path} lists ${value} twice`);
        seen.add(value);
      }
    }
    return items;
  };
  return { read, list };
}

async function readPolicy(context, sha) {
  let body;
  try { body = await context.gh('GET', `${context.base}/contents/${POLICY_PATH}?ref=${sha}`); }
  catch (error) {
    if (error.status === 404) return null;
    incomplete(`Could not read ${POLICY_PATH} at ${sha}: ${error.message}`);
  }
  const file = parse(SCHEMAS.contents, body, `${context.base}/contents/${POLICY_PATH}?ref=${sha}`);
  return parsePolicy(Buffer.from(file.content, 'base64').toString('utf8'), `${POLICY_PATH} at ${sha}`);
}

// Check evidence on one SHA: check runs (every one, not GitHub's latest filter), the
// combined commit status, and, when the policy names Actions checks, the workflow runs
// that give a check run its workflow path and event.
async function readChecks(context, policy, sha) {
  const { list } = evidence(context);
  const kinds = new Set(policy.expectedChecks.map(entry => entry.kind ?? 'check_run'));
  const runs = kinds.has('check_run') ? await list(`/commits/${sha}/check-runs?filter=all&per_page=100`, SCHEMAS.checkRun, { field: 'check_runs', unique: run => `check run ${run.id}` }) : [];
  const statuses = kinds.has('status') ? await list(`/commits/${sha}/status?per_page=100`, SCHEMAS.status, { field: 'statuses', unique: status => `status ${status.id}` }) : [];
  const workflows = policy.expectedChecks.some(entry => entry.app === 'github-actions')
    ? await list(`/actions/runs?head_sha=${sha}&per_page=100`, SCHEMAS.workflowRun, { field: 'workflow_runs', unique: run => `workflow run ${run.id}` }) : [];
  // One check suite has one workflow identity; two claims that differ can't both be believed.
  const identities = new Map();
  for (const run of workflows) {
    const identity = `${run.path.replace(/@.*$/, '')} on ${run.event}`;
    if (identities.has(run.check_suite_id) && identities.get(run.check_suite_id) !== identity) {
      incomplete(`Workflow runs disagree about check suite ${run.check_suite_id}: ${identities.get(run.check_suite_id)}, and ${identity}`);
    }
    identities.set(run.check_suite_id, identity);
  }
  return { runs, statuses, workflows };
}
function evaluateChecks(policy, { runs, statuses, workflows }) {
  const suites = new Map(workflows.map(run => [run.check_suite_id, { workflow: run.path.replace(/@.*$/, ''), event: run.event, run: run.id }]));
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
    // A run of the right name and app whose check suite no workflow run claims yet: GitHub's
    // head_sha listing lags behind its check runs. It is never a pass, only not yet decidable.
    if (!latest && untraceable.length) { results.push({ ...base, state: 'untraced', untraced: untraceable.map(run => run.id) }); continue; }
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
// checks, ones not yet traced to a workflow run, and pending ones, each naming its entries.
// Untraced and pending are the transient outcomes --wait polls through.
function checksOutcome(results) {
  const pick = state => results.filter(result => result.state === state);
  const names = list => list.map(result => result.check).join('; ');
  if (pick('untraceable').length) {
    return { code: 'EVIDENCE_INCOMPLETE', message: `A newer check run of the same name can't be traced to its workflow, so it may supersede the match: ${names(pick('untraceable'))}` };
  }
  if (pick('failed').length) return { code: 'CHECKS_FAILED', message: `Expected checks did not pass: ${pick('failed').map(result => `${result.check}: ${result.reason ?? result.conclusion}`).join('; ')}` };
  if (pick('missing').length) return { code: 'CHECKS_MISSING', message: `Expected checks never ran on this head from their named producer: ${names(pick('missing'))}` };
  if (pick('untraced').length) return { code: 'CHECKS_UNTRACEABLE', message: `GitHub hasn't indexed the workflow run for these checks yet, so they can't be traced to their workflow; retry, or use --wait: ${names(pick('untraced'))}` };
  if (pick('pending').length) return { code: 'CHECKS_PENDING', message: `Expected checks are still pending: ${names(pick('pending'))}` };
  return null;
}
const signature = results => JSON.stringify(results.map(result => [result.check, result.state, result.id ?? null, result.conclusion ?? null]));

// Substantial by default: routine only when every path, old and new, is exempt. Workflow
// files, the policy directory, OpenSpec change deltas and the `substantial` label override.
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
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
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
  let response;
  try { response = await context.gh('POST', `${context.base}/issues/${number}/comments`, { input: { body } }); }
  catch (error) { fail('POST_FAILED', `Could not post to pull request #${number}, so nothing was merged: ${error.message}`); }
  const parsed = SCHEMAS.posted.safeParse(response);
  if (!parsed.success) fail('POST_FAILED', `Posting to pull request #${number} gave an unexpected answer, so nothing was merged`);
  return parsed.data;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Slice trailers, as `specs status` reads them (lib/specs/landing.mjs): a squash keeps only the
// message it is given, so it is given the pull request's trailers rather than relying on gh to
// find them later in the description. Nothing the pull request doesn't carry is written.
const KEBAB = '[a-z0-9]+(?:-[a-z0-9]+)*';
const TRAILER_FORMAT = { 'OpenSpec-Change': new RegExp(`^(?:${KEBAB}:)?${KEBAB}$`), 'OpenSpec-Slice': new RegExp(`^${KEBAB}$`) };
const TRAILER_LINE = /^(OpenSpec-Change|OpenSpec-Slice):(.*)$/gm;
const COAUTHOR_LINE = /^Co-authored-by:[ \t]*(.*\S)[ \t]*$/gim;
const STRIPPED_LINE = /^(?:OpenSpec-Change|OpenSpec-Slice|Co-authored-by):.*(?:\n|$)/gim;
const unix = text => text.replace(/\r\n?/g, '\n');
function squashMessage(pr, compare) {
  if (compare.commits.length !== compare.total_commits) {
    incomplete(`#${pr.number}'s compare lists ${compare.commits.length} of its ${compare.total_commits} commits, so its slice trailers can't all be read`);
  }
  const sources = [...compare.commits.map(item => ({ where: `commit ${item.sha.slice(0, 7)}`, message: unix(item.commit.message) })),
    ...(pr.body ? [{ where: 'the description', message: unix(pr.body) }] : [])];
  const changes = [];
  const slices = [];
  const sliced = [];
  for (const source of sources) {
    const found = { 'OpenSpec-Change': [], 'OpenSpec-Slice': [] };
    for (const [, key, raw] of source.message.matchAll(TRAILER_LINE)) {
      const value = raw.trim();
      if (!TRAILER_FORMAT[key].test(value)) fail('TRAILERS_INVALID', `#${pr.number}'s ${source.where} has "${key}: ${value}", which isn't a ${key === 'OpenSpec-Slice' ? 'slice' : 'change'} id; correct it before landing`);
      if (!found[key].includes(value)) found[key].push(value);
    }
    for (const value of found['OpenSpec-Change']) if (!changes.includes(value)) changes.push(value);
    for (const value of found['OpenSpec-Slice']) if (!slices.includes(value)) slices.push(value);
    if (found['OpenSpec-Slice'].length) sliced.push({ where: source.where, changes: found['OpenSpec-Change'] });
  }
  if (!changes.length && !slices.length) return null;
  // A squash counts every slice it names for every change it names, so the commits and the
  // description naming slices must agree on their change.
  const orphan = sliced.find(item => !item.changes.length);
  if (orphan) fail('TRAILERS_CONFLICT', `#${pr.number}'s ${orphan.where} names a slice but no OpenSpec-Change`);
  const key = item => [...item.changes].sort().join(', ');
  const differing = sliced.find(item => key(item) !== key(sliced[0]));
  if (differing) {
    fail('TRAILERS_CONFLICT', `#${pr.number} names slices for different changes (${sliced[0].where}: ${key(sliced[0])}; ${differing.where}: ${key(differing)}); a squash would count each slice for every change, so deliver them in separate pull requests`);
  }
  // Co-authors as GitHub's own squash message credits them: the commits' Co-authored-by lines and
  // the authors of commits that aren't the pull request author's.
  const coauthors = new Map();
  const credit = value => { if (!coauthors.has(value.toLowerCase())) coauthors.set(value.toLowerCase(), value); };
  for (const item of compare.commits) {
    if (item.author?.login?.toLowerCase() !== pr.user.login.toLowerCase() && item.commit.author?.email) credit(`${item.commit.author.name} <${item.commit.author.email}>`);
    for (const [, value] of unix(item.commit.message).matchAll(COAUTHOR_LINE)) credit(value);
  }
  const list = compare.commits.map(item => unix(item.commit.message).replace(STRIPPED_LINE, '').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean).map(text => `* ${text}`).join('\n\n');
  const trailers = [...changes.map(value => `OpenSpec-Change: ${value}`), ...slices.map(value => `OpenSpec-Slice: ${value}`),
    ...[...coauthors.values()].map(value => `Co-authored-by: ${value}`)].join('\n');
  return { title: `${pr.title} (#${pr.number})`, body: list ? `${list}\n\n${trailers}` : trailers, trailers: { changes, slices } };
}

export async function landPullRequest(args, { env = process.env, cwd = process.cwd() } = {}) {
  const sha = args.sha.toLowerCase();
  const repo = await resolveRepo(args.repo, cwd, env);
  const context = { gh: ghRunner(env), base: `repos/${repo}` };
  const { read, list } = evidence(context);
  const number = args.number;

  // The repository, its default branch's tip, and the policy at that tip.
  const repository = await read('', SCHEMAS.repository);
  const branch = repository.default_branch;
  const tipOf = async () => (await read(`/git/ref/heads/${segments(branch)}`, SCHEMAS.ref)).object.sha;
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
  const allowedBy = settings => METHODS.filter(method => settings[`allow_${method === 'merge' ? 'merge_commit' : `${method}_merge`}`]);
  const allowed = allowedBy(repository);
  const method = args.method ?? allowed[0];
  if (!method || !allowed.includes(method)) fail('INVALID_INPUT', `${repo} allows ${allowed.join(', ') || 'no merge method'}${args.method ? `, not ${args.method}` : ''}`);

  // Evidence is read lazily, in the order the gates need it, so an earlier gate's refusal wins
  // over a later read's failure. Mergeability is computed lazily by GitHub, so an unknown one
  // is re-read.
  const once = read => { let promise; return (...args) => (promise ??= read(...args)); };
  const readPull = () => read(`/pulls/${number}`, SCHEMAS.pull);
  const settledPull = async () => {
    let pr = await readPull();
    for (let attempt = 0; pr.state === 'open' && pr.mergeable === null && attempt < 2; attempt++) { await sleep(2000); pr = await readPull(); }
    return pr;
  };
  const readQueue = async () => {
    let rules;
    try { rules = await context.gh('GET', `${context.base}/rules/branches/${segments(branch)}?per_page=100`, { paginate: true }); }
    catch (error) {
      // A private repository without a paid plan can't have rulesets, and GitHub says so.
      if (error.status === 403 && /upgrade to github pro|make this repository public/i.test(error.body?.message ?? error.message)) rules = [[]];
      else incomplete(`Could not read the rules for ${branch}: ${error.message}`);
    }
    rules = parse(z.array(z.array(SCHEMAS.rule)).min(1), rules, `${context.base}/rules/branches/${branch}`).flat();
    if (rules.some(rule => rule.type === 'merge_queue')) fail('MERGE_QUEUE_UNSUPPORTED', `${branch} requires a merge queue; pr land merges directly, so use the queue`);
    // Classic branch protection can require a queue too; only GraphQL shows whether one exists.
    const [owner, name] = repo.split('/');
    let queue;
    try { queue = await context.gh('POST', 'graphql', { fields: { query: MERGE_QUEUE_QUERY, o: owner, r: name, b: branch } }); }
    catch (error) { incomplete(`Could not read whether ${branch} has a merge queue: ${error.message}`); }
    queue = parse(SCHEMAS.mergeQueue, queue, 'graphql mergeQueue');
    if (queue.errors?.length) incomplete(`The merge queue read for ${branch} returned errors`);
    if (queue.data.repository.mergeQueue !== null) fail('MERGE_QUEUE_UNSUPPORTED', `${branch} has a merge queue; pr land merges directly, so use the queue`);
  };
  // The head SHA is pinned, so its file list is read once and shared by both passes.
  // The changed files come from the three-dot compare of the base with the pinned head SHA: the
  // same diff as the pull request's, but immutable, so a head that moves and returns while the
  // list is read can't substitute another commit's files. Its files are all on the first page.
  const readCompare = once(async base => {
    const path = `/compare/${base}...${sha}?per_page=100`;
    let body;
    try { body = await context.gh('GET', `${context.base}${path}`); } catch (error) { incomplete(`Could not read ${context.base}${path}: ${error.message}`); }
    const diff = parse(SCHEMAS.diff.extend({ files: z.array(SCHEMAS.file) }), body, `${context.base}${path}`);
    const seen = new Set();
    for (const file of diff.files) {
      if (seen.has(file.filename)) incomplete(`${context.base}${path} lists ${file.filename} twice`);
      seen.add(file.filename);
    }
    return diff;
  });
  const readRecords = async () => [await list(`/issues/${number}/comments?per_page=100`, SCHEMAS.comment, { unique: item => `comment ${item.id}` }),
    await list(`/pulls/${number}/reviews?per_page=100`, SCHEMAS.review, { unique: item => `review ${item.id}` })];

  const decideReview = (files, labels, comments, reviews) => {
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

  // Every gate on the pull request, its labels, checks and review, in order. It runs in full on
  // the initial evidence, and again in full on fresh reads immediately before the merge, so
  // nothing is checked only once. The refresh names movement as such, and compares the checks.
  const deadline = Date.now() + (args.timeout ?? 30) * 60000;
  const gate = async (phase, before) => {
    const initial = phase === 'initial';
    const pr = await settledPull();
    if (pr.state !== 'open') fail('NOT_OPEN', initial ? `#${number} is ${pr.merged ? 'already merged' : pr.state}` : `#${number} became ${pr.merged ? 'merged' : pr.state} before the merge`);
    if (pr.base.ref !== branch) fail(initial ? 'NOT_DEFAULT_BASE' : 'BASE_MOVED', initial ? `#${number} targets ${pr.base.ref}, not the default branch ${branch}` : `#${number} was retargeted to ${pr.base.ref}`);
    if (!initial) {
      // The default branch and the merge settings are read again, as everything else is.
      const settings = await read('', SCHEMAS.repository);
      if (settings.default_branch !== branch) fail('BASE_MOVED', `The default branch changed from ${branch} to ${settings.default_branch}; run pr land again`);
      if (!allowedBy(settings).includes(method)) fail('INVALID_INPUT', `${repo} no longer allows ${method} merges (now ${allowedBy(settings).join(', ') || 'none'}); run pr land again`);
      const tip = await tipOf();
      if (tip !== baseTip) fail('BASE_MOVED', `${branch} moved from ${baseTip} to ${tip} after the policy was read; run pr land again`);
    }
    await readQueue();
    if (pr.head.sha !== sha) fail(initial ? 'HEAD_MISMATCH' : 'HEAD_MOVED', initial ? `#${number}'s head is ${pr.head.sha}, not ${sha}` : `#${number}'s head moved to ${pr.head.sha}`);
    if (pr.mergeable === false || pr.mergeable_state === 'dirty') fail('CONFLICTING', `#${number} conflicts with ${branch}`);
    if (pr.mergeable !== true) incomplete(`GitHub has not computed whether #${number} can merge; try again shortly`);
    if (pr.changed_files > FILE_LIST_CAP) incomplete(`#${number} changes ${pr.changed_files} files; GitHub's compare lists at most ${FILE_LIST_CAP}`);
    const compare = await readCompare(pr.base.sha);
    const { files } = compare;
    if (files.length !== pr.changed_files) incomplete(`#${number} reports ${pr.changed_files} changed files but the compare of ${pr.base.sha.slice(0, 7)}...${sha.slice(0, 7)} lists ${files.length}`);

    let checks = [];
    if (!policy.expectedChecks.length) {
      if (args.noChecks === undefined) fail('CHECKS_NONE_EXPECTED', `${provenance.path} expects no checks; land with --no-checks "<alternative validation and link>"`);
    } else {
      let checkEvidence = await readChecks(context, policy, sha);
      for (;;) {
        checks = evaluateChecks(policy, checkEvidence);
        if (!initial && signature(checks) !== signature(before.checks)) {
          fail('CHECKS_CHANGED', 'The expected checks changed on the head before the merge; run pr land again', { before: before.checks.map(publicCheck), after: checks.map(publicCheck) });
        }
        const outcome = checksOutcome(checks);
        if (!outcome) break;
        const transient = ['CHECKS_PENDING', 'CHECKS_UNTRACEABLE'].includes(outcome.code);
        if (initial && transient && args.wait && Date.now() < deadline) {
          await sleep(Math.min(POLL_SECONDS * 1000, deadline - Date.now()));
          checkEvidence = await readChecks(context, policy, sha);
          continue;
        }
        fail(outcome.code, outcome.message + (transient && args.wait ? ' (timed out waiting)' : ''), { checks: checks.map(publicCheck) });
      }
    }
    // A squash merge's message carries the pull request's slice trailers; a conflict refuses
    // before anything is posted or merged.
    const message = method === 'squash' ? squashMessage(pr, compare) : null;
    return { pr, files, checks, message, ...decideReview(files, pr.labels, ...await readRecords()) };
  };

  const first = await gate('initial');
  const { pr } = first;
  const sameRepo = pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase();
  // Snapshotted before any merge, since repository auto-deletion could retarget them afterwards.
  const dependents = sameRepo ? (await list(`/pulls?state=open&base=${encodeURIComponent(pr.head.ref)}&per_page=100`, SCHEMAS.dependent, { unique: item => `pull request ${item.number}` }))
    .map(item => ({ number: item.number, base: item.base.ref })) : [];
  const checks = first.checks;
  let { substantial, review } = first;
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

  // The same gates, in full, on fresh reads immediately before the merge: movement, a record or
  // label that arrived while waiting, or a mergeability that changed refuses with no merge call.
  const url = review.url;
  let message;
  ({ substantial, review, message } = await gate('refresh', first));
  if (review.status === 'skipped') { if (skipPosted) review.url = url; else await postSkip(); }

  // The merge, pinned to the SHA. A rejection is final; a lost response is reconciled.
  let merged;
  try {
    const input = { sha, merge_method: method, ...(message ? { commit_title: message.title, commit_message: message.body } : {}) };
    const response = SCHEMAS.merge.safeParse(await context.gh('PUT', `${context.base}/pulls/${number}/merge`, { input }));
    if (!response.success) throw new GhError('Unexpected merge response');
    merged = { sha: response.data.sha, method };
  } catch (error) {
    if (error.status && error.status < 500) fail('MERGE_REJECTED', `A merge call was made, and GitHub rejected it (HTTP ${error.status}): ${error.body?.message ?? error.message}`);
    let seen;
    try { seen = parse(SCHEMAS.pull, await context.gh('GET', `${context.base}/pulls/${number}`), `${context.base}/pulls/${number}`); }
    catch (reread) { seen = null; error.message += `; re-reading failed: ${reread.message}`; }
    if (!(seen?.merged && seen.head.sha === sha && seen.merge_commit_sha)) {
      fail('MERGE_UNKNOWN', `A merge call was made and its response was lost (${error.message}); not retried. Seen: ${seen ? `state ${seen.state}, merged ${Boolean(seen.merged)}, head ${seen.head?.sha}` : 'nothing'}`,
        { seen: seen ? { state: seen.state, merged: Boolean(seen.merged), head: seen.head?.sha ?? null, mergeCommit: seen.merge_commit_sha ?? null } : null });
    }
    merged = { sha: seen.merge_commit_sha, method, reconciled: true };
  }
  if (message) merged.trailers = message.trailers;

  // After the merge: confirm, clean up only what is safe, and report dependents.
  const warnings = [];
  let cleanupIncomplete = false;
  // compare/<default>...<merge>: identical or behind means the default branch contains it.
  let contained = false;
  try {
    const path = `${context.base}/compare/${segments(branch)}...${merged.sha}`;
    const compare = parse(SCHEMAS.compare, await context.gh('GET', path), path);
    contained = ['identical', 'behind'].includes(compare.status);
    if (!contained) warnings.push(`${branch} does not contain the merge ${merged.sha} (${compare.status})`);
  } catch (error) { warnings.push(`Could not confirm ${branch} contains ${merged.sha}: ${error.message}`); }
  if (!contained) cleanupIncomplete = true;

  // The head ref goes only when it's this repository's, unmoved and unshared, and the merge is
  // confirmed. It is re-read immediately before the delete; GitHub has no conditional delete,
  // so the moment between that read and the delete is the remaining window.
  let branchResult;
  const ref = pr.head.ref;
  const headRef = async () => {
    // Only an HTTP 404 establishes absence; a malformed answer is an error, so the branch is kept.
    const path = `${context.base}/git/ref/heads/${segments(ref)}`;
    let body;
    try { body = await context.gh('GET', path); }
    catch (error) { if (error.status === 404) return null; throw error; }
    return parse(SCHEMAS.ref, body, path).object.sha;
  };
  if (!sameRepo) branchResult = { ref, kept: pr.head.repo ? `the head is in ${pr.head.repo.full_name}, not ${repo}` : 'the head repository was deleted' };
  else {
    try {
      const current = await headRef();
      if (current === null) branchResult = { ref, deleted: false, alreadyDeleted: true };
      else if (current !== sha) branchResult = { ref, kept: `it moved to ${current} after the merge` };
      else if (!contained) branchResult = { ref, kept: `${branch} isn't confirmed to contain the merge` };
      else {
        const sharing = (await list(`/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${ref}`)}&per_page=100`, SCHEMAS.pullNumber)).filter(item => item.number !== number);
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
      const path = `${context.base}/pulls/${dependent.number}`;
      const now = parse(SCHEMAS.pull, await context.gh('GET', path), path);
      dependentResults.push({ number: dependent.number, oldBase: dependent.base, newBase: now.base.ref, state: now.state, needsRevalidation: true });
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
