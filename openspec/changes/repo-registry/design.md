# Design

## Context

Hubs already hold `type: Repository` concepts (e.g. `personal/projects/room`, with
`resource: https://github.com/fayedintoyou/room`). The installer copies or links
addon skills from a source directory, records each in `.state/agents.json`, and
detects `changed` and `stale` copies by hashing. `.state/` is untracked in every
workspace (`init` writes it to `.gitignore`). Both agents accept the frontmatter keys
`name`, `description`, `license`, `allowed-tools` and `metadata`.

## Goals / Non-Goals

**Goals:**
- An agent that hears a repository's name or alias goes straight to its checkout.
- The repository list is shared through the workspace's git; checkout paths never are.
- Setting up a new machine takes one command (`repos scan ~` or `repos clone`).

**Non-Goals:**
- Refreshing the skill automatically on `git pull` or on every session (status
  reports it stale instead; a session hook can come later).
- Matching free text to repositories in the CLI. The agent does that from the
  skill's description; the CLI accepts only ids, titles and aliases.
- Mounting or federating other people's hubs (separate roadmap item).
- Non-git repositories.

## Decisions

0. **Core, not an addon.** Knowing where the user's repositories are is as basic as
   reading hubs, so it lives in core next to browse, read and capture. The `repos`
   operations get no operation group (core is the default group), and core's
   skills are its bundled `context-kit` plus the generated `my-repos`. Alternative:
   a kit addon enabled by default. Rejected because a workspace could then switch
   routing off and agents would fall back to searching the filesystem.

1. **The registry is the Repository concepts, not a separate `repos.yaml`.** They
   already exist, carry the knowledge about each repo, are shared with the hub, and
   go through validate and review. A second list would drift from them. The YAML
   list the user asked for is in the generated skill's `metadata`, rendered from
   the concepts plus local paths. Adding `aliases` is an extra frontmatter key,
   which OKF allows.

2. **Checkouts live in `.state/checkouts.json`, keyed by normalized upstream.**
   Normalize the upstream to `host/owner/name`, lowercased, without the protocol,
   user or `.git`, so `git@github.com:Owner/Room.git` and
   `https://github.com/owner/room` match. Keying by upstream rather than concept id
   keeps paths valid when a concept is renamed or moves between hubs. Alternative:
   a per-user file under XDG config. Rejected because checkouts belong to this
   workspace, next to `agents.json`.

3. **The routing skill is rendered into `.state/generated/my-repos/` and installed
   through the existing skill path.** The installer gets one list of skills: addon
   skills plus generated ones. Generated skills are always copied, never linked, so
   the installed file is exactly what was rendered. Staleness is a comparison
   between a fresh render and the recorded source hash. That reuses `changed`,
   `stale`, `removed` and conflict handling unchanged.

4. **The rendered skill is small and deterministic.** It contains:
   - Frontmatter: `name: my-repos`; a `description` naming each repository's title
     and aliases (for example `"the room (room, fayelore.com)"`); and `metadata`
     mapping each id to `"<upstream> at <path>"` (or `(missing on this machine)`).
     Agent Skills defines `metadata` as a string-to-string map, so the full YAML
     list (`id`, `title`, `aliases`, `upstream`, `path`) is a fenced block in the
     body, which agents read, rather than nested frontmatter one agent might reject.
   - A body giving that list plus the rules: work in `path`; do not search the
     filesystem; if `missing`, offer `repos clone <id>` or `repos locate <id>
     <path>`; when the user starts a new repository, suggest registering it as a
     Repository concept.

   Entries are sorted by id, with no timestamps, so unchanged inputs produce
   identical bytes. If the description would pass 1,000 characters, titles stay
   and aliases are left out, with a note that the full list is in the metadata.

5. **Locate checks remotes and doesn't guess.** `git -C <path> remote -v`. Any
   remote (not only `origin`) whose normalized URL equals the upstream counts. The
   path is stored as its realpath.

6. **Scan is explicit and shallow.** Depth 0 and 1 only, skipping `node_modules`
   and hidden directories, so `repos scan ~` stays fast. An agent never runs it
   unprompted; the skill tells agents to ask the user first.

7. **`repos locate|clone|scan` refresh installed copies.** After recording, they
   re-render. For each installed `my-repos` record whose copy is unchanged, they
   rewrite it and update its hashes. The routing skill stays current without
   re-registering MCP servers. MCP gets only `list_repos`: locate and clone write
   to the filesystem or the network, so they stay CLI-only and run when the user
   asks.

8. **Default clone path is `~/<name>`**, where `<name>` is the upstream's
   repository name, matching how checkouts sit in the home directory today. An
   explicit path overrides it.

9. **Pull hooks are per machine, written by `agents install`.** The hook runs this
   machine's Node and core by absolute path, like the MCP registration, so it
   can't be committed to the workspace. The installer writes it into the
   checkout's hooks directory (`git rev-parse --git-path hooks`, which honors
   `core.hooksPath`), marks it as managed, and records it with a hash, like
   skills. Alternative: a tracked `.githooks/` directory plus
   `core.hooksPath`. Rejected because setting `core.hooksPath` silently turns off
   every hook already in `.git/hooks`, and tracked hooks can't hold
   machine-specific paths. A workspace that isn't a git checkout yet reports the
   hooks as skipped.

10. **`repos add` writes a draft concept, never local paths.** The concept goes to
    `<hub>/<concept>.md` (default concept id: the upstream's repository name) with
    `status: draft` and `generated` set to the real actor and time, following the
    rule that agents write curated concepts only as drafts. It is appended to the
    index in the concept's directory, or the hub's root index. Existing upstreams,
    concept files and alias collisions are refused before anything is written.
    `--path` is CLI-only for the same reason `locate` is.

## Risks / Trade-offs

- [Many repositories make a long description and weaker triggering] → Drop aliases
  past 1,000 characters (decision 4). Hubs can split repositories across
  workspaces if that ever matters.
- [The skill goes stale after a pull until `agents install`] → `agents status`
  flags it, and a later session hook can run the refresh.
- [Aliases collide across repositories] → `validate` reports an alias claimed by
  two repositories, and `locate` refuses an ambiguous name.
- [A checkout moves] → `repos` reports it `missing`, and `locate` or `scan`
  records the new place. The skill's body says not to search.

## Migration Plan

Additive. Existing Repository concepts become registered with no edits. A concept
without a usable `resource` fails `validate`. On upgrade:
1. Add `aliases` to `personal/projects/room`.
2. Run `repos scan ~`.
3. Run `agents install`.

Rollback: uninstall removes the generated skill like any other.
