# Behavior maps (maps addon)

A behavior map draws what a person experiences as a journey: the states they see
and the moves between them, each state citing the specs behind it. A map over a
hub draws a team's or a persona's working states and decisions, each citing the
hub concepts behind it. They resemble
statecharts, but a map is a picture with citations, not a model to run. A model
or a person drafts a map (the `behavior-map` skill says how); Context Kit checks
and renders it deterministically, and never runs tests, checkers or models.

Maps are read from the selected root (`--root <repository>`, as for `specs`): its
`maps/` and the workspace's own hubs (`hubs/` and `examples/`). Mounted hubs are
not read: their maps aren't listed, `maps check`, `render` or `pin` of
`<mount>:/<id>` fails with `UNKNOWN_MAP`, and `--source hub --hub <mount>` with
`UNKNOWN_HUB`.

| Task | CLI | MCP tool |
|---|---|---|
| What a map can cite | `maps behaviors --source openspec/lid/hub [--store <id>] [--hub <id>] [--inbox] [--at <time>]` | `list_behaviors` |
| The repository's and its hubs' maps | `maps list` | `list_maps` |
| Check one map, or all, with each node's statuses | `maps check [<map>] [--strict] [--at <time>]` | `check_map` |
| Draw a map | `maps render <map> [--format mermaid/json]` | `render_map` |
| Write the diagram into the map file | `maps render <map> --write` | CLI only (`write_map_diagram`) |
| Pin each citation's fingerprint | `maps pin <map>` | CLI only (`pin_map`) |

## Behavior sources

`--source openspec` reads the canonical specs of the workspace repository, or of a
shared store readable under the same rule as `specs list --store` (declared by a
hub or referenced by the repository; otherwise `UNKNOWN_STORE`). Requirements are
`<capability> / <requirement>`, as in `slices.yaml`; scenarios are
`<capability> / <scenario>`, as in test links, each naming its requirement as
`parent`. Pending change deltas are not listed. Each behavior has a `kind`
(`requirement` or `scenario`), `title`, `text`, `file` and `fingerprint`: the first
12 hex characters of the SHA-256 of its normalized text (Unicode NFKC, line endings
and trailing whitespace normalized). A requirement's text includes its scenarios.

`--source lid` reads [linked-intent development](https://github.com/jszmajda/lid)
spec files in the workspace repository: `docs/intent/**/*-specs.md` (the current
layout) and `docs/specs/*.md` (the older one), files in path order and entries in
file order. An entry is a list item `**<ID>**: <text>`, optionally after a status
marker `[x]`, `[ ]` or `[D]`, plain or in backticks:

```markdown
## User Authentication

- `[x]` **AUTH-UI-001**: The system shall display a login button on the home screen.
- [ ] **AUTH-API-001**: The system shall validate JWT tokens on every authenticated API request.
- **CART-UI-001**: The system shall display the item count in the cart icon.
```

The ID is upper-case letters and digits in `-`-joined segments ending in a number
(`AUTH-UI-001`, `2FA-001`); the text runs to the next list item, heading or blank
line. Each entry has `kind`
`entry`, `title` (the nearest `##` heading, then the ID), `text`, `file`,
`fingerprint` and `marker`: `implemented`, `gap`, `deferred` or `none`. The
marker isn't part of the text, so marking an entry implemented keeps its
fingerprint. Code blocks, fenced or indented, in lists and block quotes too, are found
as CommonMark reads them and never hold entries; other lines are ignored. A
list item that looks like an entry but has no valid ID or marker (`[X]`,
`**auth-001**`, `**ＡＵＴＨ-００１**`) is not listed but reported in `skipped` with its `file`, `line`,
`id` and `reason`. An ID defined twice fails
with `INVALID_SOURCE` naming both places (`file:line`). Files are read as text,
never executed, and never through a symlink: a symlinked file or directory is
listed in `skipped` with its reason: `symlink`, `too large` (over 128 KiB) or
`not UTF-8`. `--store` applies only to `openspec`
(`INVALID_INPUT`).

`--source hub --hub <hub-id>` reads one of the workspace's own hubs (otherwise
`UNKNOWN_HUB`). Each concept, in path order, is a behavior `<hub-id>:/<concept-id>`
(as `read` takes it) of `kind` `concept`, with `title`, `text` (the whole file,
frontmatter included, which the `fingerprint` covers), `file`, `okf` (the trust
summary: `type`, `status`, `trust`, `stale`, ...) and `freshness` (`action`
`read`, `verify` or `refresh`, with its `reason` and `due`). `BehaviorMap`
concepts are never listed: maps aren't behaviors. Inbox notes are listed only
with `--inbox` (MCP `inbox: true`), marked `inbox: true`, and a map can't cite
them. `--hub` and `--inbox` apply only to `hub` (`INVALID_INPUT`), and `hub`
needs `--hub`.

