# Proposal

## Why

When I tell an agent "my room has a new issue", it doesn't know what "my room" is
or where it lives, so it searches my home directory (and once found an unrelated
`room` path first). My hubs already describe my repositories as `type: Repository`
concepts with their GitHub URL, but nothing turns that into routing an agent can
act on, and nothing records where each repo is checked out on a given machine.

## What Changes

This is core Context Kit functionality, always on: every workspace, including one
created with `--addons none`, gets the `repos` operations and the routing skill.
It is not an addon that can be disabled.

- Repository concepts become a registry: a `Repository` concept's `resource` is its
  upstream (e.g. `https://github.com/fayedintoyou/room`) and an optional `aliases`
  list names what people call it ("the room", "fayelore.com"). The shared, git-tracked
  list is just these concepts, so it travels with the workspace to any machine or
  person.
- Each machine keeps its own local checkout paths in the workspace's untracked state
  (`.state/checkouts.json`), never in a hub, so another machine records its own.
- New CLI operations: `repos` (list repos with upstream, aliases and local path or
  `missing`), `repos locate <repo> <path>` (record an existing checkout after
  checking its git remote matches), `repos clone <repo> [<path>]` (clone the
  upstream and record it), and `repos scan <directory>` (one explicit, shallow pass
  that records checkouts whose remotes match). MCP gets read-only `list_repos`.
- `agents install` renders and installs a generated skill, `my-repos`, whose
  description names every registered repo and alias (so agents trigger on them),
  whose `metadata` carries the repo list as YAML (id, upstream, aliases, local path),
  and whose body says: go to the recorded path, never search the filesystem, clone
  or ask when it's missing, and register new repos.
- The generated skill stays current: `repos locate|clone|scan` re-render it for the
  agents it is installed in, and `agents status` reports it `stale` when the hubs'
  repositories or the local paths changed since it was rendered (e.g. after a
  `git pull` of the workspace); `agents install` reconciles it, and `repos sync`
  rebuilds it from the repository entries (titles, aliases, upstreams) on demand.
  In a workspace that is a git checkout, `agents install` also adds `post-merge` and
  `post-rewrite` hooks that run `repos sync`, so every pull keeps it current for
  anyone using Context Kit.

## Capabilities

### New Capabilities
- `repository-registry`: Repository concepts as a shared registry of upstreams and
  aliases, machine-local checkout paths, the `repos` operations, and the generated
  routing skill's content.

### Modified Capabilities
- `agent-installation`: the installer also installs, reconciles and reports
  generated skills (the routing skill), not only addon skills.
- `addons`: core now also provides the `repos` operations and the generated
  `my-repos` skill, so they work in a core-only workspace.

## Impact

- `lib/`: a new `repos.mjs` (registry, checkouts state, git remote matching, skill
  rendering); `install.mjs` gains generated skills; `operations.mjs`, `bin/hub.mjs`,
  `bin/mcp.mjs` gain the operations.
- `skills/context-kit` references and `docs/format.md` document the `Repository`
  fields; `help` gains a topic.
- No new dependencies. Uses the `git` CLI for remotes and clones.
- My workspace: `personal/projects/room` gets `aliases`; after upgrading I run
  `repos scan ~` once (or `locate`) and `agents install`.
