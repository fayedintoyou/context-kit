# Design

## Context

The `specs` addon reads canonical OpenSpec specs through `lib/specs/openspec.mjs`,
an adapter over the pinned OpenSpec CLI. Its `read(id)` already returns each
requirement's text and scenarios (`name`, `rawText`). `lib/operations.mjs`'s
`specSource` applies the store rule (a store must be declared by a hub or
referenced by the repository). `lib/specs/links.mjs` parses `// spec:
<capability> / <scenario>` test links, and `slices.yaml` names requirements as
`<capability> / <requirement>`. Hubs are OKF bundles; `lib/workspace.mjs` and
`lib/okf.mjs` read concepts with trust, status and freshness, and freshness is
judged against the current time. Only `.md` files in a hub are OKF documents.
`yaml` and `zod` are already dependencies.

The owner's framing (see proposal.md, Why): the model interprets, deterministic
code validates and renders, and Context Kit owns portable context and methods,
not execution. Maps sit between specs and people: they are drafted by a model
or a person, and everything mechanical about them is the kit's.

## Goals / Non-Goals

**Goals:**
- One map format for product behavior (from specs) and for working states (from
  hubs).
- Every mechanical property of a map is checked by code, with the same result
  over CLI and MCP, so an agent can iterate against `maps check` like a test.
- Status is honest. "Works", "issue" and "fixed" are only ever declared, with
  evidence; the kit derives only "has linked tests" and "no tests yet", and
  every status says whether it was declared or derived.
- The first slice is a usable journey on its own: OpenSpec specs → a drafted map →
  check → Mermaid, with the skill and help.
- The source boundary is proven by more than one source (`openspec` and `hub`,
  then `lid`).

**Non-Goals:**
- Executable statecharts: no guards, actions, history, parallel regions or
  SCXML. A map is a picture with citations, not a model to run.
- Promoting status from test results (JUnit or otherwise). A results file can't
  be matched to a linked test unambiguously or bound to the revision that was
  tested without more machinery than this change should carry; see Open
  Questions.
- A built-in knowledge-health view of a hub (counts of concepts per trust or
  freshness state). Working-state maps are authored like any other map.