Any other source name fails with `INVALID_INPUT` naming the supported sources.

## Evaluation instant

Freshness depends on the clock, so `maps behaviors` and `maps check` take
`--at <time>` (MCP `at`): an ISO 8601 timestamp with an explicit offset, such as
`2026-03-01T09:00:00Z` or `2026-03-01T10:00:00+01:00`. Without one they use the
current time. A time without an offset (`2026-03-01T09:00:00`, `2026-03-01`)
fails with `INVALID_INPUT`, since it would mean different instants on different
machines. Results that depend on it report the instant used, in UTC, as `at`: a
`hub` listing, and the check report of each map over a hub. Rendering never
depends on the clock and takes no `--at`.

## Map files

A repository's maps are `maps/<name>.md` (kebab-case names; other files there, such
as `README.md`, are ignored): an OKF concept with `type: BehaviorMap` and exactly
one fenced `yaml map` block. Prose around it is free. A fictional example:

````markdown
---
type: BehaviorMap
title: When a teammate posts
---

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
  - { id: seen, kind: end, label: You've seen it }
transitions:
  - { from: posted, to: what-kind }
  - { from: what-kind, to: dot, when: "A post in a room, no @mention" }
  - { from: what-kind, to: badge, when: A DM or an @mention }
  - { from: dot, to: seen }
  - { from: badge, to: seen }
pins:
  alerts / Room post without a mention: bd11b2c07e66
  alerts / Mention badge: 5c5fa649501a
```
````

- `source`: `{ kind: openspec }`, optionally with `store: <id>`, `{ kind: lid }`,
  or `{ kind: hub, hub: <hub-id> }`.
- `scope`: the behaviors the map should cover. For `openspec`, capabilities or
  `<capability> / <requirement>`; for `lid`, IDs or ID prefixes of whole segments
  (`AUTH` or `AUTH-UI` covers `AUTH-UI-001`; `AUTH-U` covers nothing); for `hub`,
  directories of the hub (their concepts at any depth), or `""` for the whole hub.
- `cites`: for `lid`, entry IDs such as `AUTH-UI-001`; for `hub`, concepts as
  `<hub-id>:/<concept-id>`.
- `nodes`: `id` (kebab-case), `label`, `kind` (`start`, `state`, `choice`, `end`;
  `state` when omitted), `cites`, a list of behavior IDs, and an optional
  declared `status` (see Status).
- `transitions`: `from`, `to`, `when` (needed when leaving a choice) and `cites`.
- `vocabulary`: product words the label lint should accept as written.
- `pins`: each citation's fingerprint when the map was last reviewed, written by
  `maps pin`; don't edit it by hand.

A hub's maps are its concepts with `type: BehaviorMap` (not in `inbox/`), in the
workspace's own hubs, named `<hub-id>:/<concept-id>` (such as
`brightdesk/support:/maps/working-states`). `maps list` gives the repository's
maps, then the hubs' maps; each is checked, rendered, written and pinned like a
repository map, by that name. A hub map usually draws a team's or a persona's
working states over its own hub (`source: { kind: hub, hub: <hub-id> }`), and
since maps are never behaviors, a map scoped to the whole hub never lists itself
or another map as `uncovered`, and citing one is `unknown_citation`.

Every key is checked; an unknown one is an error. In YAML flow style (`{ ... }`),
quote a label that contains a comma or starts with `@`, and an evidence item
starting with `#`.

## Status

Each node has a **derived** status, and may have a **declared** one. Context
Kit never promotes one into the other, never fetches evidence, and never runs a
test or a model: it only reads.

A declared `status` says what the map's author can show:

```yaml
  - id: two-popups
    label: A pop-up appears on every device at once
    cites: [alerts / Desktop pop-up]
    status:
      state: issue                 # works, issue or fixed
      found_by: model-checker      # issue only: model-checker, test, review, user-report or other
      finder: TLA+                 # issue only, optional: shown in the diagram's key
      note: Laptop and tablet both alert when both apps are open   # optional, one line
      evidence: [models/Alerts.tla, "#212"]
      fixed_by: one-popup          # issue only, optional: a node declared fixed
```

- `evidence` lists at least one item: a regular file committed to the
  repository, in the tree at HEAD (its path relative to the root, compared in
  Unicode NFC; not a symlink, directory or submodule, and not a name that more
  than one committed entry shares once normalized), a pull request as `#<n>`,
  or an `https://` link. Anything else is `evidence_missing`. A path that fails
  always reads "… is not a file committed to the repository (in HEAD)":
  untracked, ignored, only staged, absolute, with `.` or `..` segments, a
  repository with no commit, or no git repository at all. Paths are looked up
  only in HEAD's tree (`git ls-tree -r -z --full-tree HEAD`, with `GIT_*`
  variables, global and system config, fsmonitor, hooks and the untracked cache
  off), never in the index or on disk, so commit evidence before declaring it.
