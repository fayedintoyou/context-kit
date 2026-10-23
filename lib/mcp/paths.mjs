// Serving-machine paths (remote-access / Serving machine paths): over HTTP, every result field an
// operation declares as holding a path on this machine is renamed with the servingMachine prefix
// (root to servingMachineRoot, path to servingMachinePath), and the result names the machine.
// Declared, not pattern-matched, so relative paths such as a concept's README.md stay as they are.

// A field declaration is a dotted path; * is every item of an array or every value of an object.
// { field, local: true } renames the field only when its value names a local path: an absolute
// path or a file: URL (a mount's source may be either that or a remote URL).
const localValue = value => typeof value === 'string' && (value.startsWith('/') || /^file:/i.test(value));
const renamed = key => `servingMachine${key[0].toUpperCase()}${key.slice(1)}`;

// Renames the key in place, keeping the object's key order.
function rename(node, key) {
  const entries = Object.entries(node);
  for (const [name] of entries) delete node[name];
  for (const [name, value] of entries) node[name === key ? renamed(key) : name] = value;
}
function visit(node, parts, declaration, found) {
  if (!node || typeof node !== 'object') return;
  const [head, ...rest] = parts;
  for (const key of head === '*' ? Object.keys(node) : [head]) {
    if (!Object.hasOwn(node, key)) continue;
    if (rest.length) visit(node[key], rest, declaration, found);
    else if (!declaration.local || localValue(node[key])) { rename(node, key); found.labeled = true; }
  }
}
// A copy of result with each declared field renamed and, when any was, machine added first.
export function labelServingMachinePaths(result, declarations, machine) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const copy = structuredClone(result);
  const found = { labeled: false };
  for (const item of declarations) {
    const declaration = typeof item === 'string' ? { field: item } : item;
    visit(copy, declaration.field.split('.'), declaration, found);
  }
  return found.labeled ? { machine, ...copy } : copy;
}
