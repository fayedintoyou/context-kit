// Discovery checks against the real Claude Code and Codex CLIs: after agents install into an
// isolated home, a session started in a directory outside every checkout lists the routing
// skill with its description. Opt in with CONTEXT_KIT_HARNESS_SMOKE=1; each check runs only
// when its CLI is on PATH. Neither needs an account: Codex renders the model-visible prompt
// with `codex debug prompt-input`, and Claude Code's first request goes to a local stand-in
// for the API, which records it and answers with an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { access, constants, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const smoke = process.env.CONTEXT_KIT_HARNESS_SMOKE === '1';

async function onPath(command) {
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    try { await access(join(directory, command), constants.X_OK); return join(directory, command); } catch { /* Next. */ }
  }
  return null;
}

// A workspace with one registered repository, installed for one harness into an isolated
// machine whose PATH has no agent CLI (MCP registration is skipped; skills are what's checked).
async function installed(t, agent) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-discovery-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const env = { HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'),
    XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'), XDG_BIN_HOME: join(base, 'home/.local/bin'), PATH: `${bin}:/usr/bin:/bin` };
  await mkdir(env.HOME);
  await mkdir(env.CODEX_HOME);
  const workspace = join(base, 'workspace');
  const hub = (...args) => exec(process.execPath, [join(kit, 'bin/hub.mjs'), ...args], { env, cwd: base });
  await hub('init', workspace, '--addons', 'none');
  await writeFile(join(workspace, 'hubs/personal/studio.md'),
    '---\ntype: Repository\ntitle: the studio\nresource: https://github.com/example/site\naliases: [example site]\n---\n\nFictional.\n');
  const result = JSON.parse((await hub('--root', workspace, 'agents', 'install', '--agent', agent)).stdout);
  assert.ok(result.results.some(item => item.name === 'my-repos' && item.action === 'installed'), JSON.stringify(result.results));
  // A session's directory outside every checkout.
  const outside = join(base, 'elsewhere');
  await mkdir(outside);
  return { env, outside };
}

// spec: agent-installation / Routing skill is discovered
test('Codex started outside any checkout lists my-repos with a description naming the repository', { skip: !smoke && 'set CONTEXT_KIT_HARNESS_SMOKE=1' }, async t => {
  const codex = await onPath('codex');
  if (!codex) return t.skip('codex is not on PATH');
  const { env, outside } = await installed(t, 'codex');
  const { stdout } = await exec(codex, ['debug', 'prompt-input', 'hello'], { env: { ...env, PATH: `${dirname(codex)}${delimiter}${env.PATH}` }, cwd: outside, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const listing = JSON.parse(stdout).flatMap(item => item.content ?? []).map(part => part.text ?? '').join('\n');
  const entry = listing.split('\n').find(line => line.startsWith('- my-repos: '));
  assert.ok(entry, 'my-repos is in the skill listing');
  assert.match(entry, /the studio/);
});

// spec: agent-installation / Routing skill is discovered
test('Claude Code started outside any checkout lists my-repos with a description naming the repository', { skip: !smoke && 'set CONTEXT_KIT_HARNESS_SMOKE=1' }, async t => {
  const claude = await onPath('claude');
  if (!claude) return t.skip('claude is not on PATH');
  const { env, outside } = await installed(t, 'claude');
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; }).on('end', () => {
      requests.push(body);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'discovery check' } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const session = spawn(claude, ['-p', 'hello'], { cwd: outside, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...env, PATH: `${dirname(claude)}${delimiter}${env.PATH}`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'discovery-check' } });
  await new Promise(done => session.on('exit', done));
  const prompt = requests.map(body => { try { return JSON.stringify(JSON.parse(body)); } catch { return ''; } }).join('\n');
  const entry = prompt.split('\\n').find(line => line.startsWith('- my-repos: '));
  assert.ok(entry, 'my-repos is in the skill listing');
  assert.match(entry, /the studio/);
});
