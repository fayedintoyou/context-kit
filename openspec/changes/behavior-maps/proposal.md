# Proposal

## Why

Specs say what a system must do one requirement at a time. Nobody experiences a
system that way. A person using a chat app experiences a path: someone posts, a
dot or a badge appears, a pop-up shows or the phone buzzes, depending on what
they are doing. A map of those user-visible states and the moves between them
shows gaps and contradictions that a list of requirements hides. With evidence
laid over it (this works, a model checker found a bug here, this is the fix), it
is also the clearest status report a person can read.

Drawing such a map is interpretation, so it is a model's or a person's job.
Keeping it honest is not: whether every state cites a real requirement, whether
a requirement changed since the map was drawn, whether a requirement no state
covers, whether a label is in plain words, and how the map is drawn. Software
can decide all of that. Context Kit already reads a repository's OpenSpec specs
and links tests to scenarios. It has no notion of a map, and its spec reading is
OpenSpec-only, while repositories also keep intent in other forms, such as
linked-intent development's EARS specs.

The same kind of map describes how people work, not only products: a persona's
or a team's working states and the decisions between them, each citing the hub
concepts that define it. Context Kit owns those concepts, so it can say when the
knowledge behind a working state has aged.

## What Changes

- **Behavior sources.** A small kit-owned adapter boundary over where a
  repository's behavioral truth lives. Each source lists behaviors with a stable
  ID, a title, the text and a fingerprint of that text. Three sources ship,
  chosen by name from a closed set; nothing in a repository or hub is executed:
  - `openspec`: canonical specs of the workspace repository or a declared or
    referenced store, through the existing pinned adapter. Requirements are cited
    as `<capability> / <requirement>` (as in `slices.yaml`) and scenarios as
    `<capability> / <scenario>` (as in test links).
  - `lid`: linked-intent development spec files (`docs/intent/**/*-specs.md`
    and `docs/specs/*.md`), whose entries are `**<ID>**:` list items with an
    `[x]`, `[ ]` or `[D]` marker, plain or in backticks as upstream writes them,
    or none.
  - `hub`: the concepts of a workspace hub, cited as `<hub-id>:/<concept-id>`,
    with their OKF trust and freshness, evaluated at an explicit `--at` instant
    when reproducibility matters.

  `maps behaviors` / `list_behaviors` lists what a source offers, so an author
  cites real IDs.
- **Behavior maps.** A map is an OKF concept (`type: BehaviorMap`), a Markdown
  file with one fenced `yaml map` block: a source and scope, nodes (`start`,
  `state`, `choice`, `end`) and transitions, each with a plain-language label.
  Every state cites the behaviors it represents. A repository keeps maps in
  `maps/<name>.md`; a hub may hold maps as concepts, such as a team's working
  states. Being Markdown, a map carries prose and its own generated Mermaid
  diagram, so GitHub shows it.
- **Deterministic checks.** `maps check` / `check_map` reports, per map:
  - errors: structural problems (one start, reachable nodes, labelled choices),
    a state with no citation, a citation that doesn't resolve or names more than
    one behavior, and labels that are too long or read as code or spec language;
  - warnings: behaviors in scope that no element covers, citations whose text
    changed since the map was pinned (`maps pin` records fingerprints), a
    generated diagram that is out of date, and cited hub concepts that are due
    for a check, out of date or retired.

  `--strict` turns warnings into failures for CI.
- **Status overlays, declared or derived.** A state may declare `works`, `issue`
  (with who found it: a model checker, test, review or user report) or `fixed`,
  each with evidence (a repository file, a pull request, an https link). An
  issue may name the state that fixes it, drawn with a "with the fix" edge. The
  kit derives only `tested` or `untested` from the cited scenarios' linked tests,
  never "works". Every status says whether it was declared or derived, in the
  report, the JSON and the diagram's key. The kit never runs tests or model
  checkers.
- **Deterministic rendering.** `maps render` / `render_map` draws a map as
  Mermaid (a flowchart with a colour key: grey works, red issue, green fixed,
  outlined for derived test status) or as normalized JSON. Output is
  byte-identical for the same inputs. `maps render --write` and `maps pin` (CLI
  only) touch only the generated diagram block and the pins.
- **A `maps` addon and a `behavior-map` skill.** The addon carries the
  operations and the skill. The skill tells an agent how to draft a map from
  specs or a hub: what the person sees, in their words, citing every state,
  declaring status only with evidence, then checking, rendering and pinning.

Non-goals: running a model checker (TLA+ and the like are external evidence
sources), running tests or reading their results, generating maps with a model
inside the CLI, a GUI or editor, SCXML or executable statecharts (no guards,
actions or parallel regions), status on transitions, maps that cite more than
one source, citing pending change deltas, a built-in per-hub count of concepts
by knowledge state, maps in mounted hubs, and test evidence for `lid` entries.

## Capabilities

### New Capabilities
- `behavior-sources`: the adapter boundary over a repository's or hub's
  behavioral truth, the `openspec`, `lid` and `hub` sources, stable IDs,
  fingerprints, the evaluation instant and listing them.
- `behavior-maps`: the map format in repositories and hubs, deterministic checks
  (structure, citations, coverage, pins, labels), declared and derived status,
  rendering, the generated diagram block, the `maps` addon and the drafting
  skill.

### Modified Capabilities
- None. The `addons` catalog requirement already covers listing a new addon,
  and `help`'s completeness requirement covers the new commands, tools and codes.

## Impact

- New `lib/behavior/`: `sources.mjs` (the boundary and the `openspec`, `lid`
  and `hub` sources, reusing `lib/specs/openspec.mjs`, `specSource`'s store rule
  and `lib/workspace.mjs` concept reads), `maps.mjs` (find, parse, check, pin),
  `status.mjs` (declared and derived status, reusing `lib/specs/links.mjs`) and
  `render.mjs` (Mermaid and JSON).
- `lib/operations.mjs`: group `maps` with `list_behaviors`, `list_maps`,
  `check_map` and `render_map` (read-only, also over HTTP), and CLI-only writes
  for the diagram block and pins. `bin/hub.mjs` gains
  `maps behaviors|list|check|render|pin`.
- New `addons/maps/addon.json`, `skills/behavior-map/`, a `maps` help topic
  (listed in the core skill and the help test), `docs/maps.md`, README,
  `docs/format.md` and `docs/next.md`. New error codes `UNKNOWN_MAP` and
  `INVALID_SOURCE`.
- Tests: new `test/e2e/maps.test.mjs` (temporary repositories with OpenSpec and
  LID specs, hubs; CLI and MCP SDK clients), with LID fixtures copied from
  `jszmajda/lid` under its MIT license; two manual checks (a map's diagram on
  GitHub, drafting from the skill).
- No new dependencies: `yaml` and `zod` are already pinned.
- Interaction with the open plans:
  - `hub-federation` (#48) adds mounted hubs to hub loading. Maps and the `hub`
    source read only the workspace's own hubs. Whichever change lands second adds
    the guard or the note (design decision 14), and mounted maps (read-only, with
    `READ_ONLY_MOUNT` on writes) are left to a later change.
  - `hub-federation` and `repo-context` (#49) introduce `<hub>:/<concept-id>`
    references, and this change uses the same form.
  - `machine-setup` (#50) and `remote-mcp-access` don't affect this change:
    every map tool is read-only and reads only the workspace, so it is served
    over HTTP like `list_specs`.
