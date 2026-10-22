# Design

## Context

- Repository concepts are the registry (`lib/repos.mjs` `registry()`). Each is
  `<hub-id>/<concept-id>` with `resource` and `aliases`. Checkouts live in
  `.state/checkouts.json`, keyed by normalized upstream. `find()` already
  resolves an id, title, alias or upstream name (`UNKNOWN_REPOSITORY`,
  `AMBIGUOUS_REPOSITORY`), and `recordedCheckout()` already returns the
  `repos locate`/`repos clone` remedies. Today the agent gets these only as
  skill text.
- OKF concept frontmatter is permissive: unknown keys are allowed, and only
  `hub.json` rejects unknown fields. So `context` is new *meaning* for a key on
  one concept type. It is validated strictly when present, and every other
  concept keeps OKF's permissiveness (`knowledge-format / Permissive consumption`
  still holds).
- Sibling changes own neighbouring ground:
  - `machine-setup` (#50) owns the routing skill's frontmatter renderer, an
    optional `keywords` field on Repository concepts, and the remote-access
    parity amendment. That amendment includes the rule that tools resolving
    this machine's checkouts are local-only (as its `which_repo` is). This
    change only edits the skill body, keeps `keywords` out of `context`, and
    relies on that rule rather than amending `remote-access`.
  - `hub-federation` (#48) uses the same `<qualifier>:/<id>` reference form.
  - The prerequisite `slice-aware-links` lets each slice keep the spec-link
    gate green.
- `getSkill()` (`lib/workspace.mjs`) reads a skill only through a hub whose
  manifest declares it, and `listSkills()` hides `kit:` skills of disabled
  addons.
- Glob matching exists twice, with different semantics:
  - `lib/landing.mjs`: `**/` matches zero or more directories, a bare `**`
    matches anything, and there's no trailing-`/` rule.
  - `lib/specs/progress.mjs`: `**` swallows a following `/`, so `a/**/b`
    also matches `a/xb`, and a trailing `/` matches everything below.
- MCP 2026-07-28 deprecates Roots, so tools take the repository, path, role
  and pack as explicit arguments.

## Goals / Non-Goals

**Goals:**
- An agent told "work on <repo>" makes one call, `repos open <repo>` (MCP
  `open_repo`). It gets the path, the instruction files to read, the
  verification commands, the relevant concept, skill and MCP pointers, and a
  tree of the checkout, in at most 8 KiB (about 2k tokens). It doesn't scout.
- A fresh worker bootstraps from that result, then pulls more only as needed
  with `read`, `read-skill` or `repos pack`. A reviewer bootstraps with
  `--role reviewer` and never sees what the role withholds.
- A pack's canonical payload is a pure function of declared inputs and file
  bytes. Builders, reviewers and machines can then compare hashes.
- Nothing a hub says is executed, fetched or installed. Reading a checkout
  never runs its git configuration.

**Non-Goals:**
- Inline file contents, summaries or symbol maps in packs or the tree.
- Ranking, retrieval or embeddings.
- Detecting the repository from the working directory (`machine-setup`'s
  `repos which` does that). `open` ignores the cwd.
- Federation's mount resolution, `keywords`, skill frontmatter, and serving
  checkouts remotely.

## Decisions

0. **One resolve-and-load call.** `repos open` is the centre of the change.
   Resolution is two explicit layers:

   ```
   name ──▶ shared registry (Repository concepts in hubs, committed)  ──▶ upstream
   upstream ──▶ machine overlay (.state/checkouts.json, untracked)    ──▶ local path
   ```

   The result records both steps: `resolution: { name, matched: "alias",
   concept: "team/fruit/orchard", upstream, path, source: "machine" }`. Once the
   path is known, the same call returns the instruction pointers, the
   repository concept, and (once `fields` lands) `verify` and the declared
   pointers, plus the default bootstrap tree.

   An unmapped or stale repository is a successful `status: missing` result
   with `next` (the exact locate and clone commands), not an error. The
   pointers are still useful, and the agent's next step is to ask the user.
   `repos pack` stays separate because it costs more and is asked for per
   action. Alternative: a pointer-only `repos context`, leaving the tree to
   the agent. Rejected, because that's the scouting this removes.

1. **One `context` mapping with a closed schema.** Fictional example:

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
     roles:
       reviewer:
         exclude: ["notes/builder/**"]
         omit: [/guides/release-builder]
         concepts: [/guides/review-checklist]
     packs:
       release:
         description: Cut a release of the orchard.
         files: [CHANGELOG.md, "docs/release/**", "notes/**"]
         exclude: ["**/*.tmp"]
         concepts: [/guides/release-builder, /guides/release-checklist]
         limits: { files: 60, bytes: 262144 }
   ```

   Every level rejects unknown keys, and every string and list has a bound
   (spec: *Context schema*, *Context bounds*). One namespaced key gives strict
   validation a clear boundary and can't collide with OKF, other tools, or
   `machine-setup`'s `keywords`. Alternative: `RepositoryArea` concepts.
   Deferred until a monorepo needs it.

   `verify` is the one place commands appear. They're declared text the agent
   is told to run under its own permissions, never something Context Kit acts
   on. That's why MCP entries are names only (a capability to look up) while
   `verify` is text (an instruction). Packs don't include `verify`.

1b. **Several concepts, one repository.** Resolution never assumes a single
   registering concept: it reports the canonical concept and any alternate ids.
   Which concept's `context` applies when `hub-federation` (#48) merges
   concepts sharing an upstream is specified and tested only there (#48's
   *Context from the canonical concept*, landing after this change's `fields`
   slice). This change defines `context` for one concept and depends on no #48
   slice.

2. **Concept references are `[<hub-id>:]/<concept-id>`.** The leading `/` reads
   as hub-root-relative. One resolver handles the qualifier, and in this
   change it knows workspace hub IDs. Hub IDs can't contain `:`. `hub-federation`
   (#48) extends the same resolver to mount namespaces without changing stored
   references. Unqualified references never fall back to other hubs.

3. **Skill pointers are readable by construction.** `validate` accepts a skill
   reference only when some hub's manifest declares it and, for `kit:`, an
   enabled addon provides it. That is exactly when `getSkill()` and
   `listSkills()` serve it. The pointer carries `hub` (the first declaring
   hub in hub-ID order) and `reference`, the arguments `read-skill`/`read_skill`
   take. Alternative: a new read path that bypasses manifests. Rejected,
   because declaring a skill in a hub is the existing authorization step.

4. **Areas carry pointers only, keyed by a literal directory.** An area matches
   a subpath when its path equals it or is a `/`-segment prefix of it. Pointers
   merge outermost-first, deduplicated. Areas without a subpath are summarized
   as counts.

5. **The default bootstrap fits a byte allowance.** The tree is built from the
   index (decision 7). It holds paths at depth 1 and 2 in code-point order,
   directories with their tracked-file counts, and nothing deeper, with at
   most 150 entries. The whole `open` result must fit 8 KiB of compact JSON
   (`JSON.stringify` without spacing), about 2k tokens. When it doesn't, the
   tree is trimmed from the end first, then declared pointers from the end,
   and `truncated` reports what went and the first omitted path.

   Instruction files are `AGENTS.md` and `CLAUDE.md` exactly, at the root and
   in each directory down to the subpath. They're the deliberate exception to
   tracked-only: agents load them from the checkout whether or not git tracks
   them, so pointing at untracked ones is honest. They must still pass the
   containment rule (decision 6). Every pack carries the instruction pointers.
   `repos pack <repo> default` returns the default bootstrap's files and
   references as a canonical payload, and `default` is reserved as a pack
   name.

6. **Containment is checked per component, before opening.** Paths are
   relative, `/`-separated, without `.`, `..`, backslash or leading `/`. Every
   read walks from the checkout's real root, `lstat`ing each component. A
   symlink anywhere below the root (not only the final component) means a
   subpath fails with `PATH_ESCAPE` and a file is skipped and counted. The
   final file is opened with `O_NOFOLLOW` and its real path checked against
   the root. This defeats a tracked directory replaced by an outside-pointing
   symlink. The same walk serves instruction files, the tree and packs.

7. **Git is read only from the index and HEAD, with configuration disabled.**
   Working-tree comparisons (`status`, `diff`, `ls-files -m`) can run clean
   and process filters, and fsmonitor can run on refresh. So Context Kit
   never runs them. It runs only:
   - `git rev-parse --show-toplevel` and `--show-object-format`;
   - `git rev-parse HEAD`;
   - `git ls-files -z --stage` (the index's paths, modes and blob IDs; no
     working-tree read, no refresh).

   Each call uses an environment with every `GIT_*` variable removed, then
   `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
   `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and `-c core.fsmonitor=false
   -c core.hooksPath=/dev/null -c core.untrackedCache=false`. It never fetches.
   Node reads and hashes the files itself. `dirty` compares the git blob ID of
   the raw working-tree bytes with the index's blob ID (SHA-1 or SHA-256 per
   the object format). A file whose index content went through a filter
   (CRLF, LFS) can therefore show as dirty. That's documented and safe.

   The claim is limited to what these commands do. None of them converts
   content or refreshes the index, and the hostile-config fixture (fsmonitor,
   clean filter and process filter each writing a marker) proves no marker
   appears. Untracked files are never listed or counted, since counting them
   would need a working-tree walk git configuration can hook.

8. **One canonical payload, open-time data beside it.** A pack result is
   `{ payload, hash, annotations }`:
   - The `payload` holds the repository id and upstream, pack, role, HEAD, the
     instruction files and selected files (path, size, SHA-256, `binary`), the
     concept references (`hub`, `concept`), the skill references, the MCP
     names, `dirty`, `missing`, `skipped` counts, `truncated` and `withheld`
     counts.
   - The `hash` is SHA-256 of the payload's canonical JSON (sorted keys, no
     spacing).
   - The `annotations` hold the checkout path, concept titles, trust and
     freshness, and MCP availability. They aren't hashed, so aging, moving
     the checkout and probing never change the hash.

   Files are sorted by code point. Each is `lstat`ed and its size checked
   against the remaining budget before it's opened, so a file over budget is
   never read. Binary means a NUL in the first 8 KiB. Binary files are listed
   (size and hash) and count toward the budget like text.

9. **Budgets.** Defaults are 100 files and 512 KiB, raised by `limits` up to
   500 files and 4 MiB, and only lowered by `--budget`. The listing stops at
   the first file that would exceed either limit, which keeps it predictable
   from the sorted list. Bytes rather than tokens because bytes are the same
   for every model. The help gives the rough 4-bytes-per-token rule.

10. **Roles are workspace-level and apply from the first call.** Roles sit
    under `context.roles`, not inside a pack, so `repos open --role reviewer`
    can filter the bootstrap itself. A role's `exclude` removes files from
    the tree and every pack, `omit` removes declared pointers, and its own
    pointers are added. Instruction files are never withheld, because a
    reviewer must still follow the repository's rules. Results report only
    `withheld` counts. The routing skill tells reviewing agents to pass
    `--role`, and an orchestrator spawning a reviewer passes it explicitly.
    Alternative: roles inside packs (the first draft). Rejected by review,
    because the mandatory unfiltered `open` would show the reviewer what its
    pack later withholds.

11. **Local only.** `open_repo` and `context_pack` read the serving machine's
    checkouts, so under `machine-setup`'s rule they're offered on stdio MCP
    and not on the HTTP server, like `which_repo`. The CLI has both. This
    change adds an ADDED requirement saying so and doesn't modify
    `remote-access`.

12. **Globs: landing's semantics, one shared helper for landing and packs.**
    Packs use `lib/landing.mjs`'s matcher (`**/` = zero or more directories,
    `*` and `?` within a segment, no trailing-`/` rule). It moves to
    `lib/globs.mjs` unchanged, and landing imports it. `lib/specs/progress.mjs`
    keeps its own matcher untouched, because its looser `**` and trailing `/`
    are part of how existing `slices.yaml` paths behave. Merging them would
    be a migration for `change-progress`, out of scope here. The landing tests
    are the regression check, plus new cases for `a/**/b`, `**/x` and `docs/*`
    in the pack tests.

13. **MCP availability asks each agent's CLI, only on request.** `--check-mcp`
    runs `claude mcp get <name>` and `codex mcp get <name>` with a short
    timeout from the located checkout, the probe `agents install` uses. Exit 0
    means `available`, non-zero means `missing`, and a missing CLI or timeout
    means `unknown`. It's off by default everywhere. Context Kit never calls
    `mcp add`.

14. **Seeded front matter is a deterministic OKF mapping.** It holds `type:
    ContextPack`, `title`, `description`, `status: draft`, `resource` and
    `context_pack: { repository, pack, role, commit, hash, concepts, files }`,
    with no `generated` or `verified`. The agent adds `generated` if it writes
    the note.

15. **`open_repo` becomes the resolve operation.** `machine-setup`'s renderer
    (#50, its design §8) names whichever operation the operations table marks
    `resolve`, which is `list_repos` until this lands. The `open` slice marks
    `open_repo` (`repos open`, run through #50's `context-kit` launcher)
    instead, and the `routing` slice updates the one body test so it asserts
    the MCP tool and launcher command name the same repositories. The body says:
    when a request names a repository, open it (`--role <role>` when
    reviewing) and work from the result. Nothing else is copied into the skill, so it doesn't go stale
    when `context` changes, and the frontmatter is left to `machine-setup`.

## Risks / Trade-offs

- [Filtered files show as dirty] → Decision 7 compares raw bytes. This is
  documented, and it errs towards "check this file".
- [Untracked instruction files could be planted] → They're only pointed at,
  pass containment, and are what the agent would load anyway in that checkout.
- [A broad glob blows the budget] → Stopped with an explicit `truncated`
  report, without reading the overflow.
- [References rot] → `validate` fails, and reads mark them `missing`.
- [Withheld counts reveal that something was withheld] → Accepted, so a
  reviewer knows its view is partial. Names never appear.
- [The reference form diverges from `hub-federation`] → One resolver is the
  extension point. #48 uses the same form today.
- [Git versions add refresh or filter behaviour to `ls-files --stage`] → The
  hostile-config fixture runs in CI against the installed git and would fail.

## Migration Plan

Additive. Every registered repository can be opened immediately, with its
default bootstrap and no edits. `my-repos` gains the open instruction on the
next `repos sync`, pull hook or `agents install`. Declare `context` when the
defaults aren't enough, and run `validate`. Rollback: remove `context`. An
older core ignores it as an OKF extra key.

## Defaults adopted for owner review

- The plan merges on its own after `slice-aware-links`.
- `<hub-id>:/<id>`, matching #48.
- A tracked-only tree (instruction files excepted), depth 2 and up to 150
  entries, as an upper bound under the 8 KiB allowance.
- Packs list files only, without contents.
- MCP probing is off everywhere by default.
- Nothing is written into instruction files.
- Withheld counts are reported.
- Areas stay inside `context` until a monorepo shows a need.
