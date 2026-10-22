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

## What is exported, and limits

The export holds the raw bytes of the pinned tree's regular files, read straight
from git objects: no checkout, no filters, hooks or other inherited git settings.
Symlinks and submodules in the tree are not exported. Before anything is written,
the tree listing must fit the budgets: at most 10,000 entries (hidden ones
included), 64 MiB in all, 16 MiB per file, 32 directories deep and paths of at
most 1,024 characters; otherwise `TOO_LARGE`. A fetch only ever reads the commit
the pin names; a pin that names a tag object instead of a commit fails, and
`--ref` with an annotated tag pins the commit it points at.

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

Adding, fetching and removing are CLI-only and need an explicit workspace outside
the toolkit checkout; no MCP tool changes mounts, even with `--allow-write`.
