# Design

## Context

- Repository concepts are the registry (`lib/repos.mjs` `registry()`). Each is
  `<hub-id>/<concept-id>` with `resource` and `aliases`. Checkouts live in
  `.state/checkouts.json`, keyed by normalized upstream. `recordedCheckout()`
  already returns the `repos locate`/`repos clone` remedies.
- OKF concept frontmatter is permissive: unknown keys are allowed, and only
  `hub.json` rejects unknown fields. So `context` is new *meaning* for a key on
  one concept type. It is validated strictly when present, and every other
  concept keeps OKF's permissiveness (`knowledge-format / Permissive consumption`
  still holds).
- The routing skill is rendered deterministically into `.state/generated/my-repos/`,
  and staleness is a re-render comparison, so new rendered content is picked up
  by `agents status`, `agents install`, `repos sync` and the pull hooks for free.
- Agent Skills frontmatter allows only `name`, `description`, `license`,
  `compatibility`, `metadata` and `allowed-tools`, and claude.ai uploads
  hard-error on anything else. The sibling change `machine-setup` owns the
  routing skill's frontmatter and installation, so this change touches only
  its body.
- `find()` in `lib/repos.mjs` already resolves an id, title, alias or upstream
  name deterministically (`UNKNOWN_REPOSITORY`, `AMBIGUOUS_REPOSITORY`), and
  `listRepositories()` already layers this machine's checkouts over the
  registry. Today the agent receives the result only as skill text.
- Glob matching already exists twice (`lib/landing.mjs`, `lib/specs/progress.mjs`)
  with `*`, `**` and `?` semantics.
- MCP 2026-07-28 deprecates Roots, so tools take the repository, path and pack
  as explicit arguments and never infer them from client roots.

## Goals / Non-Goals

**Goals:**
- An agent told "work on <repo>" makes one call, `repos open <repo>` (MCP
  `open_repo`), and has the path, the instruction files to read, the relevant
  concept, skill and MCP pointers, and a tree of the checkout, so it doesn't
  scout.
- A fresh worker (a subagent, a teammate, a new session) bootstraps from that
  result in roughly 1–2k tokens, then pulls more only as needed with `read`,
  `read-skill` or `repos pack`.
- A pack is a pure function of the hubs, the checkout's tracked files and the
  arguments, so two agents, or a builder and its reviewer, can compare packs
  by hash and cache them.
- Nothing a hub says is executed, fetched or installed.

**Non-Goals:**
- Inline file contents, summaries or symbol maps in packs (the agent reads the
  listed files with its own tools). The default tree lists paths only.
- Ranking, retrieval or embeddings. A pack is exactly what was declared.
- Detecting the repository or area from the caller's working directory.
  Callers name them.
- Federation's mount resolution. This change only reserves the reference form.

## Decisions

0. **One resolve-and-load call.** `repos open` is the centre of the change.
   Resolution is two explicit layers, both already in Context Kit:

   ```
   name ──▶ shared registry (Repository concepts in hubs, committed)  ──▶ upstream
   upstream ──▶ machine overlay (.state/checkouts.json, untracked)    ──▶ local path
   ```

   The result records both steps: `resolution: { name, matched: "alias",
   concept: "team/fruit/orchard", upstream, path, source: "machine" }`. Once the
   path is known, the same call loads the instruction-file pointers, the
   concept and declared pointers, and the default pack. An unmapped repository
   is a successful result with `status: missing` and `next` (the exact locate
   and clone commands), not an error, because the pointers are still useful
   and the agent's next step is to ask the user. `repos pack` stays separate
   for declared packs and roles, which cost more and are requested for a
   particular action. Alternative: keep a pointer-only `repos context` and
   leave the tree to the agent. Rejected: that's the scouting this removes.

