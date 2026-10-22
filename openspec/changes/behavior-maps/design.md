# Design

## Context

The `specs` addon reads canonical OpenSpec specs through `lib/specs/openspec.mjs`,
an adapter over the pinned OpenSpec CLI. Its `read(id)` already returns each
requirement's text and scenarios (`name`, `rawText`). `lib/operations.mjs`'s
`specSource` applies the store rule (a store must be declared by a hub or
referenced by the repository). `lib/specs/links.mjs` parses `// spec:
<capability> / <scenario>` test links, and `slices.yaml` names requirements as
`<capability> / <requirement>`. Hubs are OKF bundles; `lib/workspace.mjs` and
`lib/okf.mjs` read concepts with trust, status and freshness. Only `.md` files
in a hub are OKF documents. `yaml` and `zod` are already dependencies.

The owner's framing (see proposal.md, Why): the model interprets, deterministic
code validates and renders, and Context Kit owns portable context and methods,
not execution. Maps sit between specs and people: they are drafted by a model
or a person, and everything mechanical about them is the kit's.

## Goals / Non-Goals

**Goals:**
- One map format for product behavior (from specs) and for context (from hubs).
- Every mechanical property of a map is checked by code, with the same result
  over CLI and MCP, so an agent can iterate against `maps check` like a test.
- Status is honest: the kit never upgrades "has a test" to "works" without a
  results file, and never invents an issue.
- Adding a source later (another spec method) touches one module.

**Non-Goals:**
- Executable statecharts: no guards, actions, history, parallel regions or
  SCXML. A map is a picture with citations, not a model to run.
- Layout control. Mermaid lays the diagram out; maps stay small instead.
- Sources supplied by a workspace or hub. Workspace addons stay skill-only.

## Decisions

1. **A behavior source is a kit module behind one interface.**

   ```js
   // lib/behavior/sources.mjs
   source = { name, list(): Behavior[], tests?(behavior): Link[] }
   Behavior = { id, kind, title, text, file, fingerprint, parent?, marker?, okf?, freshness? }
   ```

   `kind` is `requirement` or `scenario` (OpenSpec), `entry` (LID) or `concept`
   (hub). `openSource(selection, { kind, store, hub })` picks from a fixed table;
   anything else is `INVALID_INPUT`. The `openspec` source wraps the existing
   adapter and `specSource`, so stores follow exactly the rules `list_specs` does,
   and `canonical-spec-audit / Spec source boundary` keeps owning root checks.
   It does not duplicate spec parsing: it maps `read(id)` results to behaviors.
   Alternative: extend the OpenSpec adapter itself with LID and hub reads.
   Rejected: that adapter is about OpenSpec's CLI and roots; behaviors are a
   layer above it.

2. **IDs reuse the conventions authors already write.** OpenSpec requirements
   are `<capability> / <requirement>` (as in `slices.yaml`), scenarios
   `<capability> / <scenario>` (as in test links), so a citation can be pasted
   from either. A name that is both within one capability is reported ambiguous
   rather than guessed. LID IDs are LID's own (`TIP-001`, path-concatenated ones
   such as `TIP-ALERTS-004` too). Hub concepts are `<hub-id>:/<concept-id>`, the
   qualified form `hub-federation` (#48) and `repo-context` (#49) introduce;
   mounted hubs therefore work once federation lands. Alternative: a
   `<source>:<kind>:<id>` URI for everything. Rejected as noise: a map has one
   source, declared once.

3. **Fingerprints.** SHA-256 over the normalized text (NFKC, `\r\n` → `\n`,
   trailing whitespace trimmed per line, trailing blank lines dropped), first 12
   hex characters. A requirement's text is its statement followed by its
   scenarios' raw text, so editing a scenario makes a cited requirement stale.
   A LID entry's text excludes its `[x]`/`[ ]`/`[D]` marker: implementing an entry
   doesn't change its intent. A concept's text is its whole file.

4. **LID parsing is the documented format, nothing more.** Files:
   `docs/intent/**/*-specs.md` and `docs/specs/*.md`. An entry is a list item
   `- [`[x]` | `[ ]` | `[D]`] **<ID>**: <text>`, with text running until the next
   list item, heading or blank line. `<ID>` is upper-case segments joined by `-`
   ending in digits. The nearest `##` heading becomes the entry's title prefix.
   Other lines are ignored. Duplicate IDs fail with `INVALID_SOURCE` naming both
   files. LID's `@spec` code annotations are not read (no test evidence for `lid`
   in this change).

5. **A map is a Markdown concept with one YAML block.** One file holds the
   prose, the map and its generated diagram, it is an OKF concept in a hub with
   trust and freshness for free, and GitHub renders the diagram. Fictional
   example, `maps/alerts.md` in the Pigeon chat app's repository:

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
   `type: BehaviorMap`, named `<hub-id>:/<concept-id>`, found with the existing
   concept scan; `validate` needs no change, since they are ordinary concepts.
   `maps list` returns both. Inbox notes are never maps.

