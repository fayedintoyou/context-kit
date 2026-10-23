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
stores only the upstream's clean form: userinfo, a query and a fragment are dropped
(SSH keeps a well-known login such as `git@`, and scp-like `host:path` form), and the result's `removed` says when. It
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

`validate` rejects a Repository without a git upstream, a `resource` carrying
credentials, a query or a fragment (without echoing it), `aliases` that is not a
list of names, `keywords` that is not a list of strings, an alias or title used by
two repositories, a keyword that is another repository's title or alias, and names
over their bounds: a title over 80 characters, an alias or keyword over 60. A
blank or absent title counts as none (never the upstream's name), so the repository is named by its first alias, or by
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
- `repos scan <directory> [--depth <n>]` records every matching checkout of a
  repository with no recorded path, in the directory and its subdirectories down to
  `<n>` levels (default 1, at most 6; 0 is the directory alone). It never enters
  hidden directories, `node_modules`, a symlink or a checkout below the directory, and never
  replaces a recorded path that still exists. The directory itself is searched even
  when it is a checkout, such as a home directory kept in git, unless it is a
  registered repository's checkout: that one is recorded, not entered.
- `repos setup` sets up a new machine, below.
- `repos which [<path>]` says which repository a path belongs to, below.
- `repos open <repo> [<subpath>]` opens a repository to start work on it, below.

Recording and cloning are CLI-only; agents run them when you ask.

### Which repository is this

`repos which [<path>]` (default: the current directory) finds the innermost git
checkout containing the path, after resolving symlinks, and matches its remotes
against the registered repositories. It reports the repository (`id`, `title`,
`hub`, `concept` and `upstream` as host/owner/name, never the remote's URL), the
checkout's top as `checkout`, the path inside it as `relative`, the `recorded`
path, and a `status`:

- `recorded`: this is the recorded checkout.
- `worktree`: a linked worktree whose main checkout (`main`) is the recorded one.
  A worktree of a bare repository, or one whose main isn't a checkout, gives
  `main: null` and a `reason`.
- `unrecorded`: another checkout of it, such as a second clone. Nothing is recorded;
  run `repos locate` if it should be.

Only the innermost checkout counts: inside a submodule that is another registered
repository, that repository is reported; inside an unrelated repository nested in
one of yours, none is, never the enclosing one. When remotes match several
repositories, the one `origin` points to wins; otherwise `status` is `ambiguous`
with the `candidates` in id order. A path in a hub also names the `hub`. A path
that isn't one of your repositories reports `repository: null` and exits 0.
Over MCP it is the `which_repo` tool, which takes an absolute path and is offered
only over stdio (see `remote`).

### Opening a repository

`repos open <repo> [<subpath>]` is the one call to start work on a repository. It
resolves `<repo>` (an id, title, alias or the upstream's name) to the checkout this
machine recorded, ignoring the current directory, and returns, read-only:

- `status`: `located`, or `missing` when no checkout is recorded or the recorded
  directory is gone or no longer a checkout's top. `missing` gives a `reason` and
  `next`, the exact `repos locate` and `repos clone` commands, and no
  instruction files or tree. It never clones, records or searches.
- `repository` (`id`, `title`, `aliases`, `hub`, `concept`): the concept to read.
- `resolution`: how it resolved. `matched` is the field (`id`, `title`, `alias`
  or `upstreamName`); `concept` and `alternateIds`, the upstream (its clean form),
  and the `path` from this machine's record (`source: machine`).
- `instructions`: `path`, `size`, `sha256` and `tracked` for each regular file
  named exactly `AGENTS.md` or `CLAUDE.md` at the root and in each directory down to
  the subpath, outermost first, tracked by git or not. A symlinked one is not read;
  `warnings` names it.
- `tree`: the bootstrap, built from the git index, so ignored and untracked files
  never appear. Paths at depth 1 and 2 below the root or subpath in code-point
  order (`entries`, directories ending in `/`), at most 150, with each listed
  directory's tracked-file count in `counts` and `files` the total.
- `truncated`: `null`, or what didn't fit, each with `next`, where to get the rest.
  Any result is at most 8 KiB as compact JSON (`JSON.stringify` without spacing,
  about 2k tokens), counted for one copy of the result: the CLI prints it
  indented, and MCP carries it as text and as `structuredContent`. The
  resolution and the root's instruction pointers are always kept, each string
  bounded and clipped with a trailing `…`. Then, in order: the concept summary is
  bounded (`repository`: aliases cut from the end), the tree is cut from the end
  (`tree`: `omitted`, the `first` left out, and `next`: a `git ls-files` command
  that lists every tracked file below the tree's root the way Context Kit reads
  them, plus `repos open <id> <directory>` for the first omitted directory), and
  deeper instruction pointers go innermost first (`instructions`: `omitted` and
  `from`, the first directory whose `AGENTS.md` and `CLAUDE.md` you then read
  yourself, down to `path`). `fields` lists every value clipped or withheld; a
  path or command too long to give whole is `null`, never cut.

The subpath is a directory relative to the checkout's root without `.`, `..` or
`.git` segments, backslashes, control characters or a leading `/`, at most 200
characters (`INVALID_PATH`). It is matched in Unicode NFC against the tracked
paths, and caselessly when the checkout's file system ignores case, so an NFD or
other-case spelling (which macOS accepts) opens the same directory, reported in
the index's spelling. One holding no tracked files is `UNKNOWN_PATH`; a name that
two tracked spellings share once compared that way is ambiguous (`INVALID_PATH`).
Every read walks from the checkout's real root and stops at any symlink below it:
a symlinked subpath directory fails with `PATH_ESCAPE`. Git is read only through
`rev-parse` and `ls-files -z --stage`, with every `GIT_*` variable removed, global
and system config, hooks and fsmonitor off, so the checkout's own git
configuration (filters, fsmonitor, hooks) never runs; files are hashed by Context
Kit itself. `AMBIGUOUS_REPOSITORY` names every candidate id.

Over MCP it is `open_repo` (`repository`, optional `path`), offered only over stdio
(see `remote`), with the same result. It is the operation the routing skill and
the global rule name for resolving a repository.

### A new machine

Once the workspace is on the machine (`git clone` it, `npm install`), one command
makes every listed repository active:

```sh
npm run hub -- repos setup                       # scan ~ two levels deep, report the rest
npm run hub -- repos setup --scan ~/code --scan ~/work --depth 3
npm run hub -- repos setup --clone room,studio   # also clone these two
npm run hub -- repos setup --ask                 # ask about each one still missing
```

It scans each `--scan` directory (default your home directory) to `--depth`
(default 2), then clones the repositories `--clone` names. On a terminal, or with
`--ask`, it then asks about each repository still missing: type a path to record
that checkout, `clone` to clone it into `~/<name>`, `clone <path>` to clone it
there, or nothing to skip it. A wrong path is reported and asked again. It never
clones a repository you didn't name or answer `clone` for. Prompts go to stderr and
the JSON result to stdout: what was `recorded`, `cloned`, `located`, `skipped` or
`failed`, and each repository still `missing` with its `repos locate` and
`repos clone` commands. Remotes are shown only as host/owner/name, so a token in
a remote URL never reaches the output, and a failed clone says only whether it was
authentication, not found, the network or git. It ends by refreshing the installed `my-repos` skill; if
none is installed yet, it says to run `agents install`.

### Worktrees

A linked worktree (`git worktree add`) is never recorded. When `repos scan` or
`repos setup` finds one, it records the main checkout `git worktree list` reports
(the result names the worktree as `worktree`). When there's no main checkout to
record, it records nothing and lists the worktree under `skipped` with the reason:
a worktree of a bare repository, of a main checkout that was deleted, or of a
`--separate-git-dir` checkout (git reports its git directory, not its checkout, as
the main worktree; record that checkout with `repos locate`). A path answered at a
`repos setup` prompt is treated the same way.

## The my-repos skill

When any repositories are registered, core generates a `my-repos` skill and
`agents install` installs it. Agents choose skills by their descriptions, so the
description names your repositories, and agents pick it up when you mention one
from any directory. Its body gives each upstream, alias, keyword and local path
and tells agents not to search the filesystem. It tells them to open a mentioned
repository first, with the exact `repos open <id>` launcher command for each one
(or the `open_repo` tool), adding `--role <role>` when reviewing with a role, then
to read the instruction files and concept the result points at. Nothing from a
repository's `context` is copied into the skill, so its frontmatter and body don't
change when `context` does. `repos locate`, `clone`, `scan` and
`setup` update installed copies at once.

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

## Reaching the workspace from anywhere

The skill never says `cd` into the workspace. It names one operation for resolving a
repository (`open_repo`, `repos open`): as a tool of the workspace's MCP server, by the
name it is registered under, and as a command of the `context-kit` launcher. Every
other command it gives, such as `repos clone`, `repos locate`, `read` and
`repos sync`, also runs through the launcher.

`agents install` writes the launcher to `$XDG_BIN_HOME/context-kit`, or
`~/.local/bin/context-kit` without it. It is a small managed script that runs this
workspace's pinned core with `--root <workspace>` from any directory, using this
machine's Node by absolute path. The skill always names it by that absolute path,
because agent apps started outside a shell often lack its directory on `PATH`. At a
terminal, `context-kit` alone works once the directory is on `PATH` (and no other
`context-kit` comes first); until then `agents status` reports `onPath: false`
with the line to add to your shell profile. Install never overwrites a `context-kit` it didn't
write (`conflict`, unless `--force`) and never writes through a symlinked
directory below `HOME` (`refused`); either way the skill then names the core by
path instead. Uninstall removes the launcher when it is unchanged and no agent
items remain.

**One workspace per user.** The launcher and `my-repos` belong to one workspace on
a machine. When either belongs to another workspace that still exists,
`agents install` fails with `WORKSPACE_CONFLICT`, naming it, before writing
anything. `--force` takes over the launcher and routing skills and leaves the
other workspace's other items, such as its MCP server and hooks, alone (bundled
skills of the same name are replaced, as `--force` always does). Keep the
repositories you work on in one workspace's hubs.

**Moving a workspace.** After you move or rename the workspace directory, the
skill's text still works, but what it points at doesn't: `agents status`, run from
the new location, reports the MCP registrations, launcher and skills `moved`,
naming the old path, and the launcher fails with `WORKSPACE_MOVED`. Run
`npm run agents -- install` once in the new location. It rewrites the launcher,
re-registers the MCP server (removing the registration under the old name, which
follows the directory name), reinstalls the skills and replaces the merge
tripwire's entry. Any tripwire entry whose script no longer exists is removed too.
