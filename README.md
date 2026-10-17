# Context Kit

Git-backed context and working methods for agents and people. A hub describes an
area of activity, points to relevant resources, and explains how to work there.
The same small format can describe personal projects or business domains spanning
many repositories. Sharing a format does not imply sharing data or credentials.

## Start here

- For personal working preferences, read [Working with agents](hubs/working-with-agents/README.md).
- For the preferred plan/review/implement loop, use [Independent review](skills/independent-review/SKILL.md).
- For a business-domain example, read [Fictional onboarding](examples/onboarding/README.md).
- For the manifest contract, read [Format](docs/format.md).
- For how behavior is tested, read [Testing](docs/testing.md).
- For the next increments, read [Next steps](docs/next.md).

## Try it

Requires Node.js 22 or newer. Install the pinned dependencies (the MCP SDK, Zod and
OpenSpec) with `npm ci`.

```sh
node bin/hub.mjs list
node bin/hub.mjs context personal/working-with-agents
node bin/hub.mjs validate
npm test
```

Output is JSON. `context` returns the explicitly listed documents in manifest
order. It does not perform semantic retrieval, execute instructions, fetch remote
sources, or include linked hubs automatically. Commands work from any directory.

## Your own workspace

Keep personal context outside this public checkout. `node bin/hub.mjs init <new-directory>`
creates a starter workspace. Select one with `--root <directory>` or
`CONTEXT_KIT_ROOT`; without either, commands read this checkout and capture is
refused. `capture <hub-id> <title>` writes stdin as a new unreviewed note in that
hub's `inbox/`, without committing. `search` and `context` include inbox notes
only with `--inbox`.

## Agents over MCP

`node bin/mcp.mjs --root <workspace>` serves the same operations to a local MCP
client over stdio. The root is fixed at startup. Capture is offered only with
`--allow-write`.

## Specs

`specs list|read <id>|audit` read a repository's canonical OpenSpec specs through
the pinned OpenSpec CLI. Pending change deltas are not canonical. Specs may also
live in a shared OpenSpec store used across repositories: `specs stores` lists the
stores hubs declare, and `--store <id>` reads one. A repository's own listing and
audit also show stores it references, kept separate. Audits are structural;
[audit-canonical-specs](skills/audit-canonical-specs/SKILL.md) describes the
evidence-based semantic review.

## Contribute

Update the relevant hub when work changes its understanding. Keep source links
near claims and distinguish an explicit preference from an agent inference in
plain language. Useful corrections belong here; routine execution logs do not.
Git diffs make changes reviewable. Use a PR when the collaboration calls for one.

Durable documents live in Git. Credentials and disposable execution state do
not. Live services remain authoritative for their own state; avoid a second copy
that quietly becomes stale.

Skills are repository artifacts, not globally installed skills. Agents can read
them by path; runtime-specific discovery and adapters can be added later.

This is a local starting point. Remote MCP over HTTP, Tailscale hosting, external service
adapters, and interactive pages are future increments.
