# Context Kit

Git-backed context and working methods for agents and people. A hub describes an
area of activity, points to relevant resources, and explains how to work there.
Each hub is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(OKF) v0.2 bundle, so other OKF tools can read it, and every document carries OKF
provenance, trust and freshness signals.
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

`context-kit help` lists help topics (`help <topic>` shows one); agents get the
same help through the `help` MCP tool and the core `context-kit` skill.

Output is JSON. `context` returns a hub's curated starting documents in manifest
order. To explore further, browse progressively: `browse <hub-id> [directory]`
lists one directory (concepts with OKF type, title, description and trust, plus
subdirectories and the index), and `read <hub-id> <concept-id>` opens one concept
with its outgoing links classified, so you follow only what you need. `search`
covers every concept. It does not perform semantic retrieval, execute instructions, fetch remote
sources, or include linked hubs automatically. Commands work from any directory.

## Install

Context Kit is a core plus optional addons, installed into your agents from your
own workspace (an instance of this core, usually a private repository):

```sh
npx -y github:fayedintoyou/context-kit setup ~/context --addons reflect,review --agent claude,codex
```

`setup` creates the workspace pinned to a core commit, runs `npm install`, and
installs it into Claude Code and Codex: the enabled addons' skills go into each
agent's skill directory, and one MCP server for the workspace is registered
through each agent's own CLI.

| Addon | Gives you |
|---|---|
| `core` (always) | OKF hubs, progressive `browse`/`read`, `search`, `capture`, skills |
| `specs` | OpenSpec specs from repositories and shared stores, structural audits, gardening signals, change progress and review skills |
| `reflect` | Turn a conversation's learnings into reviewed edits on skills and hubs |
| `review` | Independent plan and output review |

Your own skills are addons too: put `addons/<name>/addon.json` (`name`,
`description`, `skills`) and `addons/<name>/skills/<skill>/SKILL.md` in your
workspace and enable it. Enabled addons live in `context-kit.json`; `--addons
none` gives just the core.

From inside a workspace:

```sh
npm run agents -- install [--agent claude,codex] [--scope user|project] [--link] [--allow-write]
npm run agents -- status
npm run agents -- uninstall
```

`install` is a sync: rerun it after changing addons or upgrading the core, and it
adds, updates and removes what it installed. It never overwrites or removes a skill
it did not create or that you edited (`--force` overrides). `--link` symlinks
skills so edits to one you are iterating on apply immediately. Project scope puts
skills in the project and keeps the MCP server private to it (Codex needs
`--global-mcp`). Restart your agent after changing addons so its MCP server
reloads them.

## Your own workspace

`init <new-directory>` creates a workspace without installing it. Your context
lives there, never in this toolkit: it pins this core in `package.json`, so
upgrades are deliberate, and bundled skills are referenced as `kit:<name>`.

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

`specs list|read <id>|audit|garden` read a repository's canonical OpenSpec specs through
the pinned OpenSpec CLI. Pending change deltas are not canonical. Specs may also
live in a shared OpenSpec store used across repositories: `specs stores` lists the
stores hubs declare, and `--store <id>` reads one. A repository's own listing and
audit also show stores it references, kept separate. Audits are structural;
[audit-canonical-specs](skills/audit-canonical-specs/SKILL.md) describes the
evidence-based semantic review. `specs garden` reports size, history, locks,
lexical overlap, trace and optional taxonomy checks;
[garden-canonical-specs](skills/garden-canonical-specs/SKILL.md) investigates those
signals and proposes one maintenance change for review.

Large changes can be delivered in slices: `slices.yaml` in the change plans
independently mergeable PRs, and commits carry `OpenSpec-Change`/`OpenSpec-Slice`
trailers. `specs status|next|slice|reconcile <change>` derive progress, hand out
work packets for ready slices and list facts for reconciliation;
[slice-change](skills/slice-change/SKILL.md) writes the plan and
[reconcile-change](skills/reconcile-change/SKILL.md) checks what was built. See
[docs/delivery.md](docs/delivery.md).

Finished changes are archived after merge, not in PRs: the reusable
[openspec workflow](.github/workflows/openspec.yml) runs `specs archive --ready`
on every push to the default branch, tests the result and pushes the archive, and
fails pull requests that edit `openspec/specs/` directly.

## Contribute

Update the relevant hub when work changes its understanding. Keep source links
near claims and distinguish an explicit preference from an agent inference in
plain language. Useful corrections belong here; routine execution logs do not.
Git diffs make changes reviewable. Use a PR when the collaboration calls for one.

Durable documents live in Git. Credentials and disposable execution state do
not. Live services remain authoritative for their own state; avoid a second copy
that quietly becomes stale.

Skills are repository artifacts, not globally installed skills. Hubs declare
them (`kit:<name>` for skills bundled here), `skills` lists them, and
`read-skill <hub> <reference> [--file <path>]` reads a skill or its reference
files. The MCP server also offers every declared skill as a prompt, so a client
can invoke it directly; Claude Code shows them as `/mcp__<server>__<skill>`.

Bundled skills: `context-kit` (help for using Context Kit, always installed), `independent-review` (plan and output review),
`audit-canonical-specs` (evidence-based spec audits), `garden-canonical-specs`
(spec maintenance proposals), `slice-change` and `reconcile-change` (delivering a
change in slices) and `reflect` (three
parallel reviewers turn a conversation's learnings into proposed edits on skills
and hub knowledge, applied only after approval). Improve them with `reflect`
itself.

This is a local starting point. Remote MCP over HTTP, Tailscale hosting, external service
adapters, and interactive pages are future increments.
