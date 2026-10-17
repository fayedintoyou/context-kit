# Tasks

## 1. Registry and validation

- [x] 1.0 Wire repositories into core: `repos` operations in the core group, generated skills reported under `core` by `addons`; link `test/e2e/addons.test.mjs` to "Core lists the routing skill" and `test/e2e/repos.test.mjs` to "Core-only workspace routes repositories"
- [x] 1.1 Add `lib/repos.mjs`: collect `type: Repository` concepts across hubs, normalize upstreams (`host/owner/name`), resolve a repo by id, title or alias
- [x] 1.2 Extend `validate` for Repository `resource`, `aliases` and duplicate aliases/titles; link `test/e2e/repos.test.mjs` to "Invalid repository fields" and "Alias claimed twice"
- [x] 1.3 `repos` CLI command listing id, title, upstream, aliases and path or `missing` from `.state/checkouts.json`; link `test/e2e/repos.test.mjs` to "List registered repositories" and "A fresh machine has no checkouts"

## 2. Recording checkouts

- [x] 2.1 `repos locate <repo> <path>` matching any git remote to the upstream, storing the realpath; link `test/e2e/repos.test.mjs` to "Locate by alias" and "Wrong checkout" (fixture repos made with `git init` and remotes, no network)
- [x] 2.2 `repos clone <repo> [<path>]`, default `~/<name>`, refusing existing destinations; link `test/e2e/repos.test.mjs` to "Clone and record" (upstream is a local bare repo registered via a `file://` resource)
- [x] 2.3 `repos scan <directory>` at depth 0–1, skipping hidden and `node_modules`, never overwriting a live recorded path; link `test/e2e/repos.test.mjs` to "Scan finds checkouts"

## 3. Routing skill

- [x] 3.1 Render `my-repos` into `.state/generated/my-repos/SKILL.md` deterministically (description with titles and aliases, 1,000-character fallback, `metadata.repositories`, body rules); none when no repositories; link `test/e2e/repos.test.mjs` to "Skill names every repository", "Missing checkout guidance" and "No repositories", asserting both agents' allowed frontmatter keys
- [x] 3.2 Installer: include generated skills, always copied even with `--link`, removed when no longer generated; link `test/e2e/agents.test.mjs` to "Install the routing skill" and "Last repository removed"
- [x] 3.3 `agents status` compares a fresh render to the record and reports `stale`; `locate|clone|scan` refresh unchanged installed copies and report edited ones; link `test/e2e/agents.test.mjs` to "Pulled hub changes" and "Locating refreshes the skill"

## 4. MCP, help and docs

- [x] 4.1 Read-only `list_repos` MCP tool in `lib/operations.mjs`; link `test/e2e/repos.test.mjs` to "List over MCP"
- [x] 4.2 Document `Repository` fields (`resource`, `aliases`) in `docs/format.md`, add a `repos` help topic and usage lines, and mention the routing skill in `skills/context-kit/references`
- [x] 4.3 Run `npm test` and `openspec validate repo-registry --strict`

## Workflow follow-up

- Upgrade `~/context`, add `aliases` to `personal/projects/room`, run `repos scan ~` and `agents install`, and check that "my room has a new issue" routes to `~/room`
- Archive the change after merge
