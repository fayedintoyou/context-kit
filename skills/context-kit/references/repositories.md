# Repositories

Your hubs list your repositories, and each machine knows where they are checked
out. Agents then go straight to the right directory when you mention one ("my room
has a new issue") instead of searching for it.

## Registering a repository

Add it to any hub: your personal one, or a team hub that several people keep in
Git together, so everyone's agents know the team's repositories.

```sh
npm run hub -- repos add personal/projects https://github.com/me/room --title "the room" --alias room,fayelore.com
cd ~/code/billing && npm --prefix ~/context run hub -- repos add team/platform --path .   # upstream from git
```

`repos add` writes a draft Repository concept (a person promotes it), lists it in
the hub's index, and rebuilds the `my-repos` skill. With `--path` it reads the
upstream from the checkout's `origin` and records where it is on this machine. It
refuses an upstream, alias or concept that is already in use. Agents can do the same
over MCP with `add_repo` when the server allows writes; they never record paths.
Then fill in the concept with what someone needs to work on the repository.

A repository is any concept with `type: Repository`. Its `resource` is the upstream,
`aliases` lists what you call it, and optional `keywords` lists topics you might
mention instead of a name:

```markdown
---
type: Repository
title: the room
description: My personal website.
resource: https://github.com/fayedintoyou/room
aliases: [room, fayelore.com]
keywords: [personal site, portfolio]
---
```

Keywords only help agents pick the `my-repos` skill; `repos locate` and `clone`
don't accept them, and two repositories may share one.

`validate` rejects a Repository without a git upstream, `aliases` that is not a
list of names, `keywords` that is not a list of strings, an alias or title used by
two repositories, a keyword that is another repository's title or alias, and names
over their bounds: a title over 80 characters, an alias or keyword over 60. A
blank title counts as none, so the repository is named by its first alias, or by
its id; an id over 80 characters with no usable title or alias fails `validate`,
`repos sync` and `agents install` until you give it one. `repos add` refuses names
over the bounds, including a title that defaults to a long upstream name. The list
is shared through the workspace's git like any other concept.

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
`agents install` installs it. Agents choose skills by their descriptions, so the
description names your repositories, and agents pick it up when you mention one
from any directory. Its body gives each upstream, alias, keyword and local path
and tells agents not to search the filesystem. `repos locate`, `clone` and `scan`
update installed copies at once.

A skill description holds at most 1,024 characters, counted as Unicode code points,
fixed text included. The description names every repository first, by its title
(or its first alias when the title is over its bound, or else its id) with its
first alias. Then it adds names in rounds while they fit: every repository's second
alias in id order, then every third, and so on, then keywords the same way. A name
that doesn't fit is skipped, and a shorter one after it may still fit. `repos sync`
and `agents install` list what was skipped under `skipped`, by repository id;
nothing is dropped silently, and the body still lists every name. To get a skipped
name into the description, shorten names or drop ones nobody uses.

When even those first entries don't fit one description, the skill splits into
the fewest shards that hold them, `my-repos`, `my-repos-2` and so on. Repositories
stay in id order, and the split is balanced so every shard has about the same
room left for further names. Each shard's description says `(1 of 2)` and its body lists
its own repositories and names the other shards. Shards are installed, updated and
removed like the skill itself, so removing repositories folds them back into one.

Generated skills use only the standard Agent Skills frontmatter keys (`name`,
`description` and `metadata`). `npm run skills-ref` in the toolkit checks rendered
skills with the reference validator when `uv` is installed.

The skill is generated from the Repository concepts; don't edit it. After changing
them (a new repository, new aliases, a pull), run `repos sync`. It rebuilds the
skill's description, metadata and list and updates every installed copy, without
re-registering MCP servers. Until then `agents status` reports the skill `stale`.

You rarely need to: when the workspace is a git checkout, `agents install` adds
`post-merge` and `post-rewrite` hooks that run `repos sync` after every pull, so
repositories someone else registered reach your agents automatically. The hooks
are per machine (they live in `.git/hooks`, not in the workspace), so each machine
gets them from its own `agents install`.
