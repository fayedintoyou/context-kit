import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fail } from '../files.mjs';
import { normalizeUpstream } from '../repos.mjs';
import { storeIdSchema } from './openspec.mjs';
import { deltas } from './deltas.mjs';

export const PARTIES_FILE = 'openspec/parties.yaml';
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// A store's parties and contracts, validated against its canonical specs and the specs its
// active changes add. Callers pass the canonical listing they already hold.
export async function loadParties(root, specs) {
  const invalid = message => fail('INVALID_CONFIG', `${PARTIES_FILE}: ${message}`);
  let content;
  try { content = await readFile(join(root, PARTIES_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { parties: [], contracts: [] }; throw error; }
  let data;
  try { data = parse(content) ?? {}; }
  catch (error) { invalid(`not valid YAML: ${error.message}`); }
  // An empty key (`contracts:`) parses as null and means none.
  const { parties, contracts, ...rest } = isMap(data) ? data : { rest: data };
  const [partyMap, contractMap] = [parties ?? {}, contracts ?? {}];
  if (Object.keys(rest).length || !isMap(partyMap) || !isMap(contractMap)) invalid('expected only parties and contracts maps');
  const owners = new Map();
  const declared = Object.entries(partyMap).map(([name, upstream]) => {
    if (!storeIdSchema.safeParse(name).success) invalid(`invalid party name ${name}; use lowercase words joined by hyphens`);
    // normalizeUpstream throws on malformed file: URLs; any failure is the file's problem.
    let key = null;
    try { key = typeof upstream === 'string' ? normalizeUpstream(upstream) : null; } catch {}
    if (!key) invalid(`party ${name} upstream is not a git URL: ${typeof upstream === 'string' ? upstream : `a ${Array.isArray(upstream) ? 'list' : upstream === null ? 'null' : typeof upstream === 'object' ? 'map' : typeof upstream}`}`);
    if (owners.has(key)) invalid(`parties ${owners.get(key)} and ${name} share upstream ${upstream}`);
    owners.set(key, name);
    return { name, upstream: upstream.trim() };
  });
  const names = new Set(declared.map(party => party.name));
  const canonical = new Set(specs.map(spec => spec.id));
  const added = new Set((await deltas(root)).filter(delta => !delta.date && delta.operations.some(operation => operation.op === 'ADDED'))
    .map(delta => delta.spec));
  const listed = Object.entries(contractMap).map(([spec, members]) => {
    if (!Array.isArray(members) || members.some(member => typeof member !== 'string')) invalid(`contract ${spec} must list party names`);
    const unknown = members.findIndex(member => !names.has(member));
    if (unknown >= 0) invalid(`contract ${spec} names undeclared party "${members[unknown]}"`);
    if (new Set(members).size < 2) invalid(`contract ${spec} needs at least two parties`);
    if (!canonical.has(spec) && !added.has(spec)) invalid(`contract ${spec} names no canonical spec or spec added by an active change`);
    return { spec, parties: members, status: canonical.has(spec) ? 'canonical' : 'proposed' };
  });
  return { parties: declared, contracts: listed };
}