- `fixed_by` names the node that shows the fix, which must declare `fixed`
  (otherwise `fix_target`). The diagram draws a dashed "with the fix" edge
  between them, and the fix counts as reached through it.
- `finder` is drawn in the key, so it is linted like a label (up to 40 characters).

The derived status comes from the repository's test links that `npm test`'s
spec-links check accepts: a `// spec: <capability> / <scenario>` comment directly
above `test(` in `test/e2e/**/*.test.mjs`, or in `test/unit/` with a `// because:`
line, or a `- spec:` line in `test/manual-checks.md`. A link it rejects (not above
a test, in another directory, or a unit test without its reason) counts for nothing:

| Derived | When |
|---|---|
| `tested` | Every scenario the node cites, and every scenario of a requirement it cites, has a linked test |
| `untested` | Some cited scenario has none (named in `untested`), or a cited requirement has no scenarios |
| `unknown` | The node cites nothing, the source is `lid`, or the source is a store (its tests live in its parties) |

Each status is `{ state, origin, reason, evidence }`, with `origin` `declared` or
`derived`. Declared evidence items are `{ kind: path|pull_request|link, value }`;
derived ones are the links, `{ kind: test, value: <file>:<line>, scenario }`, or
`kind: manual_check` for a manual check, which counts as linked coverage as it does
for `npm test`.
A declared status also carries `found_by`, `finder`, `fixed_by` and `note` when
given. A declared `works` beside a derived `untested` is shown as both, not
reconciled. Results of test runs are not read.

## Check report

`maps check` returns `{ root, valid, maps: [{ map, valid, errors, warnings, statuses, at? }] }`,
each error or warning `{ code, element, message }`, where the element is a node ID, a
transition as `from -> to`, `scope`, `diagram` or a behavior ID. `statuses` maps
each node ID to `{ declared?, derived }` (see Status). `at` is the evaluation
instant, given for a map over a hub.

