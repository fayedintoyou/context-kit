#!/usr/bin/env node
// `npm run skills-ref [-- <workspace>]`: checks rendered routing skills with the Agent
// Skills reference validator, pinned, when uv is installed. With a workspace, its own
// generated skills; without, a scratch workspace whose repositories need two shards.
// Optional: the end-to-end tests check the same rules without Python.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { initWorkspace } from '../lib/workspace.mjs';
import { renderGeneratedSkills as generatedSkills } from '../lib/install.mjs';

const exec = promisify(execFile);
const SKILLS_REF = 'skills-ref==0.1.1';

try { await exec('uvx', ['--version']); }
catch { process.stdout.write('skills-ref: uv is not installed; skipped (https://docs.astral.sh/uv/)\n'); process.exit(0); }

let root = process.argv[2] ? resolve(process.argv[2]) : null;
let scratch = null;
if (!root) {
  scratch = await mkdtemp(join(tmpdir(), 'context-kit-skills-ref-'));
  root = (await initWorkspace(join(scratch, 'workspace'), { addons: [] })).root;
  for (let i = 1; i <= 20; i++) {
    const id = `r${String(i).padStart(2, '0')}`;
    await writeFile(join(root, 'hubs/personal', `${id}.md`), `---\ntype: Repository\ntitle: "repo ${id} é🌊"\nresource: https://github.com/example/${id}\n` +
      `aliases: ["${id}-nickname-${'x'.repeat(30)}", "${id}-other"]\nkeywords: ["${id} topic"]\n---\n\n# repo ${id}\n`);
  }
}
let failed = false;
try {
  const skills = await generatedSkills(root);
  if (!skills.length) process.stdout.write(`skills-ref: ${root} has no generated skills\n`);
  for (const skill of skills) {
    try { process.stdout.write((await exec('uvx', ['--from', SKILLS_REF, 'agentskills', 'validate', skill.path])).stdout); }
    catch (error) { failed = true; process.stdout.write(`${error.stdout ?? ''}${error.stderr ?? error.message}\n`); }
  }
  const generated = await readdir(join(root, '.state', 'generated')).catch(() => []);
  if (scratch && generated.filter(name => name.startsWith('my-repos')).length < 2) { failed = true; process.stdout.write('skills-ref: expected the sample to shard\n'); }
} finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
