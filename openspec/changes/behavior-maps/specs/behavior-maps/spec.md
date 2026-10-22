# Spec Delta

## Purpose

Let people and agents draw maps of user-visible states and the moves between them, or of a persona's or team's working states, each state citing the behaviors it represents, with evidence-based status, and let deterministic code check, pin and render those maps.

## ADDED Requirements

### Requirement: Map files
A map SHALL be an OKF concept with `type: BehaviorMap` holding exactly one fenced block whose info string is `yaml map`. A repository's maps are `maps/<name>.md` in the workspace repository, named `<name>`. A map name with no map SHALL fail with `UNKNOWN_MAP`.

#### Scenario: List maps
- **WHEN** a workspace repository has `maps/alerts.md` and `maps/sign-in.md`
- **THEN** `maps list` and `list_maps` return `alerts` and `sign-in` with title, source and scope

#### Scenario: Unknown map
- **WHEN** a caller checks a map name with no file
- **THEN** the request fails with `UNKNOWN_MAP` naming it

### Requirement: Hub maps
`BehaviorMap` concepts in the workspace's own hub directories SHALL also be maps, named `<hub-id>:/<concept-id>`, listed, checked and rendered like repository maps. Inbox notes SHALL never be maps.

#### Scenario: A team's working states
- **WHEN** a hub holds a map of a fictional support team's working states (triage, waiting on a customer, escalated, solved) whose states cite the hub's concepts
- **THEN** `maps list` includes it as `<hub-id>:/<concept-id>`, `maps check` reports it valid, and `maps render` draws it

#### Scenario: A hub map does not cover itself
- **WHEN** a hub map's scope is the whole hub and it cites every concept of the hub
- **THEN** the check lists nothing as `uncovered`, neither the map itself nor another map in the hub

### Requirement: Map contents
A map block SHALL declare `version: 1`, a `source` (`openspec` with optional store, `lid`, or `hub` with a hub ID), a nonempty `scope`, nodes and transitions. Each node SHALL have an ID, a label and a kind (`start`, `state`, `choice`, `end`; `state` when omitted); each transition a `from`, a `to` and, leaving a choice, a `when` label. Unknown keys SHALL be errors.

#### Scenario: Unknown key
- **WHEN** a map's node carries a `colour` key
- **THEN** `maps check` reports an error naming the map, the node and the key

### Requirement: Map structure
`maps check` and `check_map` SHALL report as errors: duplicate node IDs, transitions naming unknown nodes, not exactly one start, a node unreachable from the start, a choice with fewer than two exits or an exit without `when`, and an end with exits.

#### Scenario: Unreachable state
- **WHEN** a map has a state no transition or fix reaches from the start
- **THEN** the check reports an error naming the map and that state

#### Scenario: Valid map
- **WHEN** a map's structure, citations and labels are all valid
- **THEN** the check reports the map valid with no errors, over CLI and MCP alike

### Requirement: Citations resolve
Every `state` node SHALL cite at least one behavior of the map's source by its source ID; start, choice and end nodes and transitions MAY. A citation naming no behavior, or naming more than one (such as a requirement and a scenario, or two scenarios, sharing a name in one capability), SHALL be an error naming the element and the citation.

#### Scenario: Uncited state
- **WHEN** a map has a state with no citations and a choice with none
- **THEN** the check reports an error for the state and none for the choice

#### Scenario: Unknown citation
- **WHEN** a state cites `alerts / Badge on mention` and the source has no such requirement or scenario
- **THEN** the check reports an error naming the state and the citation

#### Scenario: Ambiguous citation
- **WHEN** two requirements of `alerts` each have a scenario named `Quiet hours` and a state cites `alerts / Quiet hours`
- **THEN** the check reports the citation as ambiguous, naming both requirements

### Requirement: Coverage
The check SHALL list as `uncovered` warnings the behaviors in the map's scope that no element cites: OpenSpec scenarios of the scoped capabilities or requirements, `lid` IDs with a scoped prefix, or hub concepts under a scoped directory. A cited requirement covers its scenarios. Maps are never behaviors, so no map is uncovered.

#### Scenario: Uncovered scenario
- **WHEN** a map's scope is `alerts` and one of its scenarios is cited by no element
- **THEN** the check lists that scenario as `uncovered` and the map is still valid

