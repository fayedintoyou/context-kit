# Mounts: hubs from other repositories

A mount uses a hub that lives in another git repository, such as your own hub
kept in its own repository for several workspaces, or one many people share. The
workspace pins it to a commit in its tracked `context-kit.json`; each machine
fetches that exact commit into untracked `.state/mounts/`, outside every hub.
Nothing fetches or moves a pin on its own.

```sh
npm run hub -- mounts add shared https://github.com/example/shared-context --path hubs/data
npm run hub -- mounts                 # name, source, path, ref, commit, status, trust counts
npm run hub -- mounts fetch           # on another machine, after pulling the workspace
npm run hub -- mounts upgrade shared --check   # what moving the pin would change
npm run hub -- mounts upgrade shared  # move the pin to what its ref names now
npm run hub -- mounts remove shared
```

## Declaring

```json
{
  "version": 1,
  "addons": ["specs"],
  "mounts": {
    "shared": {
      "source": "https://github.com/example/shared-context",
      "path": "hubs/data",
      "ref": "main",
      "commit": "0123456789abcdef0123456789abcdef01234567"
    }
  }
}
```

- The name is lowercase words joined by hyphens, at most 64 characters, and
  differs from every workspace hub ID (`MOUNT_EXISTS` from `validate` otherwise).
- `source` is a git URL: HTTPS, SSH (`git@host:owner/repo`), `git://` or
  `file://`. `path` is the hub directory inside it (default: the root), `ref` the
  branch or tag it follows, `commit` the full 40-hex pin.
- Any other shape, an unknown key or a commit that is not 40 hex is
  `INVALID_CONFIG` from every command, naming each mount.

## Credentials

A source never carries a secret. HTTP(S) URLs with user info, any URL with a
password, and any URL with a query or fragment are refused before anything is
stored (`INVALID_INPUT` from `mounts add`, `INVALID_CONFIG` for a hand-edited
config), and the error names the mount, never the value. SSH user names such as
`git@` are fine. Private sources authenticate only through your git credential
helpers or SSH agent. Git runs with terminal and askpass prompts disabled, so a
missing credential fails at once with `FETCH_FAILED` ("authentication failed").
Git's own messages are never shown, since a rewritten URL (`insteadOf`) or a server
may put secrets in them: a failure names the mount, its declared source and one
of a fixed set of reasons (authentication failed, repository not found, network
error, the ref or commit is not available there, timed out, git failed).

## Commands

- `mounts add <name> <source> [--ref <ref>] [--path <dir>]` resolves the ref (the
  source's default branch when omitted), fetches that commit, checks that `path`
  holds a `hub.json` and a loadable OKF bundle (its curated documents are
  concepts), then records the mount. It refuses a taken name (`MOUNT_EXISTS`), a
  `path` leaving the repository or that is a symlink in it (`INVALID_PATH`), a
  path with no hub (`NOT_A_HUB`) and an unreachable source (`FETCH_FAILED`), and
  then records nothing.
- `mounts fetch [<name>]` makes each mount's pinned commit available, never a
  branch tip: it fetches the commit by SHA, or, when the host refuses that, the
  ref's history, using the pinned commit only if it is there. Each export is
  prepared in a temporary directory, checked, made read-only and renamed into
  place. A mount already fetched at its pin is `unchanged`. A failure reports
  `FETCH_FAILED` for that mount, keeps what it had, still fetches the others and
  makes the command exit nonzero; `failed` lists them.
- `mounts upgrade <name> [--to <rev>] [--check]` is the only way a pin moves.
  It resolves the mount's `ref` (or `rev`: a branch, a tag, peeled to its commit,
  or a full 40-hex commit) to a commit, fetches exactly that commit, prepares its
  export aside and checks it is a loadable hub. Only then does it switch the
  export in and rewrite the pin in `context-kit.json`. The old pin's export is
  kept, so a read that loaded it just before can finish; older ones are
  removed by the next upgrade or fetch. A read that fails because a pin moved
  under it runs once more at the new pin, and content replaced mid-read is
  `MOUNT_BUSY` ("try again"), never `MOUNT_BROKEN`. A branch or tag `rev` also becomes the mount's `ref`; a commit
  keeps it. The result gives `from` and `to` (commit and ref), `outcome`
  (`upgraded`, or `current` when the pin already names that commit) and
  `changes`: `concepts` and `repositories` (Repository concepts, matched by
  upstream), each `added`, `removed` and `changed` (by content), as references
  such as `shared:/tables/orders`. When the pinned commit is not fetched or is
  broken on this machine, `changes` is null and `baseline` says why.
  `--check` reports the same (`outcome` `available` or `current`) and changes
  no pin, export or read. A candidate that is not a hub fails with
  `MOUNT_BROKEN`; an unknown commit, ref or unreachable source with
  `FETCH_FAILED`. Either way, and on any other failure, the old pin and content
  stay exactly as they were. Upgrading never happens on its own, and reads keep
  using the old pin until it succeeds.
