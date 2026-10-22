# Tasks

Every slice that adds a command, MCP tool or error code also adds it to the help
topics, so `help / Help covers the tool` keeps passing.

Delivery depends on the toolkit-wide `slice-aware-links` change: until it lands,
spec-links requires tests for every scenario here, so no slice can pass `npm test`.

## 1. Mount lifecycle (slice `mount-lifecycle`)

- [ ] 1.1 Accept `mounts` in `context-kit.json` (name pattern, `source`, `path`, `ref`, 40-hex `commit`, no other keys; name not a workspace hub ID); link `test/e2e/mounts.test.mjs` to "Invalid mount declaration"
- [ ] 1.0 Reject credential-bearing sources (HTTP(S) user info, passwords, query or fragment) in `mounts add` and config loading without echoing them; run git with `GIT_TERMINAL_PROMPT=0` and redact URL user info from its stderr; link `test/e2e/mounts.test.mjs` to "Credentials in a source" and "Private source without access" (a local HTTP server answering 401)
- [ ] 1.2 Add `lib/mounts.mjs`: resolve a ref with `git ls-remote`, fetch a commit into the bare cache under `.state/mounts/.git/<name>`, export `<path>` at that commit into `.state/mounts/<name>/<key>/` read-only (key: digest of source, path and commit); `mounts add` checks the exported tree is a loadable hub before writing the config; confine `path` and reject escaping symlinks; link `test/e2e/mounts.test.mjs` to "Mount a hub from another repository" and "Source is not a hub" (fixtures: local bare repositories over `file://`, no network)
- [ ] 1.3 `mounts fetch [<name>]` per mount, exports keyed by source, path and commit with a descriptor checked on load; link "Declaration changes under a fetched mount"; fetch by SHA (fallback: ref history, pinned commit only), export to a temporary directory, check, rename; `FETCH_FAILED` isolation and nonzero exit; link `test/e2e/mounts.test.mjs` to "Fresh machine fetches its mounts", "One source unreachable" and "Pin from another machine"
- [ ] 1.4 `mounts remove <name>` deletes the entry and fetched trees; link `test/e2e/mounts.test.mjs` to "Remove a mount"
- [ ] 1.5 `mounts` (CLI) and read-only `list_mounts` (MCP) with status, `manifestId` and per-tier trust counts; add/fetch/upgrade/remove are `cliOnly`; link `test/e2e/mounts.test.mjs` to "List over CLI and MCP"
- [ ] 1.6 `mounts` help topic, usage lines and new error codes (keeps `help / Help covers the tool` passing); point OKF links in README, `docs/format.md` and `skills/context-kit` references at https://github.com/GoogleCloudPlatform/open-knowledge-format

## 2. Reading mounted hubs (slice `mounted-reads`)

- [ ] 2.1 Load fetched mounts leniently after workspace hubs, under their mount name, with `mount` provenance and the mount's freshness policy; link `test/e2e/mounts.test.mjs` to "Read a mounted concept" (CLI and MCP SDK client)
- [ ] 2.1a Mounted freshness and offline reads; link `test/e2e/mounts.test.mjs` to "Mount's own freshness policy" and "Source gone after fetch"
- [ ] 2.1b Mounted content over the remote HTTP server; link `test/e2e/remote.test.mjs` to "Remote client reads a mount"
- [ ] 2.2 `ref` on every concept result; `read <ref>` and `read_concept` with `concept` as a reference and `id` optional; link `test/e2e/mounts.test.mjs` to "Read by reference"
- [ ] 2.3 Keep bundles separate (own index, log, `okf_version`, IDs); link `test/e2e/mounts.test.mjs` to "Same paths in two bundles"
- [ ] 2.3a Never follow symlinks in exported trees; link `test/e2e/mounts.test.mjs` to "Escaping symlinks in a mount"
- [ ] 2.3b Scope strict bundle validation to workspace hubs and report mounted problems as warnings; link `test/e2e/mounts.test.mjs` to "Nonconformant mount", and keep the knowledge-format links for "Concept without a type", "Reserved file structure" and "Permissive consumption"
- [ ] 2.4 Mounted manifests: `manifestId`, warnings for unknown `links`, `skills`, `specStores`, none offered; link `test/e2e/mounts.test.mjs` to "Manifest fields that point elsewhere"
- [ ] 2.5 `READ_ONLY_MOUNT` guard in capture and repository adds (CLI and MCP); link `test/e2e/mounts.test.mjs` to "Writes against a mount"
- [ ] 2.6 Unfetched and broken mounts: `MOUNT_NOT_FETCHED`/`MOUNT_BROKEN` when addressed, warnings in list, search, repos and validate, mounted problems never failing validate; link `test/e2e/mounts.test.mjs` to "Mount not fetched yet" and "Broken mount" (CLI and MCP SDK client)

