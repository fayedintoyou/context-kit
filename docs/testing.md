# Testing

Behavior is proven end to end and linked to the spec scenario it demonstrates.
`npm test` runs `test/spec-links.test.mjs`, which fails when a scenario in
`openspec/specs` or an in-flight change has no linked test, or a link names a
scenario that does not exist. `npm run spec-links` prints the full map.

## End-to-end first

Tests in `test/e2e/` drive the real interfaces: CLI subprocesses, an MCP SDK
client over stdio, and the pinned OpenSpec CLI against temporary repositories and
an isolated OpenSpec registry (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`). Shared
functionality, meaning anything reachable through both CLI and MCP, is tested
through those interfaces, not through internal modules.

Link a test to every scenario it demonstrates, directly above `test(`:

```js
// spec: context-workspaces / Capture and find
test('captured notes are searchable with inbox enabled', async t => { ... });
```

These need not be formal evals. A scenario's WHEN/THEN should read as the test's
setup and assertions.

## Unit tests, under strict rules

A unit test in `test/unit/` is allowed only when all of these hold:

- An end-to-end test cannot show the behavior reliably, such as a race between
  two reads or an input space too large to drive through a subprocess.
- It calls real project code. Fakes stand in only for external boundaries
  (OpenSpec, git, the file system), never for another project module.
- When it is a scenario's evidence, its link carries a reason:

```js
// spec: canonical-spec-audit / Referenced store changes during audit
// because: the change must land between the audit's two collections, which a subprocess cannot time reliably.
```

Do not add unit tests to cover implementation details an end-to-end test already
exercises. Prefer extending an end-to-end test.

## Manual checks

A scenario about an agent's reasoning rather than program behavior goes in
`test/manual-checks.md` with how it is verified. Keep this list short. A scenario
listed there is a candidate for a sharper, testable rewrite.
