---
name: behavior-map
description: Draft a behavior map (a statechart-like picture of what a person sees and the moves between states) from a repository's OpenSpec specs or linked-intent development (LID) specs, citing a spec behind every state, then check and render it with Context Kit. Use when asked to map, diagram or visualize a product journey or user flow from specs, or to keep such a map in step with them.
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
<requirement>`), or for linked-intent development specs an ID prefix (`AUTH`,
`AUTH-UI`). Ask the user if it's unclear whose journey it is. Keep a map
under about 25 nodes; a bigger journey becomes several maps, one per path a
person would describe separately ("signing in", "when a teammate posts").

## 2. See what exists

Run `maps behaviors --source openspec` (MCP `list_behaviors`) and read the
requirements and scenarios in scope. Cite them by the IDs it lists, exactly:
`<capability> / <requirement>` or `<capability> / <scenario>`. Only canonical
specs are listed; behavior a pending change adds can't be cited until it is
archived.

If the repository keeps linked-intent development specs (`docs/intent/**/*-specs.md`
or `docs/specs/*.md`, entries like `- [x] **AUTH-UI-001**: ...`), use
`source: { kind: lid }` and `maps behaviors --source lid` instead, and cite entry
IDs (`AUTH-UI-001`); `scope` lists ID prefixes. Each entry's `marker` says whether
it is implemented, a gap or deferred; that is the spec author's claim, not
evidence, so it doesn't belong in a label either. A duplicate ID fails with
`INVALID_SOURCE`: tell the user, since LID IDs must be unique.

## 3. Write it in the person's words

- A **state** is what the person sees, hears or feels: "The room shows a number
  badge", not "unreadCount is incremented".
- A **choice** is a question they would recognize: "What kind of post is it?",
  "Where are you?".
- A **`when`** on a transition is the condition in their words: "A DM or an
  @mention", not "event.type == mention". Every exit from a choice needs one;
  other transitions may carry one too, which is the place for something that
  happens out of the person's sight and moves them on ("The barista marks it
  ready").
- **start** and **end** frame the journey: "A teammate posts", "You've seen it".
- A transition may lead back to an earlier node when the person tries again
  ("You try another way to pay"); make sure each loop also has a way on to an
  end.
- Something true before the journey starts that no scenario describes (being
  signed in, say) belongs in the map's prose, not in an uncited state.

Keep node labels to 70 characters and `when` labels to 50. Leave out code,
markup (`<`, `{`, `%%`, `->`), spec IDs, file paths and spec words (SHALL,
MUST, WHEN, THEN). When the person
really says a product word that looks like code, such as `GitHub`, `iPhone` or
`DM`, list it in `vocabulary` rather than rewording it.

Don't claim in a label or the prose that a state works, is broken or is fixed;
that is what `status` is for, with evidence (step 5).

## 4. Cite every state

Every `state` cites at least one behavior in `cites`; cite a requirement when the
state shows all of it, or the scenarios it shows. Start, choice and end nodes may
cite but don't have to. If a state has nothing to cite, either the specs are
missing a behavior (say so to the user) or the state isn't part of this journey.

## 5. Declare status only with evidence

A node may carry a `status`, and only when there is evidence a reader can
follow: a file committed to the repository (a model file, a test, a review
record), a pull request as `#<n>`, or an `https://` link. Each status needs at
least one. A path counts only once it is committed (in HEAD); staging it is not
enough, so commit the evidence before declaring the status.

- **`issue`** only from a real finding: model checker output, a failing test,
  a review record or a user's report. Say who found it in `found_by`
  (`model-checker`, `test`, `review`, `user-report` or `other`), optionally
  naming the tool or person in `finder` (`TLA+`), which the diagram's key
  shows ("Problem TLA+ found"). A one-line `note` says what went wrong.
- **`fixed`** only with the pull request that fixed it. Draw the fixed
  behavior as its own state and name it from the issue with `fixed_by`; the
  diagram draws a dashed "with the fix" edge between them, and the fix needs no
  other way in.
- **`works`** never without evidence, such as the test that shows it or the
  pull request that shipped it. Don't infer it from a passing build.

Don't declare anything else. Context Kit also derives, for every node, whether
the scenarios it cites have linked tests (`tested`, `untested`, or `unknown`
for other sources, stores and nodes that cite nothing); that is not a claim
that anything works, and the report shows it beside what you declared, never
instead of it. A declared `works` with a derived `untested` beside it is worth
telling the user about.

## 6. Check until there are no errors

Write `maps/<name>.md` and run `maps check <name>` (MCP `check_map`). Fix every
error and run it again; a map with errors can't be rendered. An
`evidence_missing` error means an evidence path is not a file committed to the
repository (commit it, or fix the path), and `fix_target` that `fixed_by` names no
node declared `fixed`: fix the map, never the evidence to suit it. Then decide each
`uncovered` warning: add a state for that scenario, cite it from an existing one,
or say in the map's prose why it is out of this journey (or narrow `scope`).

## 7. Render

Run `maps render <name>` to read the diagram back and check it says what the
person experiences. Declared statuses are coloured (grey works, red issue,
green fixed), derived ones outlined (solid for tested, dashed for untested),
and a key lists the statuses present, marking the derived ones. Then `maps render <name> --write` puts the diagram in the
file so GitHub shows it; never edit that block by hand. `maps check` warns
`diagram_outdated` when the map changes later; render with `--write` again.

For a map others will rely on (committed to a shared repository, or used to plan
or report work), hand it to `independent-review` with the specs in scope: the reviewer checks that the labels are plain and that each state really
is what its citations describe.

## 8. Pin once a person has reviewed it

`maps check` warns `unpinned` for every citation until the map is pinned. Pin
only after a person (the user, or the reviewer above) has read the map against
its specs: `maps pin <name>` records each citation's fingerprint under `pins`
and changes nothing else. Never write `pins` by hand. When a cited spec changes
later, the check warns `stale` naming the state: reread that behavior, update
the state or its label if it no longer shows it, render with `--write` if the
map changed, and pin again once that is reviewed. A new citation is `unpinned`
until then. Don't pin just to silence the warnings: the pin says someone checked.

## Example

A fictional chat app, Pigeon, has an `alerts` capability with the requirements
*Room post without a mention*, *Mention badge*, *Desktop pop-up*, *Single
pop-up* and *Away from your desk*. A TLA+ model of the pop-up rules
(`models/Alerts.tla`, reported in #212) found that every device showed a
pop-up at once; #231 fixed it so only the device used last does. #198 shipped
the badge. `maps/alerts.md`, reviewed and pinned:

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
    status: { state: works, evidence: ["#198"] }
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
  - { from: what-kind, to: dot, when: "A post in a room, no @mention" }
  - { from: what-kind, to: badge, when: A DM or an @mention }
  - { from: badge, to: where }
  - { from: where, to: two-popups, when: At your desk }
  - { from: where, to: watch, when: Away from your desk }
  - { from: one-popup, to: seen }
  - { from: watch, to: seen }
  - { from: dot, to: seen }
pins:
  alerts / Room post without a mention: bd11b2c07e66
  alerts / Mention badge: 5c5fa649501a
  alerts / Desktop pop-up: ab5e1a1449bf
  alerts / Single pop-up: eb3dc9a349e1
  alerts / Away from your desk: 7a84c94c1a77
```
````

In YAML's `{ ... }` style, quote a label with a comma or a leading `@`, as in
the first `when` above, and an evidence item starting with `#`, which YAML
would otherwise read as a comment.
