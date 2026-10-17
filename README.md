# Context Kit

Git-backed context and working methods for agents and people. A hub describes an
area of activity, points to relevant resources, and explains how to work there.
The same small format can describe personal projects or business domains spanning
many repositories. Sharing a format does not imply sharing data or credentials.

## Start here

- Personal context belongs in your own workspace (see [Your own workspace](#your-own-workspace)); this repository ships only the tool and a fictional example.
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
node bin/hub.mjs context example/onboarding
node bin/hub.mjs validate
npm test
```

Output is JSON. `context` returns the explicitly listed documents in manifest
order. It does not perform semantic retrieval, execute instructions, fetch remote
sources, or include linked hubs automatically. Commands work from any directory.

## Your own workspace

This repository is the core tooling. Your context lives in your own workspace, an
instance of the core kept in its own (usually private) repository:

```sh
node bin/hub.mjs init ~/context          # starter hub plus a package.json pinning this core
cd ~/context && npm install
npm run hub -- list                      # the core's CLI, rooted at this workspace
npm run mcp                              # the core's MCP server, rooted at this workspace
```

`init` pins this core's repository at its current commit when the checkout is
clean (or pass `--kit <npm-spec>`). Upgrade an instance deliberately by changing
that dependency. Bundled skills are referenced as `kit:<name>`, so the instance
uses the core's copies rather than forks.

`capture <hub-id> <title>` writes stdin as a new unreviewed note in that hub's
`inbox/`, without committing. `search` and `context` include inbox notes only with
`--inbox`. Outside an instance, select a workspace with `--root <directory>` or
`CONTEXT_KIT_ROOT`; with neither, commands read this checkout and capture is
refused.

## Agents over MCP

`npm run mcp` in an instance, or `node bin/mcp.mjs --root <workspace>`, serves the same operations to a local MCP
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
