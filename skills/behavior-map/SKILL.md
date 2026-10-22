---
name: behavior-map
description: Draft a behavior map (a statechart-like picture of what a person sees and the moves between states) from a repository's OpenSpec specs, citing a spec behind every state, then check and render it with Context Kit. Use when asked to map, diagram or visualize a product journey or user flow from specs, or to keep such a map in step with them.
---

# Draft a behavior map

A behavior map shows a journey the way the person living it experiences it:
*A teammate posts → What kind of post is it? → The room shows a number badge*.
Each state cites the spec behaviors it represents. You draft the map, because
choosing what a person notices is interpretation. Context Kit checks and draws
it, because structure, citations, coverage, labels and rendering are mechanical.
The `maps` help topic has the format and every check code. Maps live in the
repository whose specs they cite: run the CLI with `--root <repository>`, or use
the MCP tools when the server's root is that repository.

## 1. Choose the scope

Pick one journey: a capability, or one requirement of it (`<capability> /
<requirement>`). Ask the user if it's unclear whose journey it is. Keep a map
under about 25 nodes; a bigger journey becomes several maps, one per path a
person would describe separately ("signing in", "when a teammate posts").

## 2. See what exists

Run `maps behaviors --source openspec` (MCP `list_behaviors`) and read the
requirements and scenarios in scope. Cite them by the IDs it lists, exactly:
`<capability> / <requirement>` or `<capability> / <scenario>`. Only canonical
specs are listed; behavior a pending change adds can't be cited until it is
archived.

## 3. Write it in the person's words

- A **state** is what the person sees, hears or feels: "The room shows a number
  badge", not "unreadCount is incremented".
- A **choice** is a question they would recognize: "What kind of post is it?",
  "Where are you?".
- A **`when`** on a transition is the condition in their words: "A DM or an
  @mention", not "event.type == mention".
- **start** and **end** frame the journey: "A teammate posts", "You've seen it".

Keep node labels to 70 characters and `when` labels to 50. Leave out code,
spec IDs, file paths and spec words (SHALL, MUST, WHEN, THEN). When the person
really says a product word that looks like code, such as `GitHub`, `iPhone` or
`DM`, list it in `vocabulary` rather than rewording it.

Maps carry no status yet: don't claim in a label or the prose that a state
works, is broken or is fixed. Leave that to evidence, such as tests and reviews.

## 4. Cite every state

Every `state` cites at least one behavior in `cites`; cite a requirement when the
state shows all of it, or the scenarios it shows. Start, choice and end nodes may
cite but don't have to. If a state has nothing to cite, either the specs are
missing a behavior (say so to the user) or the state isn't part of this journey.

## 5. Check until there are no errors

Write `maps/<name>.md` and run `maps check <name>` (MCP `check_map`). Fix every
error and run it again; a map with errors can't be rendered. Then decide each
`uncovered` warning: add a state for that scenario, cite it from an existing one,
or say in the map's prose why it is out of this journey (or narrow `scope`).

## 6. Render

Run `maps render <name>` to read the diagram back and check it says what the
person experiences. Then `maps render <name> --write` puts the diagram in the
file so GitHub shows it; never edit that block by hand. `maps check` warns
`diagram_outdated` when the map changes later; render with `--write` again.

For a map others will rely on, hand it to `independent-review` with the specs in
scope: the reviewer checks that the labels are plain and that each state really
is what its citations describe.

## Example

A fictional chat app, Pigeon, has an `alerts` capability with the requirements
*Room post without a mention* and *Mention badge*. `maps/alerts.md`:

````markdown
---
type: BehaviorMap
title: When a teammate posts
description: What a Pigeon user notices after a teammate posts, by the kind of post.
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
  - { id: seen, kind: end, label: You've seen it }
transitions:
  - { from: posted, to: what-kind }
  - { from: what-kind, to: dot, when: "A post in a room, no @mention" }
  - { from: what-kind, to: badge, when: A DM or an @mention }
  - { from: dot, to: seen }
  - { from: badge, to: seen }
```
````

In YAML's `{ ... }` style, quote a label with a comma or a leading `@`, as in
the first `when` above.
