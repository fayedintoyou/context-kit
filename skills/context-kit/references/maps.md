# Behavior maps (maps addon)

A behavior map draws what a person experiences as a journey: the states they see
and the moves between them, each state citing the specs behind it. They resemble
statecharts, but a map is a picture with citations, not a model to run. A model
or a person drafts a map (the `behavior-map` skill says how); Context Kit checks
and renders it deterministically, and never runs tests, checkers or models.

Maps are read from the selected root (`--root <repository>`, as for `specs`).

| Task | CLI | MCP tool |
|---|---|---|
| What a map can cite | `maps behaviors --source openspec/lid [--store <id>]` | `list_behaviors` |
| The repository's maps | `maps list` | `list_maps` |
| Check one map, or all | `maps check [<map>] [--strict]` | `check_map` |
| Draw a map | `maps render <map> [--format mermaid/json]` | `render_map` |
| Write the diagram into the map file | `maps render <map> --write` | CLI only (`write_map_diagram`) |

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

Any other source name fails with `INVALID_INPUT` naming the supported sources.

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
```
````

- `source`: `{ kind: openspec }`, optionally with `store: <id>`, or
  `{ kind: lid }`.
- `scope`: the behaviors the map should cover. For `openspec`, capabilities or
  `<capability> / <requirement>`; for `lid`, IDs or ID prefixes of whole segments
  (`AUTH` or `AUTH-UI` covers `AUTH-UI-001`; `AUTH-U` covers nothing).
- `cites`: for `lid`, entry IDs such as `AUTH-UI-001`.
- `nodes`: `id` (kebab-case), `label`, `kind` (`start`, `state`, `choice`, `end`;
  `state` when omitted) and `cites`, a list of behavior IDs.
- `transitions`: `from`, `to`, `when` (needed when leaving a choice) and `cites`.
- `vocabulary`: product words the label lint should accept as written.

Every key is checked; an unknown one is an error. In YAML flow style (`{ ... }`),
quote a label that contains a comma or starts with `@`.

## Check report

`maps check` returns `{ root, valid, maps: [{ map, valid, errors, warnings }] }`,
each entry `{ code, element, message }`, where the element is a node ID, a
transition as `from -> to`, `scope`, `diagram` or a behavior ID.

| Code | Kind | Means |
|---|---|---|
| `schema` | error | Frontmatter, block or key problem (including a symlinked map file, which is never read) |
| `structure` | error | Duplicate node IDs, a transition naming an unknown node, not exactly one start, a node unreachable from the start, a choice with fewer than two exits or an exit without `when`, an end with exits |
| `uncited_state` | error | A `state` cites nothing (start, choice and end nodes may) |
| `unknown_citation` | error | A citation, or a scope entry, names no behavior |
| `ambiguous_citation` | error | A citation names more than one behavior (a requirement and a scenario, or two scenarios, sharing a name), listing them |
| `label` | error | A node label over 70 characters or a `when` over 50, or a token that reads as code or spec language: a backtick, an underscore, an inner capital (`unreadCount`, also `GitHub` unless in `vocabulary`), a file path, `::`, `()`, `=>`, `==`, diagram or web markup (`<`, `>`, `{`, `}`, `%%`, `:::`, `->`, `[[`, `]]`), a spec ID such as `AUTH-UI-001`, or SHALL, MUST, WHEN, THEN |
| `uncovered` | warning | A scenario in scope that no element cites, directly or through its requirement, or a `lid` entry in scope that no element cites |
| `diagram_outdated` | warning | The generated diagram differs from a fresh rendering |

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
`--format json` returns the map's model: `map`, `title`, `source`, `scope`, `nodes`
and `transitions` in file order with their kinds and labels, and each element's
`cites` resolved to `id`, `kind`, `title` and `fingerprint`. The same map and specs
give byte-identical output; nothing depends on the clock.

`maps render <map> --write` (CLI only, never over MCP) puts the diagram in the map
file between `<!-- context-kit:diagram:start ... -->` and
`<!-- context-kit:diagram:end -->`, replacing only that block or adding it after the
map block, so GitHub shows the diagram. It needs an explicit root (`--root` or
`CONTEXT_KIT_ROOT`; otherwise `WRITE_DISABLED`), refuses a map with errors before
writing, replaces the file atomically, never follows a symlink, and reports
`SNAPSHOT_CHANGED` without writing if the file changed while it rendered. Don't
edit the block by hand: `--write` overwrites it and the check flags it.