7. **Check report.** `maps check [<map>]` checks one map or all. Per map:
   `{ map, valid, errors: [{ code, element, message }], warnings: [...],
   statuses: { <node>: { state, reason, evidence } } }`. Error codes:
   `schema`, `structure`, `unknown_citation`, `ambiguous_citation`, `label`,
   `evidence_missing`, `fix_target`, `status_conflict`. Warning codes:
   `uncovered`, `unpinned`, `stale`, `diagram_outdated`, `context_stale`. The CLI
   exits 1 on any error, or on any warning with `--strict`, after printing the
   report, like `specs archive --rehearse`. Repositories that want maps gated add
   `context-kit maps check --strict` to CI; the kit does not add it to the
   reusable workflow.

8. **Label lint is mechanical and small.** Node labels ≤ 70 characters and
   `when` ≤ 50 (the owner's example labels run 30 to 45). A token is flagged when
   it contains a backtick, `_`, an inner capital (`unreadCount`), `/` together
   with `.` or a leading `/`, `::`, `()`, `=>` or `==`, matches `[A-Z]+(-[A-Z0-9]+)*-\d+`,
   or is SHALL, MUST, WHEN or THEN. Tokens in `vocabulary` match exactly and are
   exempt. Whether a label is in the user's words is judgment, left to the skill
   and to review.

9. **Status, in order of precedence.**

   | Status | From |
   |---|---|
   | `issue` / `fixed` | declared, with evidence |
   | `issue` (found by `test`) | `--results`: a linked test of a citation failed |
   | `works` | `--results`: every linked test passed; or declared, with evidence |
   | `tested` | every cited scenario (or each scenario of a cited requirement) has a `// spec:` link; with `--results`, also when a linked test was skipped or not found |
   | `untested` | some cited scenario has none |
   | `unknown` | no citations, a `lid` or `hub` source, or a store source (its tests live in its parties) |

   Declared `works` or `fixed` plus a failed linked test is `status_conflict`. Evidence is a
   repository path (must exist, confined to the root), `#<n>` for a pull request
   or an `https://` URL; nothing is fetched. Every declared status needs at least
   one evidence item. Links come from `testLinks()` in `lib/specs/links.mjs`, so
   maps and `npm test` agree on what a link is.

10. **JUnit results.** `--results <file>` (MCP `results`) names a file inside the
    workspace, at most 16 MiB. A small strict XML reader (elements, attributes,
    entities, comments, CDATA; `<!DOCTYPE` rejected, so no entity expansion)
    reads `<testcase name file?>` with `<failure>`, `<error>` or `<skipped>`
    children or a `failure` attribute. A linked test is the `test(` call under
    its link; its name is that call's first string literal. A testcase matches
    when names are equal and, if it has `file`, the file resolves to the test
    file. Node's `--test-reporter=junit` emits both. A link whose test name can't
    be read, or that no testcase matches, stays `tested` with that reason. An
    unreadable or malformed file is `RESULTS_FORMAT`. Alternative: Node's TAP or
    a custom JSON. Rejected: JUnit is what pytest, Jest, Vitest, Go and Node all
    emit.

11. **Mermaid output.** `flowchart TD`. Node IDs are `n_` plus the map ID with
    `-` → `_` (injective, and avoids Mermaid's `end` keyword). Shapes: start
    `(("…"))`, state `("…")`, choice `{"…"}`, end `(["…"])`. Labels are quoted
    with `"` → `#quot;`. Transitions `-->|"when"|`, fix edges
    `-. "with the fix" .->`. Classes: `works` fill `#e5e7eb` stroke `#6b7280`,
    `issue` `#fee2e2`/`#dc2626`, `fixed` `#dcfce7`/`#16a34a`, `tested` white
    with grey stroke, `untested` white with dashed stroke, `unknown` unstyled.
    A `Key` subgraph lists each status present, in table order, with plain
    text: "Works", "Problem TLA+ found" (from `finder`, else "Problem a model
    checker found", "Problem a test found", "Problem found in review", "Problem
    a user reported"), "Fixed", "Has linked tests", "No tests yet". Lines appear
    in file order, then fix edges, then classes, then the key; output ends with
    one newline. Golden files in `test/e2e/fixtures/maps/` pin it.
    Alternative: `stateDiagram-v2`. Rejected: choice nodes can't carry a
    label there, and edge styling is weaker.

12. **JSON output** is the check's resolved model: `{ map, title, source, scope,
    nodes: [{ id, kind, label, cites: [{ id, kind, title, fingerprint, pin:
    current|stale|unpinned }], status }], transitions, fixes, warnings }`. It is
    the stable interchange for other renderers (SCXML or XState later, outside
    the kit if need be).

13. **The generated block** is the text between
    `<!-- context-kit:diagram:start` and `<!-- context-kit:diagram:end -->`.
    `--write` replaces only that span (or inserts it after the map block) and
    `maps pin` rewrites only the `pins` key in the map block through `yaml`'s
    Document API, so comments and order survive. Both are CLI-only write
    operations (`cliOnly: true, write: true`, like `archive_ready`); MCP never
    writes maps. The written diagram is always rendered without results, so the
    file depends only on the repository's contents and `diagram_outdated`
    doesn't flap between CI runs; a results-aware diagram is `maps render
    --results` output, for a CI artifact or a PR comment.

14. **Context states.** `maps context <hub-id>` uses `maps/context-states.md`
    from the kit root, a map with `source: { kind: openspec }` scoped to the kit's
    own `knowledge-format / OKF trust summaries`, `knowledge-format / OKF
    staleness`, `freshness-policy / Freshness decision` and `context-workspaces /
    Append-only capture` requirements, so the kit's own `maps check --strict`
    keeps it honest. Its states have
    fixed IDs, and each concept falls into the first that matches:

    | State | Label | Rule |
    |---|---|---|
    | `inbox` | Captured, not yet reviewed | under `inbox/` (only with `--inbox`) |
    | `retired` | Retired | `status: deprecated` |
    | `rewrite` | Out of date, needs rewriting | freshness `refresh` |
    | `verify` | Due for a check | freshness `verify` |
    | `draft` | Draft, written by an agent | `status: draft` |
    | `unchecked` | Nobody has checked it | trust `unverified` |
    | `tool-checked` | Checked by a tool | trust `machine-confirmed` |
    | `person-checked` | Checked by a person | trust `human-reviewed` |

    Rendering appends ` · <count>` to each state's label and dims states with no
    concepts; JSON lists each state's concept IDs, at most 200 per state with a
    `truncated` count. It reads only through the hub source, so it works on any
    hub the workspace can read, mounts included once #48 lands.

15. **Surface.**

    | CLI | MCP | Notes |
    |---|---|---|
    | `maps behaviors --source <s> [--store <id>] [--hub <id>] [--inbox]` | `list_behaviors` | |
    | `maps list` | `list_maps` | |
    | `maps check [<map>] [--results <f>] [--strict]` | `check_map` | MCP has no `strict`; it returns the report |
    | `maps render <map> [--format mermaid\|json] [--results <f>]` | `render_map` | |
    | `maps render <map> --write` | none | CLI only |
    | `maps pin <map>` | none | CLI only |
    | `maps context <hub-id> [--format mermaid\|json] [--inbox]` | `context_states` | |

    All MCP tools are read-only and only read the workspace, so the remote HTTP
    server serves them like `list_specs`. New error codes: `UNKNOWN_MAP`,
    `INVALID_SOURCE`, `RESULTS_FORMAT`. They and the report codes go in the `maps`
    help topic, as `help / Complete help` requires.

16. **A `maps` addon, separate from `specs`.** Context maps need no OpenSpec, and
    a hub-only workspace shouldn't have to enable spec tools. The `openspec` source
    still works inside `maps` because the adapter is part of the kit, not of the
    `specs` addon. The addon's operation group is `maps`; its skill is
    `behavior-map`. Alternative: fold maps into `specs`. Rejected for the
    context-map case; reconsider if the owner prefers fewer addons.

17. **The skill** (`skills/behavior-map/SKILL.md`) walks: choose the scope
    (a capability, an ID prefix, a hub directory); `maps behaviors` to see what
    exists; write states as what the person sees or hears, choices as questions
    they'd recognize, transitions as conditions in their words; cite every state;
    keep a map under about 25 nodes and split by journey otherwise; declare
    `issue` only from a real finding (model checker output, failing test, review
    record, user report) with its evidence and `fixed` only with the fixing PR;
    run `maps check` until there are no errors and decide each `uncovered`
    warning (add a state, or note in the prose why it's out of the map); then
    `maps render --write` and, after a person reviews it, `maps pin`. For context
    maps, cite the concepts that define each working state. It ends with the
    `independent-review` hand-off for maps that are consequential.

## Risks / Trade-offs

- [Mermaid layouts get unreadable past a couple dozen nodes] → the skill caps
  map size and recommends one map per journey; JSON lets another renderer take
  over.
- [Lint flags legitimate product words (`iPhone`, `GitHub`, `COVID-19`)] → `vocabulary` per map; the lint is
  small and documented, and its rules are fixed so results don't shift.
- [`tested` read as "works"] → distinct name, colour and key text; only a results
  file produces `works` from tests.
- [Pins churn on cosmetic spec edits] → normalization ignores line endings and
  trailing whitespace; re-pinning is one command and a reviewable diff.
- [LID's format evolves] → the adapter reads only the documented entry shape and
  ignores everything else; a format change is one module and its fixtures.
- [A results file from another commit] → the kit can't tell; the report names
  the file and docs say to render from the same CI run that produced it.
- [Hand-edited generated block] → it's overwritten on `--write` and flagged by
  `diagram_outdated`; the marker comment says so.

## Migration Plan

Additive. New workspaces get the `maps` addon only when they enable it;
`context-kit.json` files that list addons are unchanged. Workspaces without
`context-kit.json` enable every addon, so they gain the map tools after
upgrading and `agents install`. Rollback is removing the addon from the list.

## Open Questions

- Should `maps check` accept a directory of results files (one per test job)?
  Deferrable: a single file covers this repository's CI; merging is additive.
- Should the key's wording be configurable per map (for non-English maps)?
  Deferrable: English labels are fixed now, and a `key` block can be added
  without changing other fields.
