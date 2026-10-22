# Design

## Context

A workspace is an instance of the core: a git repository pinning a core commit in
`package.json`, with hubs under `hubs/` (and `examples/`), `context-kit.json`
naming its addons, and untracked `.state/` for per-machine state. `loadHubs`
reads exactly those two directories. Concepts are addressed as `(hub id, concept
id)`; the progressive-disclosure design fixed link kinds so "federation only adds
values". Repository concepts in any loaded hub form the registry, keyed by
normalized upstream, and `.state/checkouts.json` maps upstreams to this machine's
paths; `my-repos` is rendered from both.

**What already works without federation.** One person using one workspace on
several machines: clone the workspace repository on each machine, and each one
records its own checkouts (`repos scan ~`, `locate`, `clone`), so the shared list
and per-machine paths already hold. The sync hooks rebuild `my-repos` after each
pull.

**What federation adds.** A workspace can use a hub that lives in a *different*
repository from the workspace: pinned to a commit, read-only, and namespaced. That
one mechanism covers a person's hub used from several of their workspaces (say a
work and a home workspace on different machines) and a hub many people use. There
is no team-specific type or code path: a mount is any hub in another repository,
and every workspace that mounts it gets the same repositories mapped to its own
machine's paths.

## Goals / Non-Goals

**Goals:**
- Mount a hub from another git repository at a pinned commit, from the CLI, with
  no hand-editing.
- Read a mounted hub through every existing read and MCP tool, with its
  namespace, OKF trust and the bundle's provenance.
- Repository concepts in a mount reach `repos` and `my-repos`; checkout paths stay
  per machine.
- A missing, unreachable or broken mount never breaks the workspace.

**Non-Goals:** as listed in the proposal. In short: no live sync, no writes to
mounts, no merging or overriding, no RAG, no mounted skills or spec stores yet, no
manifest-less bundles.

## Decisions

1. **Declared in `context-kit.json`, not `package.json`.** The core is pinned as
   an npm git dependency, but a hub repository has no `package.json`, and npm
   would install into `node_modules`. Mounts get their own object in the
   workspace's tracked config:

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

   `source` is any upstream `normalizeUpstream` accepts (HTTPS, SSH, `file://`).
   `path` defaults to the repository root; `ref` defaults to the remote's default
   branch at add time and is what `upgrade` follows. The pin is tracked, so every
   clone of the workspace reads the same commit; the content is per machine.
   Mount names follow the store-id pattern and must differ from every workspace hub
   ID, since both appear in the same `id` argument.

2. **Fetched content is a commit-addressed, read-only tree outside every hub.**
   `mounts fetch` runs `git fetch --depth 1 <source> <commit>` into a bare cache
   at `.state/mounts/.git/<name>` and exports `<path>` at that commit into
   `.state/mounts/<name>/<commit>/`, then removes write permission. Loading uses
   the directory for the pinned commit only: present means `fetched`, absent means
   `unfetched`. No working tree, no branch, nothing to pull, so a mount cannot
   become a live checkout by accident, and an upgrade is an atomic switch of the
   pin. Old commit directories are removed by `upgrade` and `remove`. `.state/` is
   already in the starter `.gitignore`; `.state` is never under `hubs/`, so the
   "never inside a hub directory" decision holds by construction. Hosts that
   refuse fetch-by-SHA fall back to fetching `ref` and checking the commit is
   reachable (`FETCH_FAILED` otherwise).

3. **Nothing implicit touches the network or the pin.** Only `mounts add`,
   `fetch` and `upgrade` reach a source; reads never do. These commands, and
   `remove`, are CLI-only and need an explicit workspace outside the toolkit
   checkout, like `repos add`. MCP gets read-only `list_mounts`. `upgrade --check`
   resolves and fetches the candidate into the cache but leaves the pin, so a
   person can review what changes (concept IDs added/removed/changed by blob,
   repositories added/removed) before moving it. This is the "upgraded
   deliberately, like an instance pins the core" decision.

4. **A mount is one hub; its name is its hub ID.** A mount points at one hub
   directory with a `hub.json`. In every hub-ID position (`context`, `browse`,
   `read`, `search` results, MCP `id`) the mount appears under its mount name; the
   mounted manifest's own `id` is reported as `manifestId` only. A repository with
   several hubs is mounted once per hub (same source, different `path`). This keeps
   the roadmap's `shared:/tables/orders` shape: one namespace segment, then the OKF
   concept ID.