- Mounted hubs (`hub-federation`, #48). Maps and the `hub` source read only the
  workspace's own hub directories (decision 14).
- Layout control. Mermaid lays the diagram out; maps stay small instead.
- Sources supplied by a workspace or hub. Workspace addons stay skill-only.

## Decisions

1. **A behavior source is a kit module behind one interface.**

   ```js
   // lib/behavior/sources.mjs
   source = { name, list({ at }): Behavior[], links?(behavior): Link[] }
   Behavior = { id, kind, title, text, file, fingerprint, parent?, marker?, okf?, freshness? }
   ```

   `kind` is `requirement` or `scenario` (OpenSpec), `entry` (LID) or `concept`
   (hub). `openSource(selection, { kind, store, hub })` picks from a fixed table;
   anything else is `INVALID_INPUT`. The `openspec` source wraps the existing
   adapter and `specSource`, so stores follow exactly the rules `list_specs` does,
   and `canonical-spec-audit / Spec source boundary` keeps owning root checks.
   It does not duplicate spec parsing: it maps `read(id)` results to behaviors.
   A new source is mostly a new module with fixtures; it may also need its own
   ID grammar, scope rule and help text. Alternative: extend the OpenSpec
   adapter with LID and hub reads. Rejected: that adapter is about OpenSpec's
   CLI and roots; behaviors are a layer above it.

2. **IDs reuse the conventions authors already write.** OpenSpec requirements
   are `<capability> / <requirement>` (as in `slices.yaml`), scenarios
   `<capability> / <scenario>` (as in test links), so a citation can be pasted
   from either. Any ID that names more than one behavior is ambiguous and
   rejected when cited: a requirement and a scenario with one name, or two
   scenarios of different requirements with one name, in one capability. LID IDs
   are LID's own (`AUTH-UI-001`, path-concatenated `PEVAL-RUN-014`). Hub concepts
   are `<hub-id>:/<concept-id>`, the qualified form #48 and #49 also use.
   Alternative: a `<source>:<kind>:<id>` URI for everything. Rejected as noise: a
   map has one source, declared once.

3. **Fingerprints.** SHA-256 over the normalized text (NFKC, `\r\n` → `\n`,
   trailing whitespace trimmed per line, trailing blank lines dropped), first 12
   hex characters. A requirement's text is its statement followed by its
   scenarios' raw text, so editing a scenario makes a cited requirement stale.
   A LID entry's text excludes its marker: implementing an entry doesn't change
   its intent. A concept's text is its whole file. Maps are never behaviors, so
   pinning or rewriting a map never changes a fingerprint anything cites, and
   map-to-map citation cycles cannot exist.

4. **LID parsing follows upstream's files, not only its reference.** Files:
   `docs/intent/**/*-specs.md` (current layout) and `docs/specs/*.md` (the
   `examples/urlshort` layout). An entry is a list item whose content is an
   optional marker, then `**<ID>**:`, then text running to the next list item,
   heading or blank line. The marker is `[x]`, `[ ]` or `[D]`, either plain (as
   in `references/ears-syntax.md`) or in backticks (as in every spec file in
   `jszmajda/lid`, for example ``- `[x]` **LID-CORE-001**: …``); without one it
   is `none` (the reference's pattern examples). `<ID>` is upper-case letters and
   digits in `-`-joined segments ending in a number. The nearest `##` heading is
   the entry's title prefix. Other lines are ignored. Duplicate IDs fail with
   `INVALID_SOURCE` naming both files. Fixtures copy real entries from
   `jszmajda/lid` (pinned commit `9679360`) under
   `test/e2e/fixtures/maps/lid/` with its MIT `LICENSE` and a README naming the
   source files. LID's `@spec` code annotations are not read in this change.

5. **A map is a Markdown concept with one YAML block.** One file holds the
   prose, the map and its generated diagram; in a hub it is an OKF concept with
   trust and freshness for free; and GitHub renders the diagram. Fictional
   example, `maps/alerts.md` in the Pigeon chat app's repository, as it looks
   once every slice has landed (the `journey` fixture and skill example omit
   `status` and `pins`, which `evidence` and `pins` add):

   ````markdown
   ---
   type: BehaviorMap
   title: When a teammate posts
   description: What a Pigeon user notices after a teammate posts, by where they are.
   ---

   # When a teammate posts

   ```yaml map
   version: 1
   source: { kind: openspec }
   scope: [alerts]
   vocabulary: [DM, "@mention"]
   nodes:
     - { id: posted, kind: start, label: A teammate posts }
     - { id: what-kind, kind: choice, label: What kind of post is it? }
     - id: dot
       label: A quiet dot appears next to the room
       cites: [alerts / Room post without a mention]
     - id: badge
       label: The room shows a number badge
       cites: [alerts / Mention badge]
     - { id: where, kind: choice, label: Where are you? }
     - id: two-popups
       label: A pop-up appears on every device at once
       cites: [alerts / Desktop pop-up]
       status:
         state: issue
         found_by: model-checker
         finder: TLA+
         note: Laptop and tablet both alert when both apps are open
         evidence: [models/Alerts.tla, "#212"]
         fixed_by: one-popup
     - id: one-popup
       label: One pop-up appears, on the device you used last
       cites: [alerts / Single pop-up]
       status: { state: fixed, evidence: ["#231"] }
     - id: watch
       label: Your watch taps your wrist
       cites: [alerts / Away from your desk]
     - { id: seen, kind: end, label: You've seen it }
   transitions:
     - { from: posted, to: what-kind }
     - { from: what-kind, to: dot, when: A post in a room, no @mention }
     - { from: what-kind, to: badge, when: A DM or an @mention }
     - { from: badge, to: where }
     - { from: where, to: two-popups, when: At your desk }
     - { from: where, to: watch, when: Away from your desk }
     - { from: one-popup, to: seen }
     - { from: watch, to: seen }
     - { from: dot, to: seen }
   pins:
     alerts / Mention badge: 3f2a9c1d07be
   ```

   <!-- context-kit:diagram:start (generated by `context-kit maps render --write`; do not edit) -->
   ```mermaid
   ...
   ```
   <!-- context-kit:diagram:end -->
   ````

   The schema is closed (zod `.strict()` at every level). IDs are kebab-case.
   `kind` defaults to `state` (`dot`, `badge` and the others above). Every
   `state` must cite; start, choice and end nodes frame the journey and may not.
   `scope` lists capabilities or `<capability> / <requirement>` (OpenSpec), ID
   prefixes (`lid`) or concept directories, `""` for a whole hub (`hub`).
   `cites` is a list of source IDs; `pins` maps a citation to its fingerprint
   and is written by `maps pin`. `status` is optional per node. Transitions may
   cite too but carry no status. A fix target reached only through `fixed_by`
   counts as reachable. Alternative: separate `*.map.yaml` plus a generated
   `.md`. Rejected: two files drift, and a YAML file in a hub isn't an OKF
   concept.

6. **Where maps live.** A repository's maps are `maps/*.md` at the workspace
   root (not recursive), named by file stem. A hub's maps are concepts with
   `type: BehaviorMap` in the workspace's own hubs, named
   `<hub-id>:/<concept-id>`, found with the existing concept scan; `validate`
   needs no change, since they are ordinary concepts. `maps list` returns both.
   Inbox notes are never maps.

7. **Working-state maps are ordinary maps.** "Explore context state" means a
   persona's or a team's working states and decisions, so there is no special
   view: a hub map uses `source: { kind: hub, hub: <id> }` and cites the concepts
   that define each state. The fixture and the skill's second worked example is a
   fictional support team (Brightdesk): *A request comes in* → *Is it urgent?* →
   *Triage within the hour* / *Next working day* → *Waiting on the customer* →
   *Escalated to engineering* → *Solved*, citing the team's triage-policy,
   escalation and service-hours concepts. `context_stale` warns when a cited
   concept is due for a check, out of date or retired, so the map shows when the
   knowledge behind a working state has aged.

8. **Evaluation instant.** Freshness depends on the clock, so every listing or
   check that reads it takes `--at <ISO 8601 with offset>` (MCP `at`), defaults
   to now, and reports `at` in its result. `lib/okf.mjs`'s `summarize` and
   `freshness` already take a `now` argument; the hub source passes the instant
   through the concept reads that call them. Tests always pass `--at`.

9. **Check report.** `maps check [<map>]` checks one map or all. Per map:
   `{ map, valid, at?, errors: [{ code, element, message }], warnings: [...],
   statuses: { <node>: { declared?, derived } } }`. Error codes: `schema`,
   `structure`, `uncited_state`, `unknown_citation`, `ambiguous_citation`,
   `label`, `evidence_missing`, `fix_target`. Warning codes: `uncovered`,
   `unpinned`, `stale`, `diagram_outdated`, `context_stale`. The CLI exits 1 on
   any error, or on any warning with `--strict`, after printing the report, like
   `specs archive --rehearse`. Repositories that want maps gated add
   `context-kit maps check --strict` to CI; the kit does not add it to the
   reusable workflow.

10. **Label lint is mechanical and small.** Node labels ≤ 70 characters and
    `when` ≤ 50 (the owner's example labels run 30 to 45). A token is flagged when
    it contains a backtick, `_`, an inner capital (`unreadCount`, also `GitHub`
    and `iPhone`), `/` together with `.` or a leading `/`, `::`, `()`, `=>` or
    `==`, matches `[A-Z]+(-[A-Z0-9]+)*-\d+`, or is SHALL, MUST, WHEN or THEN.
    Tokens are split on whitespace and on `,.;:!?()"`, so `@mention` stays whole.
    Tokens in `vocabulary` match exactly and are exempt. Whether a label is in the
    user's words is judgment, left to the skill and to review.

11. **Status: declared or derived, never promoted.** Each node has
    `derived` (always) and `declared` (when written):

    | Origin | Values | From |
    |---|---|---|
    | declared | `works`, `issue`, `fixed` | the map, each with at least one evidence item |
    | derived | `tested` | every cited scenario (or each scenario of a cited requirement) has a `// spec:` link |
    | derived | `untested` | some cited scenario has none |
    | derived | `unknown` | no citations, a `lid` or `hub` source, or a store source (its tests live in its parties) |

    Evidence is a repository path (must exist, confined to the root), `#<n>` for a
    pull request or an `https://` URL; nothing is fetched. Links come from
    `testLinks()` in `lib/specs/links.mjs`, so maps and `npm test` agree on what a
    link is. A declared `works` beside a derived `untested` is shown, not
    reconciled: the reader sees both.

12. **Mermaid output.** `flowchart TD`. Node IDs are `n_` plus the map ID with
    `-` → `_` (injective, and avoids Mermaid's `end` keyword). Shapes: start
    `(("…"))`, state `("…")`, choice `{"…"}`, end `(["…"])`. Labels are quoted
    with `"` → `#quot;`. Transitions `-->|"when"|`, fix edges
    `-. "with the fix" .->`. A node's class is its declared status when it has
    one, else its derived one: `works` fill `#e5e7eb` stroke `#6b7280`, `issue`
    `#fee2e2`/`#dc2626`, `fixed` `#dcfce7`/`#16a34a`, `tested` white with a solid
    grey stroke, `untested` white with a dashed stroke, `unknown` unstyled. A
    `Key` subgraph lists each class present, in table order: "Works", "Problem
    TLA+ found" (from `finder`, else "Problem a model checker found", "Problem a
    test found", "Problem found in review", "Problem a user reported"), "Fixed",
    "Has linked tests (derived)", "No tests yet (derived)". Lines appear in file
    order, then fix edges, then classes, then the key; output ends with one
    newline. Golden files in `test/e2e/fixtures/maps/` pin it, and
    `test/manual-checks.md` records viewing a written map on GitHub. Alternative:
    `stateDiagram-v2`. Rejected: choice nodes can't carry a label there, and edge
    styling is weaker.

13. **JSON output** is the map's resolved model: `{ map, title, source, scope,
    nodes: [{ id, kind, label, cites: [{ id, kind, title, fingerprint, pin }],
    status: { declared?, derived } }], transitions, fixes }`. Slices add to it:
    `journey` ships structure and citations; `pins` adds `pin`
    (`current|stale|unpinned`); `evidence` adds `status` and `fixes`. It carries
    no warnings that depend on the clock (`context_stale` stays in `maps check`,
    which takes `--at`), so rendering needs no evaluation instant and is
    reproducible. It is the stable interchange for other renderers (SCXML or
    XState later, outside the kit if need be).

14. **Writes and mounts.** The generated block is the text between
    `<!-- context-kit:diagram:start` and `<!-- context-kit:diagram:end -->`.
    `--write` replaces only that span (or inserts it after the map block) and
    `maps pin` rewrites only the `pins` key in the map block through `yaml`'s
    Document API, so comments and order survive. Both are CLI-only write
    operations (`cliOnly: true, write: true`, like `archive_ready`); MCP never
    writes maps. The diagram depends only on the map and the repository (test
    links included), never on the clock: `context_stale` is a check warning, not
    a diagram style. So pin → check → render → check converges.
    Map discovery and the `hub` source use only hubs loaded from the workspace's
    own `hubs/` and `examples/`. If `hub-federation` lands first, its mounted
    hubs are filtered out here, so a mount's `BehaviorMap` is not listed and
    `maps check <mount>:/<id>` fails `UNKNOWN_MAP`; the `hub-maps` slice adds that
    test, and `pins` adds the same for `maps pin` once both have landed. If this change lands first, #48 is told (on its PR) that maps ignore
    mounts until a later change adds read-only mounted maps, where writes would
    fail `READ_ONLY_MOUNT` and unfetched mounts would degrade to warnings.

15. **Surface.**

    | CLI | MCP | Notes |
    |---|---|---|
    | `maps behaviors --source <s> [--store <id>] [--hub <id>] [--inbox] [--at <t>]` | `list_behaviors` | |
    | `maps list` | `list_maps` | |
    | `maps check [<map>] [--strict] [--at <t>]` | `check_map` | MCP has no `strict`; it returns the report |
    | `maps render <map> [--format mermaid\|json]` | `render_map` | |
    | `maps render <map> --write` | none | CLI only |
    | `maps pin <map>` | none | CLI only |

    All MCP tools are read-only and only read the workspace, so the remote HTTP
    server serves them like `list_specs`. New error codes: `UNKNOWN_MAP`,
    `INVALID_SOURCE`. They and the report codes go in the `maps` help topic, as
    `help / Complete help` requires; the topic is added to the core skill's topic
    table and to `test/e2e/help.test.mjs`'s topic list, and `maps` joins the
    two-word commands that test reads from the usage text.

16. **A `maps` addon, separate from `specs`.** Working-state maps need no
    OpenSpec, and a hub-only workspace shouldn't have to enable spec tools. The
    `openspec` source still works inside `maps` because the adapter is part of the
    kit, not of the `specs` addon. The addon's operation group is `maps`; its
    skill is `behavior-map`. Docs call maps "behavior maps", with "statecharts"
    named as the familiar term they resemble.

17. **The skill** (`skills/behavior-map/SKILL.md`) walks: choose the scope
    (a capability or requirement, an ID prefix, a hub directory); `maps
    behaviors` to see what exists; write states as what the person sees or hears,
    choices as questions they'd recognize, transitions as conditions in their
    words; cite every state; keep a map under about 25 nodes and split by journey
    otherwise; declare `issue` only from a real finding (model checker output,
    failing test, review record, user report) with its evidence and `fixed` only
    with the fixing PR, and never declare `works` without evidence; run `maps
    check` until there are no errors and decide each `uncovered` warning (add a
    state, or note in the prose why it's out of the map); then `maps render
    --write` and, after a person reviews it, `maps pin`. It ends with the
    `independent-review` hand-off for consequential maps. The skill grows with
    the slices, so it never teaches what isn't shipped: `journey` covers drafting,
    citing, checking and rendering with a status-free Pigeon example; `pins`
    adds pinning; `lid-source` the `lid` source; `hub-maps` the Brightdesk
    working-states example; `evidence` status, evidence and the Pigeon example's
    pop-up issue and its fix.

## Risks / Trade-offs

- [Mermaid layouts get unreadable past a couple dozen nodes] → the skill caps
  map size and recommends one map per journey; JSON lets another renderer take
  over.
- [Lint flags legitimate product words (`iPhone`, `GitHub`, `COVID-19`)] →
  `vocabulary` per map; the rules are small, documented and fixed so results
  don't shift.
- [A declared `works` goes stale as code changes] → the derived status sits
  beside it in JSON and the check report, the skill asks for evidence that can
  be re-checked (a test, a PR), and pins flag the cited text changing.
- [Pins churn on cosmetic spec edits] → normalization ignores line endings and
  trailing whitespace; re-pinning is one command and a reviewable diff.
- [LID's format evolves] → the adapter reads the entry shapes upstream uses
  today, pinned by copied fixtures; anything else is ignored, and a format change
  is one module and its fixtures.
- [Hand-edited generated block] → it's overwritten on `--write` and flagged by
  `diagram_outdated`; the marker comment says so.

## Migration Plan

Additive. New workspaces get the `maps` addon only when they enable it;
`context-kit.json` files that list addons are unchanged. Workspaces without
`context-kit.json` enable every addon, so they gain the map tools after
upgrading and `agents install`. Rollback is removing the addon from the list.

## Open Questions

- Test results as evidence: a later change could let a results file mark a
  state works or broken, once a result can be bound to the tested commit and
  matched to exactly one linked test (with "any failure wins"). Deferrable: the
  status model already separates declared from derived, so it adds a derived
  value without changing these fields.
- Should the key's wording be configurable per map (for non-English maps)?
  Deferrable: a `key` block can be added without changing other fields.