1. **One `context` mapping on the Repository concept, not new top-level keys or
   separate concepts.** Fictional example:

   ```yaml
   type: Repository
   title: the orchard
   resource: https://github.com/example/orchard
   aliases: [orchard]
   context:
     verify: ["npm test", "npm run lint"]
     concepts: [/guides/harvest, personal/notes:/orchard/ideas]
     skills: [kit:independent-review]
     mcp: [orchard-tracker]
     areas:
       - path: services/billing
         concepts: [/guides/billing-ledger]
         mcp: [ledger-db]
     packs:
       release:
         description: Cut a release of the orchard.
         files: [CHANGELOG.md, "docs/release/**", "notes/**"]
         exclude: ["**/*.tmp"]
         concepts: [/guides/release-builder, /guides/release-checklist]
         limits: { files: 60, bytes: 262144 }
         roles:
           reviewer:
             exclude: ["notes/builder/**"]
             omit: [/guides/release-builder]
   ```

   One namespaced key means strict validation has a clear boundary, and it
   can't collide with OKF or other tools' keys. Alternative: a
   `RepositoryArea` concept type pointing at its repository. Rejected for now.
   It spreads one repository's routing over many files, and the pointers live
   with the routing they extend. It can be added later if areas grow large.

1a. **Verification commands are declared text.** `verify` is the one place a
   hub holds command lines, and it's deliberately not configuration Context
   Kit acts on. `repos open` returns the strings, and the agent runs them in
   the checkout under its own permissions. The routing skill already says to
   follow the checkout's workflow, and `verify` makes that workflow's checks
   explicit and identical across sessions. This is why MCP entries can be
   names only while `verify` can be text: one names a capability to look up,
   the other is an instruction to a person or agent. Packs don't include
   `verify`, and their manifest hash doesn't cover it.

2. **Concept references are `[<hub-id>:]/<concept-id>`.** The leading `/` reads
   as hub-root-relative, like root-relative links. The qualifier is resolved by
   one function that, in this change, knows workspace hub IDs. Hub IDs can't
   contain `:`, so the grammar is unambiguous. `hub-federation` can teach that
   resolver mount namespaces (`team-data:/tables/orders`) without changing the
   field format or any stored reference. Unqualified references never fall back
   to other hubs, so adding a hub or mount can't silently change what a
   reference means.

3. **Skills use manifest reference forms. MCP entries are bare names.** Skill
   references reuse the hub-manifest resolver (`kit:<name>` or a workspace
   `SKILL.md` path), so `read-skill` works on what `repos open` returns. MCP
   entries match `^[a-z0-9][a-z0-9_-]{0,63}$`. That rejects URLs, command
   lines, mappings and anything carrying a secret by construction, so a hub
   never becomes MCP configuration. A purpose string per server was considered
   and left out. The concept body can explain, and a mapping form would invite
   configuration.

4. **Areas carry pointers only, keyed by a literal directory path.** A subpath
   matches an area when the area path equals it or is a `/`-segment prefix of
   it. Pointers merge outermost-first after the repository's own, deduplicated
   by reference. Areas without a subpath are summarized as counts (spec: *Areas
   and packs summarized*) to hold the bootstrap budget. Area paths
   aren't checked against a checkout at validate time, because checkouts are
   machine-local. `repos open` warns when a located checkout lacks an area's
   directory.

5. **Pointer shape.** Concept pointers reuse the OKF summary already computed
   for browse (type, title, description capped at 300, trust) plus the
   freshness action, `hub`, `concept` and the `ref` as written. Skill pointers
   reuse `list_skills`' name and description. No bodies. Over a typical
   repository (a handful of concepts and skills, two or three packs) this is
   ~1–2k tokens. The design budget is a soft target, enforced by the 300-char
   description cap, list caps (50 entries per list, 50 areas, 20 packs, 8 roles
   per pack, 50 globs per list), and the existing 128 KiB output ceiling.

