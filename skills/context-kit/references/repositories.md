# Repositories

Your hubs list your repositories, and each machine knows where they are checked
out. Agents then go straight to the right directory when you mention one ("my room
has a new issue") instead of searching for it.

## Registering a repository

A repository is any concept with `type: Repository`. Its `resource` is the upstream
and `aliases` lists what you call it:

```markdown
---
type: Repository
title: the room
description: My personal website.
resource: https://github.com/fayedintoyou/room
aliases: [room, fayelore.com]
---
```

`validate` rejects a Repository without a git upstream, `aliases` that is not a
list of names, and an alias or title used by two repositories. The list is shared
through the workspace's git like any other concept.

## Checkouts on this machine

Paths are never stored in a hub. Each machine records its own in the workspace's
untracked `.state/checkouts.json`:

- `repos` lists every repository with its upstream, aliases and local `path`, or
  `missing`. Over MCP: `list_repos`.
- `repos locate <repo> <path>` records an existing checkout. `<repo>` is an id,
  title, alias or the upstream's name. The checkout must have a remote that is the
  upstream (SSH or HTTPS, any case).
- `repos clone <repo> [<path>]` clones the upstream, by default into `~/<name>`,
  and records it.
- `repos scan <directory>` records every matching checkout in the directory or its
  immediate subdirectories, e.g. `repos scan ~` on a new machine.

Recording and cloning are CLI-only; agents run them when you ask.

## The my-repos skill

When any repositories are registered, core generates a `my-repos` skill and
`agents install` installs it. Its description names every repository and alias, so
agents pick it up when you mention one. Its body gives each upstream and local path
and tells agents not to search the filesystem. `repos locate`, `clone` and `scan`
update installed copies at once.

The skill is generated from the Repository concepts; don't edit it. After changing
them (a new repository, new aliases, a pull), run `repos sync`. It rebuilds the
skill's description, metadata and list and updates every installed copy, without
re-registering MCP servers. Until then `agents status` reports the skill `stale`.