5. **Qualified references.** Every concept result gains `ref: "<hub-id>:/<concept-id>"`
   (workspace hubs too: `personal/main:/preferences`). Hub IDs cannot contain `:`,
   so the first `:/` splits it. `read <ref>` and `read_concept { concept: <ref> }`
   (with `id` optional) accept it; a hub that disagrees is `INVALID_INPUT`. Tools
   take IDs as explicit parameters, which fits MCP's direction (the 2026-07-28
   revision deprecates Roots in favor of explicit parameters). Existing
   `(hub, concept)` calls are unchanged.

6. **Side by side, never merged.** Each mount is its own bundle under its own
   namespace. Nothing combines directories, so OKF's reserved files (`index.md`,
   `log.md`), which collide when bundles are layered (OKF issue #26), stay per
   bundle, and each keeps its own root `okf_version`. A mount's concept `README`
   and a workspace hub's `README` are different concepts with different refs.

7. **Trust is OKF's; the mount adds only provenance.** No parallel trust scale.
   Each concept's `okf` summary (trust tier from `verified`, `status`, `stale`,
   `generated`) is computed exactly as for workspace hubs, and freshness uses the
   mounted hub's own `freshness` policy. Mounted results add
   `mount: { name, source, path, commit }`, the bundle's provenance in the sense
   of OKF's `sources`: where the bytes came from. `mounts`/`list_mounts` summarize
   a bundle's trust as the count of its concepts per OKF tier, so a person can see
   "12 human-reviewed, 30 unverified" before relying on it. A `human:` verifier in a
   mount is someone in that hub's own history; the provenance makes that visible
   rather than re-rating it.

8. **Lenient loading for mounts.** Mounted hubs load with the lenient rules reads
   already use, and never strictly: the person mounting can't fix them. Problems
   become warnings; a curated document that is not a concept, or a missing
   `hub.json`, makes the mount `broken` (`MOUNT_BROKEN` when addressed, a warning
   elsewhere). Manifest `links` to hubs the workspace lacks, `skills` and
   `specStores` are warnings and not offered: skills become agent instructions and
   stores name machine registrations, both of which deserve their own deliberate
   change. `read-skill <mount> …` fails with `UNKNOWN_SKILL`. Path confinement
   applies to the exported tree exactly as to workspace hubs: a `path` with `..`
   is `INVALID_PATH`, and a symlink in the tree that escapes it is rejected.

9. **Read-only by construction and by check.** Writes resolve their target hub
   first; a mount fails with `READ_ONLY_MOUNT` before any file is touched
   (`capture`/`capture_note`, `repos add`/`add_repo`). The fetched tree is also
   unwritable on disk, so a stray editor save fails loudly. A mounted hub changes
   by a commit in its own repository and an `upgrade` here.

