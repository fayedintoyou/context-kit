# Hubs

Git-backed context and working methods for agents and people. A hub describes an
area of activity, points to relevant resources, and explains how to work there.
The same small format can describe personal projects or business domains spanning
many repositories. Sharing a format does not imply sharing data or credentials.

## Start here

- For personal working preferences, read [Working with agents](hubs/working-with-agents/README.md).
- For the preferred plan/review/implement loop, use [Independent review](skills/independent-review/SKILL.md).
- For a business-domain example, read [Fictional onboarding](examples/onboarding/README.md).
- For the manifest contract, read [Format](docs/format.md).
- For the next increments, read [Next steps](docs/next.md).

## Try it

Requires Node.js 22 or newer. No dependencies or installation required.

```sh
node bin/hub.mjs list
node bin/hub.mjs context personal/working-with-agents
node bin/hub.mjs validate
npm test
```

Output is JSON. `context` returns the explicitly listed documents in manifest
order. It does not perform semantic retrieval, execute instructions, fetch remote
sources, or include linked hubs automatically. Commands work from any directory.

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

This is a local starting point. Remote MCP, Tailscale hosting, external service
adapters, and interactive pages are future increments.