## 3. Upgrades (slice `mount-upgrade`)

- [ ] 3.1 `mounts upgrade <name> [--to <rev>] [--check]` with the concept and repository diff between commits; check before switching, atomic config rewrite, old pin kept on failure; link `test/e2e/mounts.test.mjs` to "Upstream moves on" and "Failed upgrade keeps the pin"

## 4. Links into mounts (slice `mount-links`)

- [ ] 4.1 Classify `<mount>:/<id>` links and same-source outside links from loaded file sets; keep existing kinds; link `test/e2e/navigate.test.mjs` to "Follow links" (unchanged), "Link into a mount", "Outside link a mount covers" and "Link into an unfetched mount"

## 5. Mounted repositories (slice `mounted-repositories`)

- [ ] 5.0 Landing check before starting this slice: on a fresh `main`, `specs status machine-setup` shows its routing/front-matter and portable-entry slices `landed`, and `specs status repo-context` shows its `open`, `routing` and `fields` slices `landed` (`fields` makes `repos open` return declared `context`, which 5.4a needs) (or those changes are archived). If not, wait; slices.yaml cannot express a cross-change dependency

- [ ] 5.1 Registry reads fetched mounts' Repository concepts as `<mount>:/<id>` with `mount`; `my-repos` lists them with their mount and read command; mount commands refresh installed unchanged copies; link `test/e2e/repos.test.mjs` to "One person's hub on two machines" and "Many people, one hub", and `test/e2e/agents.test.mjs` to "Upgrade brings a new repository"
- [ ] 5.2 One repository per upstream with `alternateIds` accepted by every `repos` command; link `test/e2e/repos.test.mjs` to "Same upstream twice"
- [ ] 5.3 Name precedence and warnings across mounts, keeping workspace-only duplicates failing; link `test/e2e/repos.test.mjs` to "Workspace keeps its alias", "Two mounts claim an alias" and "Workspace duplicates still fail"
- [ ] 5.4 Effective trigger names in the registry, consumed by `machine-setup`'s renderer before its budget; disputed names only in the body; keywords as triggers only, deduplicated, dropped with a warning when they collide with a name and a mount is involved; link `test/e2e/repos.test.mjs` to "Ambiguous names leave the triggers", "Disputed names filtered before the budget" and "Keywords across mounts"
- [ ] 5.4a Canonical concept owns `context` (from `repo-context`), refs resolved in its hub, alternates ignored with a warning; link `test/e2e/repos.test.mjs` to "Open through an alternate id"
- [ ] 5.5 Recovery guidance and a recovery skill for unavailable mounts through the portable entry point (no `cd`); rebase `Routing skill guidance` onto `repo-context`'s and `machine-setup`'s text first; link `test/e2e/repos.test.mjs` to "Mount declared but not fetched" and "No repositories" (updated), and `test/e2e/agents.test.mjs` to "Only unfetched mounts" and "Recovery from an unrelated directory"
- [ ] 5.6 Document mounts, including that every admitted MCP client (stdio or HTTP) sees mounted content, in `docs/format.md` and README, mark roadmap step 3 done in `docs/next.md`

## 6. Finish

- [ ] 6.1 Run `npm test`, `node bin/hub.mjs validate`, `openspec validate hub-federation --strict` and `specs archive --rehearse`
- [ ] 6.2 Reconcile the change with `reconcile-change` after the last slice lands
