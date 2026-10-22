# Spec Delta

## Purpose

Let people and agents draw maps of user-visible states and the moves between them, each element citing the behaviors it represents, with evidence-based status, and let deterministic code check, pin and render those maps for repositories and hubs alike.

## ADDED Requirements

### Requirement: Map files
A map SHALL be an OKF concept with `type: BehaviorMap` holding exactly one fenced block whose info string is `yaml map`. A repository's maps are `maps/<name>.md`, named `<name>`; a hub's maps are its `BehaviorMap` concepts, named `<hub-id>:/<concept-id>`. A missing map SHALL fail with `UNKNOWN_MAP`.

#### Scenario: List maps
- **WHEN** a workspace repository has `maps/alerts.md` and a hub has a `BehaviorMap` concept `team/working-states`
- **THEN** `maps list` and `list_maps` return `alerts` and `<hub-id>:/team/working-states` with title, source and scope

#### Scenario: Unknown map
- **WHEN** a caller checks a map name with no file
- **THEN** the request fails with `UNKNOWN_MAP` naming it

### Requirement: Map contents
A map block SHALL declare `version: 1`, a `source` (`openspec` with optional store, `lid`, or `hub` with a hub ID), a nonempty `scope`, nodes and transitions. Each node SHALL have an ID, a kind (`start`, `state`, `choice`, `end`) and a label; each transition a `from`, a `to` and, leaving a choice, a `when` label. Unknown keys SHALL be errors.

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
Nodes and transitions MAY cite behaviors of the map's source by their source IDs. A citation that names no behavior, or a name that is both a requirement and a scenario of one capability, SHALL be an error naming the element and the citation.

#### Scenario: Unknown citation
- **WHEN** a state cites `alerts / Badge on mention` and the source has no such requirement or scenario
- **THEN** the check reports an error naming the state and the citation

#### Scenario: Ambiguous citation
- **WHEN** a capability has a requirement and a scenario both named `Quiet hours` and a state cites `alerts / Quiet hours`
- **THEN** the check reports the citation as ambiguous, naming the requirement and the scenario

### Requirement: Coverage
The check SHALL list as `uncovered` warnings the behaviors in the map's scope that no element cites: OpenSpec scenarios of the scoped capabilities or requirements, `lid` IDs with a scoped prefix, or hub concepts under a scoped directory. A cited requirement covers its scenarios.

#### Scenario: Uncovered scenario
- **WHEN** a map's scope is `alerts` and one of its scenarios is cited by no element
- **THEN** the check lists that scenario as `uncovered` and the map is still valid

#### Scenario: Scope narrowed to a requirement
- **WHEN** a map's scope is `alerts / Mention badge` and every scenario of that requirement is cited, while other `alerts` scenarios are not
- **THEN** the check lists nothing as `uncovered`

### Requirement: Pinned citations
`maps pin <map>` (CLI only) SHALL record each citation's current fingerprint in the map block and change nothing else in the file. The check SHALL warn `unpinned` for a citation with no pin and `stale` for one whose behavior's fingerprint differs from its pin, naming the elements that cite it.

#### Scenario: Spec changed after pinning
- **WHEN** a map is pinned and then the text of a scenario one state cites is edited
- **THEN** the check reports that citation `stale`, naming the state, and after `maps pin` it reports no stale citation

### Requirement: Plain-language labels
The check SHALL report as errors node labels over 70 characters, `when` labels over 50, and labels containing backticks, identifiers with underscores or inner capitals, file paths, spec IDs such as `TIP-001`, or the words SHALL, MUST, WHEN or THEN. Terms in the map's `vocabulary` list SHALL be exempt.

#### Scenario: Label reads as code
- **WHEN** a state's label is "Sets `unreadCount` on the room"
- **THEN** the check reports a label error naming the state and the offending token

#### Scenario: Allowed term
- **WHEN** a transition's `when` is "A DM or an @mention" and the map's vocabulary lists `DM` and `@mention`
- **THEN** the check reports no label error for it

### Requirement: Declared status
A node MAY declare status `works`, `issue` or `fixed` with evidence: repository paths, pull request numbers or https links. An `issue` SHALL say who found it (`model-checker`, `test`, `review`, `user-report` or `other`) and MAY name a `fixed_by` node, which SHALL declare `fixed`. A missing path or wrong fix target SHALL be an error.

#### Scenario: Issue and its fix
- **WHEN** a state declares an issue found by a model checker, citing an existing model file, with `fixed_by` naming a state declared `fixed` with a pull request
- **THEN** the check reports both statuses with their evidence and no error