10. **Links into mounts.** Two additions, both answered from loaded file sets:
    - A link whose scheme is a declared mount name (`shared:/tables/orders`, with
      or without `.md`) is a `concept` link in that mount, `missing` if the mount
      has no such concept, and `missing` with `reason: unfetched` or `broken` when
      the mount is not loaded. An undeclared scheme stays `external`.
    - A mounted concept's link that leaves its bundle is resolved inside its source
      repository (from the mount's `path`); if another mount has the same
      normalized source and that path falls under its `path`, it is a `concept`
      link there. This is "outside links become resolvable when a mount names their
      target". Each mount reads its own pin, which may differ; the link carries the
      target's `ref`, and its `mount` provenance shows the commit.
    Links from workspace hubs use the first form; `https://` links to a source
    host stay `external` (non-goal).

11. **Mounted repositories join the registry.** `registry()` reads Repository
    concepts from workspace hubs and then from loaded mounts, in mount-name order.
    A mounted repository's id is its concept ref (`shared:/repos/orders`), and it
    carries `mount`. Checkouts stay keyed by upstream in `.state/checkouts.json`,
    so `locate`, `clone` and `scan` work unchanged, and the same upstream located
    once serves every hub that registers it. `my-repos` lists mounted repositories
    with their mount and gives `read shared repos/orders` as the read command. The
    skill's "a new repository isn't listed until…" guidance says that a mounted
    hub's repositories are added in that hub's own repository. Every command that
    changes a mount (`add`, `fetch`, `upgrade`, `remove`) refreshes installed,
    unchanged copies of the skill, like `repos locate`.

12. **Collisions never fail someone else's validate.** Workspace hubs keep today's
    rule: a duplicate alias or title among them fails `validate`, because the
    person can fix it. Across mounts, precedence decides and a warning names the
    claimants: workspace hubs win a name or upstream over mounts; a name two mounts
    claim (and no workspace hub) belongs to neither, so `repos locate api` is
    `AMBIGUOUS_REPOSITORY` and `my-repos` omits that name; the same upstream in two
    places is listed once, under the first in precedence. Every repository remains
    addressable by its id.

13. **Unfetched is a normal state.** A fresh clone of a workspace has pins but no
    content. `list`, `search`, `repos` and `validate` warn with the exact remedy
    (`mounts fetch shared`); addressing the mount fails with `MOUNT_NOT_FETCHED`;
    `my-repos` names the mount and the command in its body. The `post-merge` sync
    hook keeps running only `repos sync`, so a pull that moves a pin leaves the
    mount unfetched until `mounts fetch` (see Open Questions).

14. **Search shares its bounds.** `search` covers workspace hubs then mounts, within
    the existing 2 MiB scan and 50-result limits, reporting `truncated` as today.

15. **Error codes.** New: `UNKNOWN_MOUNT`, `MOUNT_EXISTS`, `NOT_A_HUB`,
    `FETCH_FAILED`, `MOUNT_NOT_FETCHED`, `MOUNT_BROKEN`, `READ_ONLY_MOUNT`. Config
    shape errors reuse `INVALID_CONFIG`. The `help` topic `mounts` documents all of
    them, keeping "Complete help" true.

## Alternatives considered

- **A git submodule or clone under `hubs/`.** Free with git, but it puts the mount
  inside the hub tree (against the agreed decision), makes it writable and
  live-checkout-shaped, and gives it no namespace or provenance.
- **An npm git dependency, like the core.** Reuses the pinning, but requires a
  `package.json` in every hub repository and couples hub upgrades to `npm install`.
- **Symlinks to a checkout elsewhere.** Rejected by today's path confinement, and a
  live checkout again.
- **Merging mounted directories into one view.** Collides on OKF's reserved files
  and on concept IDs, and hides provenance (OKF issue #26).

## Example

A person keeps their projects hub in its own repository so their work workspace
and home workspace can both use it:

```sh
context-kit mounts add shared https://github.com/example/shared-context --path hubs/projects
context-kit repos                      # shared:/repos/orders  missing
context-kit repos scan ~/src           # records ~/src/orders on this machine
context-kit read shared:/repos/orders
```

On the other machine, after pulling the workspace: `mounts fetch`, then `repos scan`.
Someone else who mounts the same hub runs the same commands and gets the same list
mapped to their own paths. When the hub's repository moves on,
`mounts upgrade shared --check` shows what changed and `mounts upgrade shared`
moves the pin.

## Risks / Trade-offs

- [A pull moves a pin on another machine and the mount goes unfetched] → explicit
  warnings and remedies everywhere; optional fetch-in-hook is an open question.
- [Precedence hides a mount's alias silently] → every collision is a warning in
  `repos`, `list_repos` and `validate`.
- [Fetch-by-SHA unsupported by a host] → fall back to fetching the ref and checking
  reachability.
- [Mounted text is instructions an agent might follow] → unchanged rule: reading a
  hub does not authorize actions; mounted skills are not installed; provenance is
  on every result.
- [Search budget shared with large mounts] → existing truncation reporting.
- [Two mounts of one source pinned to different commits] → allowed and visible
  through each result's `mount.commit`.

## Migration

Additive. A `context-kit.json` without `mounts` behaves exactly as today. Adding
`ref` to results is a new field. An older core reading a workspace with `mounts`
fails with `INVALID_CONFIG`, which is the right signal to upgrade the core first.

## Open Questions

1. Should the `post-merge`/`post-rewrite` hooks also run `mounts fetch` when a
   pull moves a pin (network in a git hook), or keep only warning?
2. Is fetching all pinned mounts during `setup`/`agents install` acceptable, so a
   new machine is ready in one command?
3. Should a workspace be able to opt a mount out of the repository registry
   (`"repositories": false`) for a hub it reads but whose repositories it doesn't
   work in?
4. Precedence when two mounts claim one name: "neither" (proposed) or the first by
   mount name?
5. Mounted skills: a later change to list, read and optionally install them, or
   never?
6. Manifest-less OKF bundles from other tools: support later with a synthesized
   manifest (all root-index concepts curated), or require `hub.json`?
