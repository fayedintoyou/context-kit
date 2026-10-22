# Proposal

## Why

A hub holds a shared list of repositories and the context around them. Whoever
uses that hub, from whichever machine, should get those repositories activated and
mapped to that machine's own checkouts: the list is shared, the path map is per
machine. That is one mechanism with two everyday uses: one person using their hub
from several machines and workspaces, and many people using one hub.

Half of it works today. A workspace is a git repository, so cloning it on a second
machine brings its hubs, and `.state/checkouts.json` is untracked, so each machine
records its own paths with `repos locate`, `clone` or `scan`. What does not work is
using a hub that lives in a different repository than the workspace: a hub kept
in its own repository for use from several workspaces, or one that several people
share. Today a workspace loads hubs only from its own `hubs/` and `examples/`, so
the hub has to be copied in, where it silently diverges, and its repositories reach
`my-repos` only if each workspace re-registers them by hand.

Step 3 of the roadmap (`docs/next.md`) is federation, and its defaults are agreed:
mounts are pinned git dependencies upgraded deliberately, never live checkouts and
never inside a hub directory; they are read-only; their concept IDs are namespaced
(`team-data:/tables/orders` in the roadmap; `shared:/tables/orders` below); each
result carries the bundle's provenance and trust; and `outside` links resolve when
a mount names their target.

## What Changes

This is core Context Kit functionality, like hubs and repositories.

- A workspace declares mounts in `context-kit.json`: a name, a git `source`, an
  optional `path` to the hub inside that repository, the `ref` to follow on upgrade,
  and the pinned `commit`. The pin is tracked with the workspace; the fetched
  content lives in untracked `.state/mounts/<name>/<key>/`, keyed by source, path
  and commit, outside every hub.
- New CLI-only commands: `mounts` (list), `mounts add <name> <source> [--ref]
  [--path]`, `mounts fetch [<name>]`, `mounts upgrade <name> [--to <rev>]
  [--check]` and `mounts remove <name>`. Nothing fetches or moves a pin implicitly,
  and fetched mounts work offline. A fetch or upgrade prepares the exact pinned
  commit aside and switches atomically, never serving a branch tip; a failure
  keeps the previous pin and content. MCP gains read-only `list_mounts`.
- Sources never embed credentials: user info, passwords and query strings are
  rejected before anything is stored, private sources authenticate only through
  git's credential helpers or SSH, and errors never echo credentials.
- A fetched mount is a hub addressed by its mount name in every read: `list`,
  `context`, `browse`, `read`, `search` and their MCP tools. Every concept result,
  workspace or mounted, carries a qualified reference `<hub>:/<concept-id>`, and
  `read`/`read_concept` accept one in place of the hub and concept pair.