#### Scenario: Scope narrowed to a requirement
- **WHEN** a map's scope is `alerts / Mention badge` and every scenario of that requirement is cited, while other `alerts` scenarios are not
- **THEN** the check lists nothing as `uncovered`

#### Scenario: Linked-intent scope
- **WHEN** a map over the `lid` source has scope `AUTH-UI` and its one state cites `AUTH-UI-001`, then its scope becomes `AUTH-U` and the state cites `AUTH-UI-009`
- **THEN** the first check is valid and lists `AUTH-UI-002` as `uncovered`, and the second reports the citation and the scope as `unknown_citation`

### Requirement: Pinned citations
`maps pin <map>` (CLI only) SHALL record each citation's current fingerprint in the map block and change nothing else in the file. The check SHALL warn `unpinned` for a citation with no pin and `stale` for one whose behavior's fingerprint differs from its pin, naming the elements that cite it, and JSON rendering SHALL give each citation's pin state.

#### Scenario: Spec changed after pinning
- **WHEN** a map is pinned and then the text of a scenario one state cites is edited
- **THEN** the check reports that citation `stale`, naming the state, JSON rendering gives its pin state as `stale`, and after `maps pin` neither does

#### Scenario: Pin and render converge
- **WHEN** a map is pinned, checked, rendered with `--write` and checked again, and then pinned and rendered with `--write` once more
- **THEN** the second check reports no `unpinned`, `stale` or `diagram_outdated` warning and the second pin and render leave the file byte-identical

### Requirement: Plain-language labels
The check SHALL report as errors node labels over 70 characters, `when` labels over 50, and labels containing backticks, identifiers with underscores or inner capitals, file paths, spec IDs such as `AUTH-UI-001`, or the words SHALL, MUST, WHEN or THEN. Terms in the map's `vocabulary` list SHALL be exempt.

#### Scenario: Label reads as code
- **WHEN** a state's label is "Sets `unreadCount` on the room"
- **THEN** the check reports a label error naming the state and the offending token

#### Scenario: Allowed term
- **WHEN** a state's label is "A GitHub issue opens" and a transition's `when` is "A DM or an @mention", and the map's vocabulary lists `GitHub`, `DM` and `@mention`
- **THEN** the check reports no label error, and without `GitHub` in the vocabulary it reports one naming that token

### Requirement: Declared status
A node MAY declare status `works`, `issue` or `fixed`, with at least one evidence item: a repository path, a pull request number or an https link. An `issue` SHALL say who found it (`model-checker`, `test`, `review`, `user-report` or `other`) and MAY name a `fixed_by` node, which SHALL declare `fixed`. A missing path or wrong fix target SHALL be an error.

#### Scenario: Issue and its fix
- **WHEN** a state declares an issue found by a model checker, citing an existing model file, with `fixed_by` naming a state declared `fixed` with a pull request
- **THEN** the check reports both statuses as declared, with their evidence, and no error

#### Scenario: Missing evidence file
- **WHEN** a declared issue's evidence names a repository path that does not exist
- **THEN** the check reports an error naming the state and the path

### Requirement: Status from linked tests
Every node SHALL also get a derived status: for citations of the repository's own `openspec` source, `untested` when a cited scenario, or a scenario of a cited requirement, has no `// spec:` linked test, else `tested`; otherwise `unknown`. Derived status SHALL never be `works`, `issue` or `fixed`. The check report and JSON rendering SHALL give each node's statuses with origin (`declared` or `derived`), reason and evidence.

#### Scenario: Tested and untested states
- **WHEN** one state cites a scenario with a linked test, another cites a scenario without one, and a third declares `works` with evidence and cites a scenario without one
- **THEN** the check reports the first `tested` and the second `untested` as derived, naming the untested scenario, and the third `works` as declared with derived `untested` beside it

#### Scenario: Statuses in JSON
- **WHEN** that map is rendered with `--format json`
- **THEN** each node carries the same statuses, origins, reasons and evidence the check reported

### Requirement: Mermaid rendering
`maps render <map>` and `render_map` SHALL draw a map as a Mermaid flowchart with one shape per node kind, labels as written and choice exits labelled with their `when`. The same inputs SHALL give byte-identical output.

#### Scenario: Render a map
- **WHEN** a map with a start, two states, a choice and an end is rendered twice, over CLI and MCP
- **THEN** both outputs are identical and match the expected diagram