5a. **The default pack needs no configuration.** It holds the
   instruction-file pointers, the repository concept, and a tree built from
   `git ls-files` under the root or subpath. The tree has every path at depth
   1 and 2 in code-point order, each directory with its tracked-file count,
   and nothing deeper (counts cover it), capped at 150 entries with
   `truncated`. Git-tracked means `.gitignore` is respected by construction,
   and the output depends only on the index and working tree. Depth 2 and 150
   entries come to about 1–1.5k tokens of paths, which keeps the whole `open`
   result near the 1–2k target. Instruction files are `AGENTS.md` and
   `CLAUDE.md` exactly (the two the routing skill already names), at the root
   and in each directory down to the subpath. Every declared pack also carries
   the default pack's instruction and concept pointers but not its tree, so a
   pack is never missing the repository's own rules. `repos pack <repo>
   default` returns the default pack alone, and `default` is reserved as a
   pack name.

6. **Pack expansion is a fixed built-in algorithm over `git ls-files`.**
   - Candidates are `git -C <checkout> ls-files -z --cached` (the index, so
     ignored and untracked files never appear). Untracked files that match are
     counted by `git ls-files --others --exclude-standard` filtered by the
     globs, for the `skipped` report only.
   - Each candidate is `lstat`ed. Symlinks, gitlinks (submodules) and entries
     missing from the working tree are skipped and counted. Regular files are
     hashed with SHA-256 over their working-tree bytes, so uncommitted edits
     show up. `dirty` comes from `git status --porcelain` restricted to the
     listed files.
   - Include globs are matched, then exclude globs (pack and role) remove.
     Paths are sorted by code point (as `browse` sorts), then the file and
     byte limits stop the listing at the first file that would exceed either.
     `truncated` names the limit, the omitted count and the first omitted
     path. Stopping at the first overflow (rather than skipping big files and
     continuing) keeps the result easy to predict from the sorted list.
   - The manifest hash is SHA-256 over a canonical JSON of the repository id,
     pack, role, commit, dirty flag, files and references. It leaves out the
     checkout path, MCP availability and the seed, so two machines with the
     same commit agree. Pack concept pointers carry `ref`, `hub`, `concept`,
     `type` and `title` only, without the time-dependent trust, staleness and
     freshness that `repos open` reports. Otherwise a pack would change as
     its concepts age.
   - Every git call runs with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`
     and `GIT_OPTIONAL_LOCKS=0`, and uses only `ls-files`, `rev-parse` and
     `status`. A checkout's own config then can't make Context Kit run a
     command, and a pack never takes the index lock.
   - Glob matching is the existing `*`/`**`/`?` matcher, moved into one shared
     helper used by landing, progress and packs. No braces, negation or
     character classes, which `validate` rejects. No new dependency and no
     experimental `path.matchesGlob`.

7. **Budgets.** Defaults are 100 files and 512 KiB, which a pack's `limits`
   may raise up to the hard maxima of 500 files and 4 MiB. Callers may only
   lower the byte budget, with `--budget`. Bytes are the summed sizes of listed
   files: the reading cost the agent is being handed, not the manifest's own
   size. That stays small (about 120 bytes per entry, so 500 entries fit well
   within the 128 KiB output ceiling). Token budgets were considered. Bytes
   are deterministic across models and tokenizers. The help topic gives the
   rough 4-bytes-per-token rule.

8. **Roles inherit and subtract, and report withheld counts only.** A role is
   the pack plus its additions, minus its `exclude` globs and `omit`
   references. The result reports `withheld: { files, concepts, skills, mcp }`
   as counts, so a reviewer pack doesn't point the reviewer at the builder's
   notes it was meant not to see. The builder and reviewer manifests have
   different hashes, so an orchestrator can confirm the reviewer got the
   reviewer pack. Alternative: roles as fully independent packs. Rejected,
   because the common case is "same pack, minus a few things", and duplication
   would drift.