| Code | Kind | Means |
|---|---|---|
| `schema` | error | Frontmatter, block or key problem (including a symlinked map file, which is never read) |
| `structure` | error | Duplicate node IDs, a transition naming an unknown node, not exactly one start, a node unreachable from the start, a choice with fewer than two exits or an exit without `when`, an end with exits |
| `uncited_state` | error | A `state` cites nothing (start, choice and end nodes may) |
| `unknown_citation` | error | A citation, or a scope entry, names no behavior |
| `ambiguous_citation` | error | A citation names more than one behavior (a requirement and a scenario, or two scenarios, sharing a name), listing them |
| `evidence_missing` | error | A declared status's evidence item is a path that is not a regular file committed to the repository (in HEAD), or is neither `#<n>` nor an `https://` link |
| `fix_target` | error | `fixed_by` names no node of the map, or a node not declared `fixed` |
| `label` | error | A node label (or an issue's `finder`, up to 40) over 70 characters or a `when` over 50, or a token that reads as code or spec language: a backtick, an underscore, an inner capital (`unreadCount`, also `GitHub` unless in `vocabulary`), a file path, `::`, `()`, `=>`, `==`, diagram or web markup (`<`, `>`, `{`, `}`, `%%`, `:::`, `->`, `[[`, `]]`), a spec ID such as `AUTH-UI-001`, or SHALL, MUST, WHEN, THEN |
| `uncovered` | warning | A scenario in scope that no element cites, directly or through its requirement, or a `lid` entry in scope that no element cites |
| `unpinned` | warning | An element cites a behavior the map has no pin for (one warning per citing element) |
| `stale` | warning | An element cites a behavior whose fingerprint differs from its pin: its text changed since the map was pinned (one warning per citing element) |
| `diagram_outdated` | warning | The generated diagram differs from a fresh rendering |
| `context_stale` | warning | For a map over a hub: an element cites a concept that, at the evaluation instant, is due for a check (`verify`), out of date (`refresh`) or `deprecated`, with the reason (one warning per citing element). It never changes rendering |

The CLI exits 1 when any map has an error, and with `--strict` also on any
warning; the report is the same either way. MCP returns the report. A map whose
source can't be read fails the whole check with the source's code (such as
`UNKNOWN_STORE`, or `INVALID_SOURCE` for a duplicate `lid` ID). `maps check <name>` for a name with no file fails with
`UNKNOWN_MAP`. For CI, add `context-kit maps check --strict`.

## Rendering

`maps render` draws a map that has no errors (otherwise `INVALID_INPUT`: check it
first) as a Mermaid `flowchart TD`: start `(("…"))`, state `("…")`, choice
`{"…"}`, end `(["…"])`, exits labelled with their `when`. Labels are always
drawn as text, reading exactly as written: every character other than letters,
digits, spaces and `,.'!?@()/+-` becomes a Mermaid entity code (`#37;` for `%`,
`#quot;` for `"`), and words Mermaid reads as statements (`click`, `style`,
`class`, `end`, ...) never appear verbatim, so no label can become a directive,
style, link or markup.

Statuses are drawn as classes, after the lines and the dashed fix edges
(`-. "with the fix" .->`, issue to fix). A node takes its declared status's
class when it has one, else its derived one: `st_works` grey (fill `#e5e7eb`,
stroke `#6b7280`), `st_issue` red (`#fee2e2`, `#dc2626`), `st_fixed` green
(`#dcfce7`, `#16a34a`), `st_tested` white with a solid grey outline, `st_untested`
white with a dashed one; `unknown` is unstyled. A `Key` subgraph then lists only
the classes present, in that order: "Works", "Problem TLA+ found" (from `finder`,
else "Problem a model checker found", "Problem a test found", "Problem found in
review", "Problem a user reported" or "Problem found"; one entry per wording),
"Fixed", "Has linked tests (derived)" and "No tests yet (derived)". Class names
and styles are fixed text; a `finder` is escaped like a label, and notes and
evidence are never drawn.

`--format json` returns the map's model: `map`, `title`, `source`, `scope`, `nodes`
and `transitions` in file order with their kinds and labels, and each element's
`cites` resolved to `id`, `kind`, `title`, `fingerprint` and `pin`: `current`,
`stale` or `unpinned`, as the check reports it. Each node has its `status`
(`{ declared?, derived }`, as the check reports it), and `fixes` lists the fix
edges as `{ from, to }`. The same map, specs and test links give byte-identical
output; nothing depends on the clock, so a map over a hub renders the same before
and after a cited concept goes out of date, and no output carries `context_stale`. Since derived statuses follow the test
links, linking a test to a cited scenario can make a written diagram
`diagram_outdated`.

`maps render <map> --write` (CLI only, never over MCP) puts the diagram in the map
file between `<!-- context-kit:diagram:start ... -->` and
`<!-- context-kit:diagram:end -->`, replacing only that block or adding it after the
map block, so GitHub shows the diagram. It needs an explicit root (`--root` or
`CONTEXT_KIT_ROOT`; otherwise `WRITE_DISABLED`), refuses a map with errors before
writing, replaces the file atomically, never follows a symlink, and reports
`SNAPSHOT_CHANGED` without writing if the file changed while it rendered. Don't
edit the block by hand: `--write` overwrites it and the check flags it.

## Pinning

`maps pin <map>` (CLI only, never over MCP) records each citation's current
fingerprint under the map block's `pins` and changes nothing else in the file. It
edits `pins` in place: a changed pin has only its value replaced, a pin nothing
cites loses its line (and the `pins` line goes when no pins remain), and new pins
follow the last one in citation order, indented like the rest of the block. A new
`pins` key goes after the block's last key, before any `...` or trailing comments.
A `{ ... }` pins value has changed values replaced in place, and is rewritten as
one flow mapping only when pins are added or removed. The `pins` line, comments
and the other keys keep their bytes, and when every pin is already current
nothing is written (`written: false`).

Pin after a person has reviewed the map against its specs; from then on the check
warns `stale` when a cited requirement or scenario changes (editing a scenario
also changes the requirement holding it), and `unpinned` for a citation added
since. Review what changed, update the map if needed, and pin again.

Like `--write` it needs an explicit root (otherwise `WRITE_DISABLED`), refuses a
map with errors, and writes atomically. It also refuses (`INVALID_INPUT`) a block
written as one `{ ... }` mapping, which has no line of its own for `pins`: write
the block in block style, one key per line. Before writing, it reads the whole new
file back as `maps check` does and refuses with `PIN_UNSAFE`, writing nothing, if
the map would not parse, anything outside the pins would change, or the pins would
not be the current fingerprints; remove the `pins` key and pin again. Pins never
change the diagram, so pin, check, `render --write` and check converge: a second
pin and render leave the file unchanged (`written: false`).