### Requirement: Status in diagrams
A rendered diagram SHALL colour declared statuses (grey works, red issue, green fixed), draw derived `tested` and `untested` in distinct outlined styles, add a key naming only the statuses present and saying which are derived, and draw a dashed "with the fix" edge from each issue to its fix.

#### Scenario: Render a map with a fix
- **WHEN** a map with a declared working state, a declared issue with its declared fix and an untested state is rendered
- **THEN** the diagram colours the first three grey, red and green, outlines the last as untested, draws the fix edge and keys the untested style as derived

#### Scenario: Status key shows on GitHub
- **WHEN** a map file with declared and derived statuses and a written diagram is pushed and viewed on GitHub
- **THEN** GitHub draws the status colours, the fix edge and the key

### Requirement: JSON rendering
`--format json` SHALL return the map as normalized JSON: nodes and transitions in file order with their kinds and labels, and each element's resolved citations (ID, kind, title, fingerprint). It SHALL include no warning that depends on the evaluation instant, so the same map and repository always give the same JSON.

#### Scenario: Render as JSON
- **WHEN** a map is rendered with `--format json`
- **THEN** its nodes and transitions appear in the order of the map file with their kinds and labels, and each lists its resolved citations with ID, kind, title and fingerprint

### Requirement: Generated diagram
`maps render <map> --write` (CLI only) SHALL replace the map file's block between the generated-diagram markers, adding it after the map block when absent, and change nothing else. The check SHALL warn `diagram_outdated` when that block differs from a fresh rendering.

#### Scenario: Outdated diagram
- **WHEN** a map's labels change after its diagram was written
- **THEN** the check warns `diagram_outdated`, and after `maps render --write` it does not and the rest of the file is unchanged

#### Scenario: Diagram shows on GitHub
- **WHEN** a map file with a written diagram is pushed and viewed on GitHub
- **THEN** GitHub draws the diagram with its shapes and labels

### Requirement: Check outcome
The check report SHALL list each map with its errors and warnings, each with a code, element and message. The CLI SHALL exit nonzero when any error is reported, or any warning with `--strict`; MCP SHALL return the report either way.

#### Scenario: Strict check in CI
- **WHEN** maps have only an `uncovered` warning and are checked with and without `--strict`
- **THEN** the CLI exits zero without it and nonzero with it, and the reports are otherwise equal

### Requirement: Map writes are CLI-only
Pinning and writing diagrams SHALL be offered only by the CLI. MCP SHALL offer the read-only map tools and no tool that writes a map, even with writes allowed.

#### Scenario: No write tools over MCP
- **WHEN** a client lists tools on a server started with `--allow-write`
- **THEN** `list_maps`, `check_map`, `render_map` and `list_behaviors` are listed and no map-writing tool is

### Requirement: Context map warnings
For a map with a `hub` source, the check SHALL warn `context_stale` for each cited concept whose freshness action is `verify` or `refresh`, or whose status is `deprecated`, at the evaluation instant, naming the citing element and the reason. Rendered output SHALL NOT include these warnings.

#### Scenario: Map cites an outdated concept
- **WHEN** a team's working-states map cites a concept whose `stale_after` falls between two `--at` instants, and another concept marked deprecated
- **THEN** the check at the earlier instant warns only about the deprecated concept and at the later one also about the stale concept, naming the citing states

#### Scenario: Rendering ignores the clock
- **WHEN** that map is rendered as JSON and as Mermaid before and after the concept's `stale_after`
- **THEN** each pair of outputs is byte-identical and neither contains a `context_stale` warning

### Requirement: Maps addon
A `maps` addon SHALL provide the map operations and the `behavior-map` skill. When it is not enabled, map commands SHALL fail with `ADDON_DISABLED` and map tools SHALL be absent from MCP.

#### Scenario: Maps addon disabled
- **WHEN** a workspace enables only the `specs` addon and runs `maps list`
- **THEN** the command fails with `ADDON_DISABLED`, map tools are absent from MCP, and `addons` lists `maps` with `behavior-map` as not enabled

### Requirement: Drafting maps
The `behavior-map` skill SHALL guide an agent to draft a map from a source's behaviors in the words of the person who experiences them, cite every state, declare status only with evidence, and run `maps check` until it reports no errors before rendering and pinning.

#### Scenario: Draft from specs
- **WHEN** an agent follows the skill to map a capability's scenarios
- **THEN** its map uses plain labels, cites a behavior on every state, declares no status without evidence, and passes `maps check`
