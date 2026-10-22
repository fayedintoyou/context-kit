// Behavior sources: the kit-owned boundary over where a repository's behavioral truth lives.
// A source is chosen by name from a fixed table and lists behaviors with a source-native ID,
// a kind, a title, the text, the file it comes from and a fingerprint of the normalized text.
// Sources only read files and the pinned OpenSpec CLI; nothing in a repository is executed.
import { createHash } from 'node:crypto';
import { fail } from '../files.mjs';

// NFKC, line endings unified, trailing whitespace per line and trailing blank lines dropped,
// so a fingerprint is the same across runs, machines and editors.
export function normalize(text) {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/u, '')).join('\n').replace(/\n+$/, '');
}
export const fingerprint = text => createHash('sha256').update(normalize(text), 'utf8').digest('hex').slice(0, 12);

// The adapter's own failures can carry a line of OpenSpec's stderr; behavior results never do.
async function adapted(read) {
  try { return await read(); }
  catch (error) {
    if (error.code === 'ADAPTER_FAILED') fail('ADAPTER_FAILED', 'OpenSpec could not read the specs; run openspec validate --specs in the repository for details');
    throw error;
  }
}

// OpenSpec: canonical requirements as `<capability> / <requirement>` and scenarios as
// `<capability> / <scenario>`, read through the pinned adapter (canonical specs only, never
// pending change deltas). A requirement's text is its statement followed by its scenarios,
// so editing a scenario changes the fingerprint of the requirement that holds it.
function openspecSource(spec, selection) {
  const capabilities = () => adapted(async () => (await spec.list()).map(item => item.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  async function read(capability) {
    const data = await adapted(() => spec.read(capability));
    const behaviors = [];
    for (const requirement of data.requirements) {
      const id = `${capability} / ${requirement.name}`;
      const text = [requirement.text, ...requirement.scenarios.map(scenario => `#### Scenario: ${scenario.name}\n${scenario.rawText}`)].join('\n\n');
      behaviors.push({ id, kind: 'requirement', title: requirement.name, text, file: data.path, fingerprint: fingerprint(text) });
      for (const scenario of requirement.scenarios) {
        behaviors.push({ id: `${capability} / ${scenario.name}`, kind: 'scenario', title: scenario.name, text: scenario.rawText,
          file: data.path, fingerprint: fingerprint(scenario.rawText), parent: id });
      }
    }
    return behaviors;
  }
  return {
    name: 'openspec',
    describe: () => ({ kind: 'openspec', ...(selection.store === undefined ? {} : { store: selection.store }) }),
    get root() { return spec.root; },
    capabilities,
    read,
  };
}

const sources = { openspec: openspecSource };
export const SOURCE_NAMES = Object.keys(sources);

// specSource is operations' store-rule-checked OpenSpec reader, passed in so the rule that
// decides which stores may be read lives in one place.
export async function openSource(selection, specSource) {
  if (!Object.hasOwn(sources, selection.kind)) fail('INVALID_INPUT', `Unknown behavior source: ${selection.kind} (supported: ${SOURCE_NAMES.join(', ')})`);
  return sources[selection.kind](await specSource(selection.store), selection);
}

// Behavior IDs are `<capability> / <title>`; capability IDs never contain " / ".
export const capabilityOf = id => (id.includes(' / ') ? id.slice(0, id.indexOf(' / ')) : id);

export async function listBehaviors(selection, specSource) {
  const source = await openSource(selection, specSource);
  const behaviors = [];
  for (const capability of await source.capabilities()) behaviors.push(...await source.read(capability));
  return { root: source.root, source: source.describe(), behaviors };
}
