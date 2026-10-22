import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const kit = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const fixtures = join(kit, 'test/e2e/fixtures/maps');
const golden = await readFile(join(fixtures, 'alerts.mermaid'), 'utf8');
const escapingGolden = await readFile(join(fixtures, 'escaping.mermaid'), 'utf8');
const marker = '<!-- context-kit:diagram:start';
const endMarker = '<!-- context-kit:diagram:end -->';

// A temporary copy of the fictional Pigeon repository (OpenSpec specs and maps/alerts.md),
// with an isolated OpenSpec registry, driven through the CLI and an MCP SDK client.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'context-kit-maps-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
    OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', OPENSPEC_NO_UPDATE_CHECK: '1' };
  delete env.CONTEXT_KIT_ROOT;
  const root = join(base, 'pigeon');
  await cp(join(fixtures, 'pigeon'), root, { recursive: true });
  const cli = async (...args) => {
    const parse = text => (text.trim() ? JSON.parse(text) : undefined);
    try {
      const { stdout } = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), '--root', root, ...args], { env });
      return { code: 0, json: parse(stdout), stdout };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, json: parse(error.stdout), stdout: error.stdout, error: parse(error.stderr)?.error };
    }
  };
  let client;
  const mcp = async (name, args = {}) => {
    if (!client) {
      client = new Client({ name: 'maps-test', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(kit, 'bin/mcp.mjs'), '--root', root], env, stderr: 'pipe' }));
      t.after(() => client.close());
    }
    const result = await client.callTool({ name, arguments: args });
    return result.isError ? { error: JSON.parse(result.content[0].text).error } : result.structuredContent;
  };
  const mapFile = join(root, 'maps/alerts.md');
  const specFile = join(root, 'openspec/specs/alerts/spec.md');
  const original = await readFile(mapFile, 'utf8');
  // Rewrites the alerts map: edit receives the map file's text and returns the new text.
  const editMap = async edit => writeFile(mapFile, edit(await readFile(mapFile, 'utf8')));
  // Checks over the CLI and MCP, which must report the same; returns the CLI result.
  const checkBoth = async name => {
    const result = await cli('maps', 'check', ...(name === undefined ? [] : [name]));
    assert.deepEqual(await mcp('check_map', name === undefined ? {} : { map: name }), result.json ?? { error: result.error });
    return result;
  };
  return { base, root, env, cli, mcp, checkBoth, mapFile, specFile, original, editMap };
}

// A map file around a yaml map block.
const mapText = (title, block) => `---\ntype: BehaviorMap\ntitle: ${title}\n---\n\n# ${title}\n\n\`\`\`yaml map\n${block.trim()}\n\`\`\`\n`;
const report = (result, name = 'alerts') => result.json.maps.find(map => map.map === name);
const codes = entries => entries.map(entry => entry.code);
const withoutDiagram = text => text.slice(0, text.indexOf(marker)) + text.slice(text.indexOf(endMarker) + endMarker.length);

// spec: behavior-sources / Unknown source
test('listing behaviors from an unknown source fails naming the supported sources', async t => {
  const { cli, mcp, checkBoth } = await fixture(t);
  const listed = await cli('maps', 'behaviors', '--source', 'jira');
  assert.equal(listed.code, 1);
  assert.equal(listed.error.code, 'INVALID_INPUT');
  assert.match(listed.error.message, /jira.*supported: openspec/);
  assert.deepEqual((await mcp('list_behaviors', { source: 'jira' })).error, listed.error);
});

