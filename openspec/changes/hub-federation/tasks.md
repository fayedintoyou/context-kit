# Tasks

Every slice that adds a command, MCP tool or error code also adds it to the help
topics, so `help / Help covers the tool` keeps passing.

## 1. Mount lifecycle (slice `mount-lifecycle`)

- [ ] 1.1 Accept `mounts` in `context-kit.json` (name pattern, `source`, `path`, `ref`, 40-hex `commit`, no other keys; name not a workspace hub ID); link `test/e2e/mounts.test.mjs` to "Invalid mount declaration"
- [ ] 1.2 Add `lib/mounts.mjs`: resolve a ref with `git ls-remote`, fetch a commit into the bare cache under `.state/mounts/.git/<name>`, export `<path>` at that commit into `.state/mounts/<name>/<commit>/` read-only; `mounts add` checks the exported tree is a loadable hub before writing the config; confine `path` and reject escaping symlinks; link `test/e2e/mounts.test.mjs` to "Mount a hub from another repository" and "Source is not a hub" (fixtures: local bare repositories over `file://`, no network)
- [ ] 1.3 `mounts fetch [<name>]` per mount with `FETCH_FAILED` isolation and nonzero exit; link `test/e2e/mounts.test.mjs` to "Fresh machine fetches its mounts" and "One source unreachable"
- [ ] 1.4 `mounts remove <name>` deletes the entry and fetched trees; link `test/e2e/mounts.test.mjs` to "Remove a mount"
- [ ] 1.5 `mounts` (CLI) and read-only `list_mounts` (MCP) with status, `manifestId` and per-tier trust counts; add/fetch/upgrade/remove are `cliOnly`; link `test/e2e/mounts.test.mjs` to "List over CLI and MCP"
- [ ] 1.6 `mounts` help topic, usage lines and new error codes (keeps `help / Help covers the tool` passing); point OKF links in README, `docs/format.md` and `skills/context-kit` references at https://github.com/GoogleCloudPlatform/open-knowledge-format

## 2. Reading mounted hubs (slice `mounted-reads`)

- [ ] 2.1 Load fetched mounts leniently after workspace hubs, under their mount name, with `mount` provenance and the mount's freshness policy; link `test/e2e/mounts.test.mjs` to "Read a mounted concept" (CLI and MCP SDK client)
- [ ] 2.2 `ref` on every concept result; `read <ref>` and `read_concept` with `concept` as a reference and `id` optional; link `test/e2e/mounts.test.mjs` to "Read by reference"
- [ ] 2.3 Keep bundles separate (own index, log, `okf_version`, IDs); link `test/e2e/mounts.test.mjs` to "Same paths in two bundles"
- [ ] 2.4 Mounted manifests: `manifestId`, warnings for unknown `links`, `skills`, `specStores`, none offered; link `test/e2e/mounts.test.mjs` to "Manifest fields that point elsewhere"
- [ ] 2.5 `READ_ONLY_MOUNT` guard in capture and repository adds (CLI and MCP); link `test/e2e/mounts.test.mjs` to "Writes against a mount"
- [ ] 2.6 Unfetched and broken mounts: `MOUNT_NOT_FETCHED`/`MOUNT_BROKEN` when addressed, warnings in list, search, repos and validate, mounted problems never failing validate; link `test/e2e/mounts.test.mjs` to "Mount not fetched yet" and "Broken mount"

## 3. Upgrades (slice `mount-upgrade`)

- [ ] 3.1 `mounts upgrade <name> [--to <rev>] [--check]` with the concept and repository diff between commits; link `test/e2e/mounts.test.mjs` to "Upstream moves on"

## 4. Links into mounts (slice `mount-links`)

- [ ] 4.1 Classify `<mount>:/<id>` links and same-source outside links from loaded file sets; keep existing kinds; link `test/e2e/navigate.test.mjs` to "Follow links" (unchanged), "Link into a mount", "Outside link a mount covers" and "Link into an unfetched mount"

## 5. Mounted repositories (slice `mounted-repositories`)

- [ ] 5.1 Registry reads fetched mounts' Repository concepts as `<mount>:/<id>` with `mount`; `my-repos` lists them with their mount and read command; mount commands refresh installed unchanged copies; link `test/e2e/repos.test.mjs` to "One person's hub on two machines" and "Many people, one hub", and `test/e2e/agents.test.mjs` to "Upgrade brings a new repository"
- [ ] 5.2 Precedence and warnings for names and upstreams across mounts; link `test/e2e/repos.test.mjs` to "Workspace keeps its alias", "Two mounts claim an alias" and "Same upstream twice"
- [ ] 5.3 Routing skill body names unavailable mounts with `mounts fetch`; link `test/e2e/repos.test.mjs` to "Mount declared but not fetched"
- [ ] 5.4 Document mounts in `docs/format.md` and README, mark roadmap step 3 done in `docs/next.md`

## 6. Finish

- [ ] 6.1 Run `npm test`, `node bin/hub.mjs validate`, `openspec validate hub-federation --strict` and `specs archive --rehearse`
- [ ] 6.2 Reconcile the change with `reconcile-change` after the last slice lands