#### Scenario: Missing evidence file
- **WHEN** a declared issue's evidence names a repository path that does not exist
- **THEN** the check reports an error naming the state and the path

### Requirement: Status from linked tests
A node with no declared status citing behaviors of the repository's own `openspec` source SHALL get a derived status: `untested` when a cited scenario, or a scenario of a cited requirement, has no `// spec:` linked test, else `tested`. Other undeclared nodes SHALL be `unknown`. Each status SHALL carry its reason.

#### Scenario: Tested and untested states
- **WHEN** one state cites a scenario with a linked test and another cites a scenario without one
- **THEN** the check reports the first `tested` and the second `untested`, naming the scenario that has no test

### Requirement: Status from test results
Given a JUnit XML results file inside the workspace with `--results` or `results`, a `tested` node SHALL become `works` when every linked test of its citations passed, and `issue` found by `test` when any failed; a skipped test leaves it `tested`. A declared `works` or `fixed` with a failed linked test SHALL be an error. An unreadable file SHALL fail with `RESULTS_FORMAT`.

#### Scenario: Results decide status
- **WHEN** a results file shows one state's linked test passed and another's failed
- **THEN** the check reports the first `works` and the second `issue` found by `test`, naming the failed test

#### Scenario: Declared fix contradicted
- **WHEN** a state declares `fixed` and the results show a linked test of its citation failed
- **THEN** the check reports a status conflict error naming the state and the test

### Requirement: Mermaid rendering
`maps render <map>` and `render_map` SHALL draw a map as a Mermaid flowchart with one shape per node kind, labels as written, a colour per status (grey works, red issue, green fixed) with a key listing only statuses present, and a dashed "with the fix" edge from each issue to its fix. The same inputs SHALL give byte-identical output.

#### Scenario: Render a map with a fix
- **WHEN** a map with a working state, an issue and its fix is rendered twice, over CLI and MCP
- **THEN** both outputs are identical, match the expected diagram, color the three states grey, red and green, and draw the fix edge

### Requirement: JSON rendering
`--format json` SHALL return the map as normalized JSON: nodes and transitions in file order with their labels, resolved citations (ID, kind, title, fingerprint, pin state) and status with reason and evidence.

#### Scenario: Render as JSON
- **WHEN** a map is rendered with `--format json`
- **THEN** each node lists its resolved citations and its status and reason, in the order of the map file

### Requirement: Generated diagram
`maps render <map> --write` (CLI only) SHALL replace the map file's block between the generated-diagram markers with a rendering made without results, adding it after the map block when absent, and change nothing else. The check SHALL warn `diagram_outdated` when that block differs from such a rendering.

#### Scenario: Outdated diagram
- **WHEN** a map's labels change after its diagram was written
- **THEN** the check warns `diagram_outdated`, and after `maps render --write` it does not and the rest of the file is unchanged

### Requirement: Check outcome
The check report SHALL list each map with its errors and warnings, each with a code, element and message. The CLI SHALL exit nonzero when any error is reported, or any warning with `--strict`; MCP SHALL return the report either way.

#### Scenario: Strict check in CI
- **WHEN** maps have only an `uncovered` warning and are checked with and without `--strict`
- **THEN** the CLI exits zero without it and nonzero with it, and the reports are otherwise equal

### Requirement: Map writes are CLI-only
Pinning and writing diagrams SHALL be offered only by the CLI. MCP SHALL offer the read-only map tools and no tool that writes a map, even with writes allowed.

#### Scenario: No write tools over MCP
- **WHEN** a client lists tools on a server started with `--allow-write`
- **THEN** `list_maps`, `check_map`, `render_map`, `list_behaviors` and `context_states` are listed and no map-writing tool is

### Requirement: Context states
`maps context <hub-id>` and `context_states` SHALL place each concept of a hub in one state, first match wins: inbox note, retired, needs rewriting, due for a check, draft, unchecked, checked by a tool, checked by a person. It SHALL render the kit's lifecycle map with each state's count and list its concepts.

#### Scenario: A hub's context state
- **WHEN** a hub has a deprecated concept, a stale concept, a draft and two human-reviewed concepts, and an inbox note
- **THEN** the result counts one retired, one needs rewriting, one draft and two checked by a person, lists their IDs, and counts the inbox note only with `--inbox`

### Requirement: Context map warnings
For a map with a `hub` source, the check SHALL warn `context_stale` for each cited concept whose freshness action is `verify` or `refresh` or whose status is `deprecated`, naming the citing element and the reason.

#### Scenario: Map cites a retired concept
- **WHEN** a team's working-states map cites a concept that is later marked deprecated
- **THEN** the check warns `context_stale` naming the citing state and `deprecated`

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