- `mounts remove <name>` deletes the declaration and the fetched content
  (`UNKNOWN_MOUNT` when no mount has that name).
- `mounts` (MCP `list_mounts`, read-only) lists each mount's `name`, `source`,
  `path`, `ref`, `commit`, `status`, `manifestId` (the mounted `hub.json` id) and
  `trust`, its concepts per OKF tier (`human-reviewed`, `machine-confirmed`,
  `unverified`).

Status is `fetched` only while the fetched content was recorded for exactly the
declared source, path and commit; after a pull changes any of them it is
`unfetched` with the remedy (`mounts fetch <name>`) until fetched again, so old
content is never shown under a new pin. `broken` (with a `reason`) means the
fetched commit is not a loadable hub.

## Reading mounted hubs

A fetched mount is a hub named by its mount name in `list`, `context`, `browse`,
`read` and `search` and their MCP tools (`list_hubs`, `get_context`,
`browse_hub`, `read_concept`, `search_context`), after the workspace's own hubs.
Its results carry `mount` (`name`, `source`, `path`, `commit`: where the bytes
came from) beside the unchanged OKF trust summary; `list` and `context` also give
`manifestId`, the mounted `hub.json` id. Freshness follows the mounted hub's own
`freshness` policy. Reads use only the fetched content and never contact the
source, so they work offline. Every MCP client the server admits, over stdio or
the remote HTTP server, sees mounted hubs exactly like workspace hubs: mounting a
hub discloses it to every client you have admitted, and there is no per-mount
exposure control.

Bundles sit side by side, never merged: each keeps its own root `index.md`,
`okf_version`, `log.md` and concept IDs, so `shared:/README` and
`personal/main:/README` are different concepts.

A mounted hub is loaded leniently, since you can't fix it here. Nonconformant
files are warnings; its manifest's `skills` and `specStores`, and `links` to hubs
not present, are warnings and never offered (`read-skill <mount> ...` is
`UNKNOWN_SKILL`). `validate` checks workspace hubs strictly and reports mounted
problems as warnings naming the mount and file, never failing on them. Symlinks
and submodules in the source are not exported and are warned about by name; a
symlink found in an export is never followed.

Mounts are read-only: `capture`, `capture_note`, `repos add` and `add_repo`
against a mount fail with `READ_ONLY_MOUNT` before anything is written. Change a
mounted hub in its own repository, then move the pin.

A declared mount that is not available never breaks the other hubs:

- Not fetched on this machine (a fresh clone, or a pull that moved its pin):
  addressing it fails with `MOUNT_NOT_FETCHED`; `list`, `search`, `repos` and
  `validate` warn with the remedy, `mounts fetch <name>`.
- Fetched but not a loadable hub (no `hub.json`, or a curated document that is
  not a concept): addressing it fails with `MOUNT_BROKEN` naming the file; the
  same commands warn. Pin a commit whose content is a hub, or `mounts remove` it.

## Repositories from mounts

Repository concepts in a fetched mount (outside its inbox) join the registry as
`<mount>:/<concept-id>`, such as `shared:/repos/orders`, carrying `mount`. `repos`,
`list_repos`, `repos locate`, `clone`, `scan`, `open` and `my-repos` include them.
Checkouts stay per machine in `.state/checkouts.json`, keyed by upstream: every
workspace mounting the hub shares the list, and each machine records its own paths.
A new repository in a mounted hub is added in that hub's repository and arrives
here with `mounts upgrade`. `mounts add`, `fetch`, `upgrade` and `remove` refresh
`my-repos` and its installed, unchanged copies; a refresh that fails is a
warning, since the mount change is already made.

- **One repository per upstream.** Concepts sharing an upstream, a mount among
  them, are one repository. Its id is the first by precedence (workspace hubs by
  hub then concept ID, then mounts by name then concept ID); the rest are its
  `alternateIds`, which every `repos` command accepts. Only that concept's title,
  aliases and `context` count, and `context` refs resolve in its own hub, so
  `repos open shared:/repos/orders` may open `data:/repos/orders` with a warning
  that the other concept's `context` is ignored.