9. **MCP availability asks each agent's CLI, only on request.** `--check-mcp`
   runs `claude mcp get <name>` and `codex mcp get <name>` with a short
   timeout, from the located checkout (so Claude Code's project and local
   scopes count) or the workspace otherwise. This is the same probe `agents
   install` uses. Exit 0 means `available`, non-zero means `missing`, and a
   missing CLI or timeout means `unknown`. It's off by default because
   spawning CLIs on every bootstrap is slow and an MCP server calling its own
   host's CLI is surprising. Context Kit never calls `mcp add`. Remediation is
   left to the user or agent, guided by the concept body.

10. **Seeded front matter is a deterministic OKF mapping.** It includes `type:
    ContextPack`, `title`, `description`, `status: draft`, `resource`
    (upstream) and `context_pack: { repository, pack, role, commit,
    manifest_hash, concepts, files }`. No `generated` or `verified` (they need
    times and actors, and the agent adds `generated` when it writes the note),
    so the seed stays byte-stable. `capture` keeps writing `type: Note`. Using
    a seed as a working note is the agent's choice, not a new write path.

11. **Operations live in core and are read-only.** `open_repo` and
    `context_pack` sit beside `list_repos` (repositories are core), are offered
    on read-only MCP servers including HTTP, and take `repository`, `path`,
    `pack`, `role`, `budget`, `seed` and `checkMcp` as explicit arguments.
    `list_repos` already exposes checkout paths, and packs return paths,
    sizes and hashes but no contents, so remote exposure doesn't grow
    materially.

12. **The routing skill just says "open it".** Its body gains one instruction:
    when a request names a repository, run the exact `repos open <id>` command
    given for it (or call `open_repo`) first, and work from the result. The
    pack names, MCP servers and trees aren't copied into the skill. The skill
    stays small and doesn't go stale when a hub edits `context`, and the
    frontmatter (description, metadata, the 1000-character cap) is untouched,
    leaving it to `machine-setup`. The existing "read AGENTS.md first" guidance
    stays and is now backed by the pointers `open` returns.

## Risks / Trade-offs

- [Hub authors write broad globs (`**`) that blow the budget] → Budgets stop
  the listing with an explicit `truncated` report. `validate` can't know file
  counts, so the help topic recommends narrow globs.
- [References rot as concepts move] → `validate` fails on them, and reads mark
  them `missing` with a warning instead of failing (spec: *Lenient context
  reads*).
- [The tree is noise for huge monorepos] → Depth 2 and 150 entries bound it,
  and `repos open <repo> <subpath>` roots the tree at the area being worked
  on. Declared packs give precise selections.
- [The reference form diverges from what `hub-federation` settles on] → The
  qualifier resolver is the single point to extend. If federation picks a
  different separator, this change's references need a mechanical rewrite
  before either archives. Flagged to the owner.
- [Withheld counts leak that something was withheld] → Accepted. Hiding the
  fact would make reviewer packs look complete when they aren't, and the
  counts reveal no names.
- [A hostile checkout configures git to run commands (`core.fsmonitor`)] →
  Decision 6 disables it on every call, and an e2e fixture sets
  `core.fsmonitor` to a command that writes a marker file, which must never
  appear.
- [`claude mcp get` semantics change across versions] → Results degrade to
  `unknown`, never to an install. The probe is the one `agents install`
  already depends on.
- [A pack includes a secret file that's tracked] → Packs return hashes, not
  contents. The file was already in the repository. The help topic says not to
  point packs at secrets.

## Migration Plan

Additive. Every registered repository can be opened immediately, with its
default pack and no edits. `my-repos` gains the open instruction on the next
`repos sync`, pull hook or `agents install`. Declare `context` on a Repository
concept when the defaults aren't enough, and run `validate`. Rollback: remove the `context` keys.
An older core ignores them as OKF extra keys.

## Open Questions

- Default limits (100 files, 512 KiB) and hard maxima (500, 4 MiB) are first
  guesses. Tuning them after real packs exist is a small amendment to *Pack
  declarations* and *Pack budgets*, not a change of approach.
