import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { localFile, readText, fail } from '../files.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
// The package exports only its entry point, so locate package.json from dist/index.js.
const packageRoot = resolve(dirname(require.resolve('@fission-ai/openspec')), '..');
const packageInfo = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
if (packageInfo.name !== '@fission-ai/openspec') throw new Error('Unexpected OpenSpec package layout');
const executable = resolve(packageRoot, packageInfo.bin.openspec);
export const storeIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/);
const rootSchema = z.object({ path: z.string(), source: z.string(), store_id: z.string().optional() });
const listSchema = z.object({ root: rootSchema, specs: z.array(z.object({ id: idSchema, requirementCount: z.number().int().nonnegative() })) });
const readSchema = z.object({ root: rootSchema, id: idSchema, title: z.string(), overview: z.string(),
  requirements: z.array(z.object({ name: z.string(), text: z.string(), scenarios: z.array(z.object({ name: z.string(), rawText: z.string() })) })) });
const changesSchema = z.object({ root: rootSchema, changes: z.array(z.object({ name: z.string(),
  completedTasks: z.number().int().nonnegative(), totalTasks: z.number().int().nonnegative() }).passthrough()) });
// OpenSpec omits totals when a change has no spec deltas (skip_specs).
const archiveSchema = z.object({ root: rootSchema, archive: z.object({ change: z.string(), archivedAs: z.string(),
  specsUpdated: z.boolean(), totals: z.record(z.string(), z.number()).default({}) }).passthrough() });
const issueSchema = z.object({ severity: z.string(), code: z.string(), message: z.string() });
const contextSchema = z.object({ root: rootSchema, members: z.array(z.object({ role: z.string(), id: z.string(),
  path: z.string().optional(), status: z.array(issueSchema) })) });
const validateSchema = z.object({ root: rootSchema, version: z.literal('1.0'),
  items: z.array(z.object({ id: idSchema, type: z.literal('spec'), valid: z.boolean(), issues: z.array(z.unknown()) })) });

// A repo source reads specs that live beside its code; a store source reads a registered
// OpenSpec store shared across repositories. Either way the resolved root must match.
export function openSpec(root, { store } = {}) {
  if (store !== undefined && !storeIdSchema.safeParse(store).success) fail('INVALID_INPUT', 'Invalid store id');
  const selector = store === undefined ? [] : ['--store', store];
  const source = store === undefined ? { kind: 'repo', path: root } : { kind: 'store', storeId: store };
  let resolvedRoot;
  async function run(args, schema, allowValidationFailure = false) {
    let output;
    try {
      output = await exec(process.execPath, [executable, ...args, ...selector], { cwd: root, timeout: 15000,
        maxBuffer: 1024 * 1024, env: { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' } });
    } catch (error) {
      if (!allowValidationFailure || error.code !== 1 || !error.stdout) {
        const detail = (error.stderr || '').trim().split('\n').find(Boolean) || (error.killed ? 'timed out' : `exit ${error.code}`);
        fail('ADAPTER_FAILED', `OpenSpec ${args[0]} failed: ${detail}`);
      }
      output = error;
    }
    let data;
    try { data = schema.parse(JSON.parse(output.stdout)); }
    catch { fail('ADAPTER_FORMAT', 'OpenSpec returned an unexpected JSON shape'); }
    if (store === undefined) {
      if (data.root.source !== 'nearest' || await realpath(data.root.path) !== await realpath(root)) {
        fail('WRONG_SPEC_ROOT', 'OpenSpec resolved a different root than the selected repository');
      }
    } else if (data.root.source !== 'store' || data.root.store_id !== store) {
      fail('WRONG_SPEC_ROOT', `OpenSpec did not resolve the selected store: ${store}`);
    }
    const path = await realpath(data.root.path);
    if (resolvedRoot && resolvedRoot !== path) fail('WRONG_SPEC_ROOT', 'OpenSpec root changed between commands');
    resolvedRoot = path;
    return data;
  }
  return {
    name: 'openspec', version: packageInfo.version, source,
    get root() { return resolvedRoot ?? (store === undefined ? root : undefined); },
    async list() {
      const data = await run(['list', '--specs', '--json'], listSchema);
      return data.specs.map(spec => ({ id: spec.id, requirementCount: spec.requirementCount }));
    },
    async read(id) {
      if (!idSchema.safeParse(id).success) fail('INVALID_INPUT', 'Invalid spec id');
      if (!(await this.list()).some(spec => spec.id === id)) fail('UNKNOWN_SPEC', `No canonical spec: ${id}`);
      const data = await run(['show', id, '--type', 'spec', '--json', '--no-interactive'], readSchema);
      if (data.id !== id) fail('ADAPTER_FORMAT', 'OpenSpec returned the wrong spec');
      const path = 'openspec/specs/' + id + '/spec.md';
      const content = await readText(await localFile(resolvedRoot, path));
      return { id, title: data.title, purpose: data.overview, path, content, requirements: data.requirements };
    },
    // Stores the selected repository declares under `references:`. OpenSpec follows one
    // level only and omits self-references; unregistered or unhealthy stores carry issues.
    async references() {
      if (store !== undefined) fail('INVALID_INPUT', 'References are read from a repository, not a store');
      const data = await run(['context', '--json'], contextSchema);
      return data.members.filter(member => member.role === 'referenced_store').map(member => {
        const issues = member.status.map(({ severity, code, message }) => ({ severity, code, message }));
        const available = storeIdSchema.safeParse(member.id).success && member.path !== undefined && !issues.length;
        return { storeId: member.id, status: available ? 'available' : 'warning', issues };
      });
    },
    // Active changes with OpenSpec's own task counts.
    async changes() {
      const data = await run(['list', '--json'], changesSchema);
      return data.changes.map(({ name, completedTasks, totalTasks }) => ({ name, completedTasks, totalTasks }));
    },
    async archive(name) {
      if (!storeIdSchema.safeParse(name).success) fail('INVALID_INPUT', 'Invalid change name');
      const { archive } = await run(['archive', name, '--yes', '--json'], archiveSchema);
      if (archive.change !== name) fail('ADAPTER_FORMAT', 'OpenSpec archived the wrong change');
      return { name, archivedAs: archive.archivedAs, specsUpdated: archive.specsUpdated, totals: archive.totals };
    },
    async validate() {
      const data = await run(['validate', '--specs', '--strict', '--json', '--no-interactive'], validateSchema, true);
      return { strict: true, valid: data.items.length > 0 && data.items.every(item => item.valid), items: data.items };
    },
  };
}