- **Names across mounts.** Every kind of name (id, alternate id, title, alias,
  upstream name, keyword) goes through one precedence, each collision a warning,
  never a `validate` failure: an id is its repository's alone; a name a workspace
  hub's repository claims in any way is lost by every mount claiming it; a title,
  alias or upstream name only mounts claim names none of them
  (`AMBIGUOUS_REPOSITORY`; use the id). An exact id always resolves. A mounted
  repository's names compare with any other after Unicode compatibility
  normalization (NFKC) and full case folding, so `café` in NFD and fullwidth
  `ｓｉｔｅ` are the same names as `café` and `site`; two workspace repositories'
  names compare case-insensitively, as without mounts. Claims among
  workspace hubs alone still fail `validate`. `repos`, `list_repos`, `repos open`
  and `my-repos` show a repository only the names that open it.
- **Effective names.** `my-repos` triggers only on names a repository owns
  undisputed. A disputed name appears only in the body, with the ids it may mean.
  Keywords are never identifiers: a keyword several repositories share is listed
  once, and one naming another repository, a mount involved, is dropped with a
  warning. All of this happens before the description budget, so a dispute
  between mounts never costs another repository a name.
- **Mounted text stays text.** A mount's names reach the description only as YAML
  strings, on one line with format characters (bidi overrides, zero widths)
  removed, and its ids are shell-quoted in every command. A mounted Repository
  concept whose ID or resource holds whitespace, a backtick, or a control or
  format character, or whose resource is a local path, is not registered, with a
  warning. A mounted repository brings at most 20 aliases and 20 keywords of at
  most 60 characters (and a title of at most 80); more are dropped with a warning.
  A mount registers at most 200 Repository concepts (by concept ID in code point
  order) whose resource is at most 300 characters. Warnings are at most 500
  characters each and 100 in all, those naming a workspace repository first, and
  the body's "Names that need an id" lines name at most five of a shard's ids.
- **Your names first.** The workspace's repositories share a `my-repos` shard with
  mounted ones only when everything fits one description, none of the workspace's
  names is skipped and the mounted part of the body is small; otherwise they get
  their own shard(s) first and the mounts' repositories follow in theirs. A mounted
  shard's body is bounded (about 24 KiB and under 500 lines), and at most four shards
  hold mounted repositories; the last says how many more there are, which `repos`
  lists and `repos open <id>` opens.
- **Recovery.** For each declared mount that is not fetched or is broken, the
  `my-repos` body gives the exact `mounts fetch <name>` command through the
  launcher, never a `cd`. A workspace whose only repositories would come from such
  mounts still gets a `my-repos` that says so. Fetching is CLI-only; the sync hooks
  never fetch.

## What is exported, and limits

The export holds the raw bytes of the pinned tree's regular files, read straight
from git objects: no checkout, no filters, hooks or other inherited git settings.
Symlinks, submodules and a top-level `.mount.json` file or directory in any letter case or Unicode form (the name the export's own descriptor takes) in the tree are not exported, and are warned about by name. Before anything is written,
the tree listing must fit the budgets: at most 10,000 entries (hidden ones
included), 64 MiB in all, 16 MiB per file, 32 directories deep and paths of at
most 1,024 characters; otherwise `TOO_LARGE`. A fetch only ever reads the commit
the pin names; a pin that names a tag object instead of a commit fails, and
`--ref` with an annotated tag pins the commit it points at.

Each export's `.mount.json` records the git tree it was made from and every file
with its blob id. `mounts fetch` and `mounts upgrade` reuse an export only when
every listed file is present with exactly those bytes (and, for an upgrade, the
tree is the candidate's); otherwise they rebuild it, so a damaged or partly
deleted export is repaired rather than reported `unchanged`. Removing an export
deletes its `.mount.json` first, so an interrupted removal reads as unfetched.
An export made before descriptors listed files is re-exported once by the next `mounts fetch` (kept as it is if the source can't be reached). Reads don't re-verify: they trust a present descriptor.

Everything lives under `.state/mounts/` in the workspace. If any directory on the
way there is a symlink, mount commands stop with `PATH_ESCAPE` before changing
anything, and `mounts` shows the mount `broken`. Commands on one mount, and every
update of `context-kit.json`, take a lock under `.state/mounts/`, so simultaneous
runs wait for each other. A held lock is touched every five minutes; one whose
process is gone, or untouched for an hour, is taken over, and after 15 minutes of waiting the command fails with `MOUNT_BUSY`. Just before
it writes `context-kit.json` or switches in fetched content, a command checks the
lock is still its own; if another command took it over in a rare race, it stops
with `MOUNT_BUSY` without changing anything, and can simply be run again. After
writing `context-kit.json` it reads the file back and re-applies a change that is
missing. That makes a lost change very unlikely, not impossible: two commands can
still pass the check at the same moment, and a later one can overwrite after the
read-back. Run `mounts` after concurrent changes if in doubt.

Adding, fetching, upgrading and removing are CLI-only and need an explicit workspace outside
the toolkit checkout; no MCP tool changes mounts, even with `--allow-write`.
