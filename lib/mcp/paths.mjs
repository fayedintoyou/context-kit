// Serving-machine paths (remote-access / Serving machine paths): over HTTP, every result field an
// operation declares as holding a path on this machine is renamed with the servingMachine prefix
// (root to servingMachineRoot, path to servingMachinePath), and the result names the machine.
// Declared, not pattern-matched, so relative paths such as a concept's README.md stay as they are.

// A field declaration is a dotted path; * is every item of an array or every value of an object.
// { field, local: true } renames the field only when its value names a local path: an absolute
// path or a file: URL (a mount's source may be either that or a remote URL).
// { field, text: true } is free text that may quote local paths, such as a remedy command or a
// reason: it keeps its key, and each known local path in it becomes the placeholder of its label,
// <servingMachineCheckout> or <servingMachineHome>/.claude/skills, so the text stays readable.
const localValue = value => typeof value === 'string' && (value.startsWith('/') || /^file:/i.test(value));
const renamed = key => `servingMachine${key[0].toUpperCase()}${key.slice(1)}`;
// A declaration that would overwrite a key is a programming error, never a silent override.
const collision = message => Object.assign(new Error(`Serving-machine labeling: ${message}`), { code: 'INTERNAL' });

// Renames the key in place, keeping the object's key order.
function rename(node, key) {
  if (Object.hasOwn(node, renamed(key))) throw collision(`${renamed(key)} is already in the result`);
  const entries = Object.entries(node);
  for (const [name] of entries) delete node[name];
  for (const [name, value] of entries) node[name === key ? renamed(key) : name] = value;
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A known path where it ends: at the end, before a separator, quote, space or closing
// punctuation, or before a full stop that ends the sentence.
const occurrence = value => new RegExp(`${escape(value)}(?=$|[/\\s'"\`),;:]|\\.(?:\\s|$))`, 'g');
function substitute(text, known) {
  let result = text;
  for (const { value, label } of known) result = result.replace(occurrence(value), `<${label}>`);
  return result;
}
function visit(node, parts, declaration, found) {
  if (!node || typeof node !== 'object') return;
  const [head, ...rest] = parts;
  for (const key of head === '*' ? Object.keys(node) : [head]) {
    if (!Object.hasOwn(node, key)) continue;
    if (rest.length) visit(node[key], rest, declaration, found);
    else if (declaration.text) { if (typeof node[key] === 'string') found.texts.push([node, key]); }
    else if (!declaration.local || localValue(node[key])) {
      if (typeof node[key] === 'string') found.known.push({ value: node[key].replace(/^file:\/\//i, ''), label: renamed(key) });
      rename(node, key);
      found.labeled = true;
    }
  }
}
// A copy of result with each declared field renamed and, when any was, machine added first.
// known lists other local paths ({ value, label }) that text fields may quote, such as recorded
// checkouts or the home directory; the declared fields' own values are added to it.
export function labelServingMachinePaths(result, declarations, machine, known = []) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (Object.hasOwn(result, 'machine')) throw collision('machine is already in the result');
  const copy = structuredClone(result);
  const found = { labeled: false, known: [], texts: [] };
  for (const item of declarations) {
    const declaration = typeof item === 'string' ? { field: item } : item;
    visit(copy, declaration.field.split('.'), declaration, found);
  }
  // Longest first, so a checkout inside the home directory is named as the checkout.
  const paths = [...found.known, ...known].filter(({ value }) => typeof value === 'string' && value.length > 1 && value.startsWith('/'))
    .map(({ value, label }) => ({ value: value.replace(/\/+$/, ''), label })).sort((a, b) => b.value.length - a.value.length);
  for (const [node, key] of found.texts) {
    const text = substitute(node[key], paths);
    if (text !== node[key]) { node[key] = text; found.labeled = true; }
  }
  return found.labeled ? { machine, ...copy } : copy;
}