- Bundles sit side by side under their namespace and are never merged, so each
  keeps its own root `index.md`, `okf_version` and `log.md` (OKF issue #26).
- Trust stays OKF's: each concept's `okf` summary (`verified`, `status`,
  `stale_after`, `generated`) is reported unchanged, and mounted results add only
  provenance: mount name, source, path and commit. `mounts` and `list_mounts` show
  each bundle's count of concepts per OKF trust tier.
- Mounts are read-only: `capture`, `repos add` and `add_repo` against a mount fail
  with `READ_ONLY_MOUNT`. A mounted hub changes through its own repository.
- A declared mount that is not fetched, or whose content is not a loadable hub,
  never breaks the workspace: reads of it fail with `MOUNT_NOT_FETCHED` or
  `MOUNT_BROKEN` and a remedy, and other results carry a warning naming it.
- Links: `<mount>:/<concept-id>` links classify as `concept` in that mount, and a
  mounted concept's `outside` link that lands in another mount of the same source
  repository resolves there.
- Repository concepts in a mounted hub join the repository registry as
  `<mount>:/<concept-id>`. Each machine records its own checkouts in
  `.state/checkouts.json` as today, and `my-repos` lists them: every workspace
  mounting the hub shares the list, each machine owns its paths. There is no
  special kind of hub for teams; a mount is any hub in another repository.
  Concepts sharing an upstream are one repository with alternate ids. A name
  that a workspace hub and a mount, or two mounts, claim for different upstreams
  is resolved by fixed precedence with a warning (two mounts: neither, use the id),
  never by failing `validate`; clashes among workspace hubs still fail as today.
- The registry defines effective trigger names (collision-resolved) that the
  routing renderer uses before budgeting, and `my-repos` is generated with
  recovery guidance (`mounts fetch` through the portable entry point) even when
  the only repositories would come from a mount that is not fetched yet.
- Every MCP client the server admits, over stdio or the remote HTTP server, sees
  mounted content and provenance exactly like workspace hubs.

## Non-goals

- Live sync, watching or auto-upgrading a mount; background fetches.
- Writing to a mount or proposing changes upstream from Context Kit.
- Merging bundles or layering one over another; overrides of a mount's concepts.
- Semantic search, embeddings or RAG across mounts.
- Installing a mount's skills into agents or offering them as MCP prompts; a
  mount's `specStores` (a later change can add both deliberately).
- Mounting a bare OKF bundle without `hub.json`, or several hubs from one mount.
- Resolving `https://` links to a mount's source host as mount concepts.
- Credentials for private sources beyond what the user's `git` already has.
- Pinned content verification beyond git's own commit identity.
- Exposing some mounts to some MCP clients only (for example, hiding a mount from
  the remote HTTP server); every admitted client sees every mount.
- The `repo-context` change's structured pointers on Repository concepts.

## Capabilities

### New Capabilities
- `hub-federation`: declaring, fetching, pinning and upgrading mounts, reading
  mounted hubs under a namespace with provenance, qualified references, read-only
  enforcement and degraded behavior for unfetched or broken mounts.

### Modified Capabilities
- `progressive-disclosure`: link classification also resolves links into mounts.
- `knowledge-format`: strict bundle validation is scoped to workspace hubs, and
  mounted bundles are checked leniently, with warnings.
- `repository-registry`: mounted Repository concepts join the registry, one
  repository per upstream with alternate ids, precedence for names claimed across
  mounts, and effective trigger names for any routing renderer (added);
  `Routing skill guidance` is narrowly modified for recovery guidance.

## Impact

- `lib/`: a new `mounts.mjs` (config, git fetch into `.state/mounts`, upgrade
  diff); `hubs.mjs` loads mounted hubs leniently next to workspace hubs;
  `navigate.mjs` classifies mount links; `workspace.mjs` adds `ref` and
  provenance and the write guards; `repos.mjs` reads mounted Repository concepts;
  `addons.mjs` accepts `mounts` in `context-kit.json`; `operations.mjs`,
  `bin/hub.mjs` and the MCP server gain the commands and `list_mounts`.
- Help: a `mounts` topic, usage lines and the new error codes; `docs/format.md`,
  README and `docs/next.md` describe mounts. OKF links move to the canonical
  repository, https://github.com/GoogleCloudPlatform/open-knowledge-format.
- Delivery depends on the toolkit-wide `slice-aware-links` change (spec-links
  requires tests only for requirements of slices that have landed or are being
  delivered). Until it lands, any branch carrying this change fails `npm test`.
- Coordinates with two sibling plans. `machine-setup` (#50) owns the routing-skill
  renderer (front-matter budget, shards, keywords, the launcher-based portable
  entry point), so this change does not modify `Generated routing skill`; it adds
  `Effective trigger names`, the collision-resolved names any renderer must use,
  and its recovery guidance uses #50's portable entry point. `repo-context` (#49)
  changes the skill body around `repos open`. The one remaining MODIFIED registry
  requirement, `Routing skill guidance`, rebases onto #49's and #50's text before
  archive. Agreed landing order after `slice-aware-links`: #50's routing,
  front-matter and portable-entry slices, then #49's open, routing and fields slices, then
  this change's `mounted-repositories` slice; the other slices of all three can
  land concurrently. slices.yaml can't depend across changes, so that slice's
  first task checks the order (`specs status machine-setup` / `repo-context`).
  This change owns `Effective trigger names` (#50 names its renderer requirement
  differently), including how keywords behave across mounts, and decides that a
  shared upstream's `context` (#49) comes from the canonical concept; this change
  is the sole owner of that mount-context case.
- No new dependencies. Uses the `git` CLI, like `repos clone`. Tests use local
  `file://` repositories, so they need no network.
