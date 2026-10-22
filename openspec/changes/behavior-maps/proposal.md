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

The same kind of map describes context, not only products: a persona's or a
team's working states, or the state of a hub's knowledge (captured, draft,
checked by a person, due for a check, retired). Context Kit owns that knowledge,
so it can say how much of a hub sits in each state.

## What Changes

- **Behavior sources.** A small kit-owned adapter boundary over where a
  repository's behavioral truth lives. Each source lists behaviors (requirements,
  scenarios, spec entries or concepts) with a stable ID, a title, the text and a
  fingerprint of that text. Three sources ship, chosen by name from a closed
  set; nothing in a repository or hub is executed:
  - `openspec`: canonical specs of the workspace repository or a declared or
    referenced store, through the existing pinned adapter. Requirements are cited
    as `<capability> / <requirement>` (as in `slices.yaml`) and scenarios as
    `<capability> / <scenario>` (as in test links).
  - `lid`: linked-intent development spec files (`docs/intent/**/*-specs.md`,
    and `docs/specs/*.md`), whose entries are `**<ID>**:` lines with `[x]`,
    `[ ]` or `[D]` markers.
  - `hub`: a hub's concepts, cited as `<hub-id>:/<concept-id>`, with their OKF
    trust and freshness.
  `maps behaviors` / `list_behaviors` lists what a source offers, so an author
  cites real IDs.
- **Behavior maps.** A map is an OKF concept (`type: BehaviorMap`), a Markdown
  file with one fenced `yaml map` block: a source and scope, nodes (`start`,
  `state`, `choice`, `end`) and transitions, each with a plain-language label and
  the behaviors it cites. A repository keeps maps in `maps/<name>.md`; a hub may
  hold maps as concepts. Being Markdown, a map carries prose and its own
  generated Mermaid diagram, so GitHub shows it.
- **Deterministic checks.** `maps check` / `check_map` reports, per map:
  structural errors (one start, reachable nodes, labelled choices); citations
  that don't resolve or are ambiguous; behaviors in scope that no element covers;
  citations whose text changed since the map was pinned (`maps pin` records
  fingerprints); labels that are too long or read as code or spec language; and a
  generated diagram that is out of date. `--strict` turns warnings into failures
  for CI.
- **Status overlays.** An element may declare `works`, `issue` (with who found
  it: a model checker, test, review or user report) or `fixed`, with evidence (a
  repository file, a pull request, an https link). An issue may name the state
  that fixes it, drawn with a "with the fix" edge. Where nothing is declared, the
  kit derives status from the cited scenarios' linked tests (`untested`,
  `tested`), and from a JUnit results file given with `--results` (`works`, or
  `issue` found by a test). A declared `works` that a failing result contradicts
  is an error. The kit never runs tests or model checkers.
- **Deterministic rendering.** `maps render` / `render_map` draws a map as
  Mermaid (a flowchart with a colour key: grey works, red issue, green fixed) or
  as normalized JSON with resolved citations and statuses. Output is
  byte-identical for the same inputs. `maps render --write` (CLI only) refreshes
  the map file's generated diagram block and nothing else.
- **Context state.** `maps context <hub-id>` / `context_states` places every
  concept of a hub in one knowledge state (inbox note, retired, needs rewriting,
  due for a check, draft, unchecked, checked by a tool, checked by a person) by
  fixed precedence from OKF fields and the hub's freshness policy, and renders
  the kit's built-in lifecycle map with each state's count. Maps with a `hub`
  source warn when a cited concept is stale, due for a check or retired.
- **A `maps` addon and a `behavior-map` skill.** The addon carries the
  operations and the skill. The skill tells an agent how to draft a map from
  specs or a hub: what the person sees, in their words, citing every element,
  declaring status only with evidence, then checking, rendering and pinning.
- The kit dogfoods it: its knowledge lifecycle map, citing its own
  `knowledge-format` and `freshness-policy` scenarios, lives in `maps/`.

Non-goals: running a model checker (TLA+ and the like are external evidence
sources), running tests, generating maps with a model inside the CLI, a GUI or
editor, SCXML or executable statecharts (no guards, actions or parallel
regions), maps that cite more than one source, citing pending change deltas,
and test evidence for `lid` behaviors.

## Capabilities

### New Capabilities
- `behavior-sources`: the adapter boundary over a repository's or hub's
  behavioral truth, the `openspec`, `lid` and `hub` sources, stable IDs,
  fingerprints and listing them.
- `behavior-maps`: the map format, deterministic checks (structure, citations,
  coverage, pins, labels), status overlays and their derivation, rendering, the
  generated diagram block, context state, the `maps` addon and the drafting
  skill.

### Modified Capabilities
- None. The `addons` catalog requirement already covers listing a new addon,
  and `help`'s completeness requirement covers the new commands, tools and codes.

## Impact

- New `lib/behavior/`: `sources.mjs` (the boundary and the `openspec`, `lid`
  and `hub` sources, reusing `lib/specs/openspec.mjs`, `specSource`'s store rule
  and `lib/workspace.mjs` concept reads), `maps.mjs` (find, parse, check, pin),
  `status.mjs` (declared and derived status, JUnit parsing, reusing
  `lib/specs/links.mjs`), `render.mjs` (Mermaid and JSON) and `context.mjs`
  (context states).
- `lib/operations.mjs`: group `maps` with `list_behaviors`, `list_maps`,
  `check_map`, `render_map`, `context_states` (read-only, also over HTTP), and
  CLI-only writes `render_map --write` and `pin_map`. `bin/hub.mjs` gains
  `maps behaviors|list|check|render|pin|context`.
- New `addons/maps/addon.json`, `skills/behavior-map/`, a `maps` help topic,
  `skills/context-kit/references/maps.md`, `docs/maps.md`, README and
  `docs/next.md`. New error codes `UNKNOWN_MAP`, `INVALID_SOURCE`,
  `RESULTS_FORMAT`.
- New `maps/context-states.md` in this repository.
- Tests: new `test/e2e/maps.test.mjs` (temporary repositories with OpenSpec and
  LID specs, hubs and JUnit files; CLI and MCP SDK clients).
- No new dependencies: `yaml` and `zod` are already pinned.
- No overlap with the open plans. `hub-federation` (#48) and `repo-context` (#49)
  introduce `<hub>:/<concept-id>` references; this change uses the same form, and
  a `hub` source naming a mount works once #48 lands, without changes here.
  `machine-setup` (#50) and `remote-mcp-access` are unaffected: every map tool
  reads only the workspace, so it is served over HTTP like `list_specs`.