// spec: behavior-sources / List OpenSpec behaviors
test('OpenSpec behaviors are the canonical requirements and scenarios, not pending deltas', async t => {
  const { root, cli, mcp, checkBoth } = await fixture(t);
  const change = join(root, 'openspec/changes/quiet-hours');
  await mkdir(join(change, 'specs/alerts'), { recursive: true });
  await writeFile(join(change, 'proposal.md'), '# Quiet hours\n\n## Why\nPeople sleep.\n\n## What Changes\n- Quiet hours.\n');
  await writeFile(join(change, 'specs/alerts/spec.md'), '## ADDED Requirements\n\n### Requirement: Quiet hours\nThe app SHALL hold alerts during quiet hours.\n\n' +
    '#### Scenario: Held overnight\n- **WHEN** a teammate posts during quiet hours\n- **THEN** nothing alerts the user until morning\n');
  const listed = await cli('maps', 'behaviors', '--source', 'openspec');
  assert.equal(listed.code, 0, JSON.stringify(listed.error));
  assert.deepEqual(listed.json.source, { kind: 'openspec' });
  assert.deepEqual(listed.json.behaviors.map(({ id, kind, parent }) => [id, kind, parent]), [
    ['alerts / Room post without a mention', 'requirement', undefined],
    ['alerts / Quiet dot for a room post', 'scenario', 'alerts / Room post without a mention'],
    ['alerts / Mention badge', 'requirement', undefined],
    ['alerts / Badge counts mentions', 'scenario', 'alerts / Mention badge'],
    ['alerts / Badge clears when read', 'scenario', 'alerts / Mention badge']]);
  for (const behavior of listed.json.behaviors) {
    assert.match(behavior.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(behavior.file, 'openspec/specs/alerts/spec.md');
    assert.ok(behavior.title && behavior.text);
  }
  assert.ok(!JSON.stringify(listed.json).includes('Held overnight'));
  assert.deepEqual(await mcp('list_behaviors', { source: 'openspec' }), listed.json);
});

// spec: behavior-sources / Undeclared store
test('OpenSpec behaviors from a store nobody declares or references are refused', async t => {
  const { cli, mcp, checkBoth } = await fixture(t);
  const listed = await cli('maps', 'behaviors', '--source', 'openspec', '--store', 'elsewhere');
  assert.equal(listed.error.code, 'UNKNOWN_STORE');
  assert.match(listed.error.message, /elsewhere/);
  assert.equal((await mcp('list_behaviors', { source: 'openspec', store: 'elsewhere' })).error.code, 'UNKNOWN_STORE');
});

// spec: behavior-sources / Fingerprint follows the text
test('a fingerprint survives line-ending changes and follows edits to the text', async t => {
  const { cli, mcp, specFile } = await fixture(t);
  const fingerprints = async () => {
    const listed = await cli('maps', 'behaviors', '--source', 'openspec');
    assert.deepEqual(await mcp('list_behaviors', { source: 'openspec' }), listed.json);
    return Object.fromEntries(listed.json.behaviors.map(item => [item.id, item.fingerprint]));
  };
  const first = await fingerprints();
  const second = await fingerprints();
  await writeFile(specFile, (await readFile(specFile, 'utf8')).replace(/\n/g, '\r\n'));
  const third = await fingerprints();
  await writeFile(specFile, (await readFile(specFile, 'utf8')).replace('the room shows a badge reading 2', 'the room shows a badge reading two'));
  const fourth = await fingerprints();
  const id = 'alerts / Badge counts mentions';
  assert.equal(second[id], first[id]);
  assert.equal(third[id], first[id]);
  assert.notEqual(fourth[id], first[id]);
  assert.equal(fourth['alerts / Badge clears when read'], first['alerts / Badge clears when read']);
  // The requirement's text includes its scenarios, so it changes with them.
  assert.notEqual(fourth['alerts / Mention badge'], first['alerts / Mention badge']);
});

// spec: behavior-maps / List maps
test('maps list returns the repository maps with title, source and scope', async t => {
  const { root, cli, mcp, checkBoth } = await fixture(t);
  await writeFile(join(root, 'maps/sign-in.md'), mapText('Signing in', `
version: 1
source: { kind: openspec }
scope: [sign-in]
nodes:
  - { id: open, kind: start, label: You open Pigeon }
transitions: []`));
  await writeFile(join(root, 'maps/README.md'), '# Maps\n\nNot a map: its name is not kebab-case.\n');
  const listed = await cli('maps', 'list');
  assert.deepEqual(listed.json.maps.map(({ map, title, source, scope }) => ({ map, title, source, scope })), [
    { map: 'alerts', title: 'When a teammate posts', source: { kind: 'openspec' }, scope: ['alerts'] },
    { map: 'sign-in', title: 'Signing in', source: { kind: 'openspec' }, scope: ['sign-in'] }]);
  assert.deepEqual(await mcp('list_maps'), listed.json);
});

// spec: behavior-maps / Unknown map
test('checking or rendering a map with no file fails with UNKNOWN_MAP', async t => {
  const { cli, mcp, checkBoth } = await fixture(t);
  const checked = await cli('maps', 'check', 'sign-out');
  assert.equal(checked.error.code, 'UNKNOWN_MAP');
  assert.match(checked.error.message, /sign-out/);
  assert.equal((await cli('maps', 'render', 'sign-out')).error.code, 'UNKNOWN_MAP');
  assert.deepEqual((await mcp('check_map', { map: 'sign-out' })).error, checked.error);
});

// spec: behavior-maps / Unknown key
test('an unknown key in a map is an error naming the node and the key', async t => {
  const { cli, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('label: The room shows a number badge', 'label: The room shows a number badge\n    colour: red'));
  const checked = await checkBoth('alerts');
  assert.equal(checked.code, 1);
  assert.equal(checked.json.valid, false);
  const map = report(checked);
  assert.equal(map.map, 'alerts');
  assert.equal(map.errors.length, 1);
  assert.equal(map.errors[0].code, 'schema');
  assert.equal(map.errors[0].element, 'badge');
  assert.match(map.errors[0].message, /colour/);
});

// spec: behavior-maps / Unreachable state
test('a state nothing reaches from the start is a structure error', async t => {
  const { cli, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('  - { id: seen, kind: end', '  - id: muted\n    label: The room stays quiet\n    cites: [alerts / Quiet dot for a room post]\n  - { id: seen, kind: end'));
  const map = report(await checkBoth());
  assert.equal(map.valid, false);
  assert.deepEqual(map.errors.map(({ code, element }) => [code, element]), [['structure', 'muted']]);
  assert.match(map.errors[0].message, /muted is not reachable from the start/);
});

// spec: behavior-maps / Valid map
test('a valid map checks valid with no errors over CLI and MCP alike', async t => {
  const { cli, mcp, checkBoth } = await fixture(t);
  const checked = await checkBoth('alerts');
  assert.equal(checked.code, 0);
  assert.equal(checked.json.valid, true);
  assert.deepEqual(checked.json.maps, [{ map: 'alerts', valid: true, errors: [], warnings: [] }]);
  assert.deepEqual(await mcp('check_map', { map: 'alerts' }), checked.json);
  assert.deepEqual((await checkBoth()).json, checked.json);
});

// spec: behavior-maps / Uncited state
test('a state must cite a behavior; a choice need not', async t => {
  const { cli, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('    cites: [alerts / Mention badge]\n', ''));
  const map = report(await checkBoth('alerts'));
  assert.deepEqual(map.errors.map(({ code, element }) => [code, element]), [['uncited_state', 'badge']]);
});

// spec: behavior-maps / Unknown citation
test('a citation naming no behavior is an error naming the state and the citation', async t => {
  const { cli, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('cites: [alerts / Mention badge]', 'cites: [alerts / Badge on mention]'));
  const map = report(await checkBoth('alerts'));
  assert.deepEqual(map.errors.map(({ code, element }) => [code, element]), [['unknown_citation', 'badge']]);
  assert.match(map.errors[0].message, /alerts \/ Badge on mention/);
});

// spec: behavior-maps / Ambiguous citation
test('a citation naming two scenarios is rejected as ambiguous, naming both requirements', async t => {
  const { cli, specFile, editMap, checkBoth } = await fixture(t);
  const quiet = '\n#### Scenario: Quiet hours\n- **WHEN** a teammate posts at night\n- **THEN** nothing alerts the user until morning\n';
  const spec = await readFile(specFile, 'utf8');
  await writeFile(specFile, spec.replace('\n### Requirement: Mention badge', `${quiet}\n### Requirement: Mention badge`) + quiet);
  await editMap(text => text.replace('cites: [alerts / Mention badge]', 'cites: [alerts / Quiet hours]'));
  const map = report(await checkBoth('alerts'));
  assert.deepEqual(map.errors.map(({ code, element }) => [code, element]), [['ambiguous_citation', 'badge']]);
  assert.match(map.errors[0].message, /alerts \/ Quiet hours/);
  assert.match(map.errors[0].message, /alerts \/ Room post without a mention/);
  assert.match(map.errors[0].message, /alerts \/ Mention badge/);
});

// spec: behavior-maps / Uncovered scenario
test('a scenario in scope that nothing cites is an uncovered warning on a valid map', async t => {
  const { cli, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('cites: [alerts / Mention badge]', 'cites: [alerts / Badge counts mentions]'));
  const checked = await checkBoth('alerts');
  assert.equal(checked.code, 0);
  const map = report(checked);
  assert.equal(map.valid, true);
  assert.deepEqual(map.warnings.map(({ code, element }) => [code, element]), [['uncovered', 'alerts / Badge clears when read']]);
});

// spec: behavior-maps / Scope narrowed to a requirement
test('a scope narrowed to one requirement covers only its scenarios', async t => {
  const { cli, mapFile, checkBoth } = await fixture(t);
  const block = scope => `
version: 1
source: { kind: openspec }
scope: [${scope}]
nodes:
  - { id: mentioned, kind: start, label: Someone mentions you }
  - id: badge
    label: The room shows a number badge
    cites: [alerts / Badge counts mentions, alerts / Badge clears when read]
  - { id: seen, kind: end, label: You've seen it }
transitions:
  - { from: mentioned, to: badge }
  - { from: badge, to: seen }`;
  await writeFile(mapFile, mapText('Mentions', block('alerts / Mention badge')));
  const narrowed = report(await checkBoth('alerts'));
  assert.deepEqual([narrowed.valid, narrowed.errors, narrowed.warnings], [true, [], []]);
  await writeFile(mapFile, mapText('Mentions', block('alerts')));
  assert.deepEqual(report(await checkBoth('alerts')).warnings.map(({ code, element }) => [code, element]),
    [['uncovered', 'alerts / Quiet dot for a room post']]);
});

// spec: behavior-maps / Label reads as code
test('a label that reads as code is an error naming the state and the token', async t => {
  const { cli, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('label: The room shows a number badge', 'label: Sets `unreadCount` on the room'));
  const map = report(await checkBoth('alerts'));
  assert.deepEqual(map.errors.map(({ code, element }) => [code, element]), [['label', 'badge']]);
  assert.match(map.errors[0].message, /unreadCount/);
});

// spec: behavior-maps / Allowed term
test('terms in the map vocabulary are exempt from the label lint', async t => {
  const { cli, mapFile, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('label: The room shows a number badge', 'label: A GitHub issue opens').replace('vocabulary: [DM, "@mention"]', 'vocabulary: [GitHub, DM, "@mention"]'));
  const allowed = report(await checkBoth('alerts'));
  assert.deepEqual(allowed.errors, []);
  assert.ok((await readFile(mapFile, 'utf8')).includes('to: badge, when: A DM or an @mention'));
  await editMap(text => text.replace('vocabulary: [GitHub, DM, "@mention"]', 'vocabulary: [DM, "@mention"]'));
  const flagged = report(await checkBoth('alerts'));
  assert.deepEqual(flagged.errors.map(({ code, element }) => [code, element]), [['label', 'badge']]);
  assert.match(flagged.errors[0].message, /"GitHub"/);
});

// spec: behavior-maps / Strict check in CI
test('--strict fails on warnings while the report stays the same', async t => {
  const { cli, mcp, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('cites: [alerts / Mention badge]', 'cites: [alerts / Badge counts mentions]'));
  const plain = await cli('maps', 'check');
  const strict = await cli('maps', 'check', '--strict');
  assert.equal(plain.code, 0);
  assert.equal(strict.code, 1);
  assert.equal(strict.error, undefined);
  assert.equal(strict.stdout, plain.stdout);
  assert.deepEqual(codes(report(plain).warnings), ['uncovered']);
  assert.deepEqual(await mcp('check_map', {}), plain.json);
});

// spec: behavior-maps / Render a map
test('rendering a map gives the same Mermaid diagram every time, over CLI and MCP', async t => {
  const { cli, mcp, checkBoth } = await fixture(t);
  const first = await cli('maps', 'render', 'alerts');
  const second = await cli('maps', 'render', 'alerts', '--format', 'mermaid');
  assert.equal(first.json.diagram, golden);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(await mcp('render_map', { map: 'alerts' }), first.json);
  assert.deepEqual(await mcp('render_map', { map: 'alerts', format: 'mermaid' }), first.json);
  // One shape per kind: start, choice, state, end; choice exits carry their when.
  assert.match(golden, /n_posted\(\("A teammate posts"\)\)/);
  assert.match(golden, /n_what_kind\{"What kind of post is it\?"\}/);
  assert.match(golden, /n_dot\("A quiet dot appears next to the room"\)/);
  assert.match(golden, /n_seen\(\["You've seen it"\]\)/);
  assert.match(golden, /n_what_kind -->\|"A DM or an @mention"\| n_badge/);
});

// spec: behavior-maps / Render as JSON
test('JSON rendering lists nodes and transitions in file order with resolved citations', async t => {
  const { cli, mcp, checkBoth } = await fixture(t);
  const rendered = await cli('maps', 'render', 'alerts', '--format', 'json');
  assert.equal(rendered.code, 0, JSON.stringify(rendered.error));
  const { json } = rendered;
  assert.deepEqual([json.map, json.title, json.source, json.scope], ['alerts', 'When a teammate posts', { kind: 'openspec' }, ['alerts']]);
  assert.deepEqual(json.nodes.map(({ id, kind, label }) => [id, kind, label]), [
    ['posted', 'start', 'A teammate posts'], ['what-kind', 'choice', 'What kind of post is it?'],
    ['dot', 'state', 'A quiet dot appears next to the room'], ['badge', 'state', 'The room shows a number badge'], ['seen', 'end', "You've seen it"]]);
  assert.deepEqual(json.transitions.map(({ from, to, when }) => [from, to, when]), [
    ['posted', 'what-kind', null], ['what-kind', 'dot', 'A post in a room, no @mention'], ['what-kind', 'badge', 'A DM or an @mention'],
    ['dot', 'seen', null], ['badge', 'seen', null]]);
  const behaviors = new Map((await cli('maps', 'behaviors', '--source', 'openspec')).json.behaviors.map(item => [item.id, item]));
  const badge = behaviors.get('alerts / Mention badge');
  assert.deepEqual(json.nodes[3].cites, [{ id: badge.id, kind: 'requirement', title: 'Mention badge', fingerprint: badge.fingerprint }]);
  assert.deepEqual(json.nodes[0].cites, []);
  assert.equal((await cli('maps', 'render', 'alerts', '--format', 'json')).stdout, rendered.stdout);
  assert.deepEqual(await mcp('render_map', { map: 'alerts', format: 'json' }), json);
});

// spec: behavior-maps / Outdated diagram
test('an outdated diagram is flagged, and --write replaces only the generated block', async t => {
  const { cli, mapFile, original, editMap, checkBoth } = await fixture(t);
  assert.ok(original.includes(golden.trimEnd()), 'the fixture carries its written diagram');
  assert.deepEqual(report(await checkBoth('alerts')).warnings, []);
  await editMap(text => text.replace('label: The room shows a number badge', 'label: A number badge appears on the room'));
  const edited = await readFile(mapFile, 'utf8');
  const outdated = report(await checkBoth('alerts'));
  assert.equal(outdated.valid, true);
  assert.deepEqual(outdated.warnings.map(({ code, element }) => [code, element]), [['diagram_outdated', 'diagram']]);
  const written = await cli('maps', 'render', 'alerts', '--write');
  assert.deepEqual(written.json, { map: 'alerts', file: 'maps/alerts.md', written: true });
  const after = await readFile(mapFile, 'utf8');
  assert.equal(withoutDiagram(after), withoutDiagram(edited));
  assert.ok(after.includes('n_badge("A number badge appears on the room")'));
  assert.deepEqual(report(await checkBoth('alerts')).warnings, []);
  assert.deepEqual((await cli('maps', 'render', 'alerts', '--write')).json.written, false);
  assert.equal(await readFile(mapFile, 'utf8'), after);

  // Without a generated block, --write adds one after the map block and keeps the prose.
  await writeFile(mapFile, withoutDiagram(original).replace('```\n\n\n\nThe badge', '```\n\nThe badge'));
  const bare = await readFile(mapFile, 'utf8');
  await cli('maps', 'render', 'alerts', '--write');
  const added = await readFile(mapFile, 'utf8');
  assert.equal(added, original);
  assert.notEqual(bare, added);

  // A CRLF map keeps its line endings: its diagram is current, and rewriting changes nothing.
  await writeFile(mapFile, original.replace(/\n/g, '\r\n'));
  assert.deepEqual(report(await checkBoth('alerts')).warnings, []);
  assert.equal((await cli('maps', 'render', 'alerts', '--write')).json.written, false);
  await writeFile(mapFile, withoutDiagram(original).replace('```\n\n\n\nThe badge', '```\n\nThe badge').replace(/\n/g, '\r\n'));
  await cli('maps', 'render', 'alerts', '--write');
  assert.equal(await readFile(mapFile, 'utf8'), original.replace(/\n/g, '\r\n'));
});

// spec: behavior-maps / Label reads as code
test('labels with Mermaid or HTML markup are rejected in plain words, over CLI and MCP', async t => {
  const { checkBoth, cli, editMap } = await fixture(t);
  const payloads = [["A %%{init: {'theme': 'dark'}}%%", '%%{init'], ['A %%{wrap}%%', '%%{wrap}%%'], ['<img src=x onerror=alert(1)>', '<img'],
    ['A badge a:::red', 'a:::red'], ['See [[the room]]', '[[the'], ['Posted --> seen', '-->'], ['A {curly} badge', '{curly}']];
  for (const [label, token] of payloads) {
    await editMap(text => text.replace(/label: (?:The room shows a number badge|'.*')\n/, `label: '${label.replace(/'/g, "''")}'\n`));
    const map = report(await checkBoth('alerts'));
    assert.ok(map.errors.some(error => error.code === 'label' && error.element === 'badge' && error.message.includes(`"${token}"`) && /diagram or web markup/.test(error.message)),
      `${label}: ${JSON.stringify(map.errors)}`);
    assert.equal((await cli('maps', 'render', 'alerts')).error.code, 'INVALID_INPUT');
  }
});

// spec: behavior-maps / Render a map
test('labels with characters Mermaid treats specially render as plain text', async t => {
  const { root, cli, mcp, checkBoth } = await fixture(t);
  await writeFile(join(root, 'maps/escaping.md'), await readFile(join(fixtures, 'escaping.md'), 'utf8'));
  const checked = report(await checkBoth('escaping'), 'escaping');
  assert.deepEqual([checked.valid, checked.errors, checked.warnings], [true, [], []]);
  const rendered = await cli('maps', 'render', 'escaping');
  assert.equal(rendered.json.diagram, escapingGolden);
  assert.deepEqual(await mcp('render_map', { map: 'escaping' }), rendered.json);
  // Inside every label: no raw %, :, ;, &, #-codes of its own, <, >, or statement words.
  for (const label of escapingGolden.match(/"[^"]*"/g)) {
    assert.doesNotMatch(label.slice(1, -1).replace(/#(?:quot|\d+);/g, ''), /[%:;&#<>"]|\b(?:click|style|class|end)\b/i, label);
  }
  assert.match(escapingGolden, /n_price\{"Is it 50#37; off, or full price\?"\}/);
});

test('the skill and help examples pass maps check', async t => {
  const { cli, mapFile, checkBoth } = await fixture(t);
  for (const file of ['skills/behavior-map/SKILL.md', 'skills/context-kit/references/maps.md']) {
    const example = (await readFile(join(kit, file), 'utf8')).match(/````markdown\n([\s\S]*?)````/)[1];
    await writeFile(mapFile, example);
    const checked = report(await cli('maps', 'check', 'alerts', '--strict'));
    assert.deepEqual([checked.valid, checked.errors, checked.warnings], [true, [], []], file);
  }
});

test('writing refuses a map with errors, and map files are never followed through symlinks', async t => {
  const { base, root, env, cli, mcp, mapFile, editMap, checkBoth } = await fixture(t);
  await editMap(text => text.replace('cites: [alerts / Mention badge]', 'cites: [alerts / Badge on mention]').replace('label: The room shows a number badge', 'label: Something new'));
  const before = await readFile(mapFile, 'utf8');
  const refused = await cli('maps', 'render', 'alerts', '--write');
  assert.equal(refused.error.code, 'INVALID_INPUT');
  assert.match(refused.error.message, /maps check alerts/);
  assert.equal(await readFile(mapFile, 'utf8'), before);
  assert.equal((await mcp('write_map_diagram', { map: 'alerts' })).error.code, 'UNKNOWN_OPERATION');
  const implicit = await exec(process.execPath, [join(kit, 'bin/hub.mjs'), 'maps', 'render', 'alerts', '--write'], { cwd: root, env }).catch(error => error);
  assert.equal(JSON.parse(implicit.stderr).error.code, 'WRITE_DISABLED');

  await writeFile(join(base, 'outside.md'), '---\ntype: BehaviorMap\ntitle: Outside\n---\n\nNot in this repository.\n');
  await symlink(join(base, 'outside.md'), join(root, 'maps/outside.md'));
  const listed = (await cli('maps', 'list')).json.maps.find(map => map.map === 'outside');
  assert.deepEqual([listed.title, listed.source], [null, null]);
  assert.match(listed.problem, /symlink/);
  assert.match(report(await cli('maps', 'check', 'outside'), 'outside').errors[0].message, /symlink/);
  assert.equal((await cli('maps', 'render', 'outside', '--write')).error.code, 'INVALID_INPUT');
  assert.ok((await readFile(join(base, 'outside.md'), 'utf8')).endsWith('Not in this repository.\n'));

  // A symlinked maps/ directory is never read, whether listing or naming a map in it.
  await cp(join(root, 'maps'), join(base, 'elsewhere'), { recursive: true });
  await rm(join(root, 'maps'), { recursive: true });
  await symlink(join(base, 'elsewhere'), join(root, 'maps'));
  assert.equal((await cli('maps', 'list')).error.code, 'PATH_ESCAPE');
  assert.equal((await checkBoth('alerts')).error.code, 'PATH_ESCAPE');
  assert.equal((await cli('maps', 'render', 'alerts', '--write')).error.code, 'PATH_ESCAPE');
});
