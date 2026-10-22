# Behavior maps

Specs say what a system must do one requirement at a time. Nobody experiences a
system that way: a person using a chat app experiences a path. Someone posts, a
dot or a badge appears, a pop-up shows or the phone buzzes. A behavior map draws
that path as the states a person sees and the moves between them, each state
citing the spec behaviors it represents. It resembles a statechart, the familiar
term, but it is a picture with citations, not a model to run: no guards, actions
or parallel regions.

Drawing a map is interpretation, so a model or a person drafts it, following the
[behavior-map](../skills/behavior-map/SKILL.md) skill. Keeping it honest is
mechanical, so Context Kit does that: whether every state cites a real behavior,
which behaviors in scope no state covers, whether a cited behavior changed since
someone reviewed the map, whether labels are in plain words, and how the map is
drawn. Context Kit never runs tests, checkers or models; it reads OpenSpec specs
only through the pinned OpenSpec CLI and linked-intent development spec files as
plain text.

The `maps` addon provides the operations and the skill. It is opt-in: enable it
with `init --addons maps,...` or in `context-kit.json`. The `maps` help topic
(`context-kit help maps`) has the full format and every check code.

## The journey

1. **See what exists.** `maps behaviors --source openspec` (MCP `list_behaviors`)
   lists the canonical requirements (`<capability> / <requirement>`) and scenarios
   (`<capability> / <scenario>`) of the repository, or of a readable shared store
   with `--store`, each with a fingerprint of its normalized text. Pending change
   deltas are not listed. `--source lid` lists the entries of a repository that
   keeps its specs the [linked-intent development](https://github.com/jszmajda/lid)
   way (`docs/intent/**/*-specs.md` or `docs/specs/*.md`): each `**<ID>**:` list
   item with its text and status marker (`[x]` implemented, `[ ]` a gap, `[D]`
   deferred, or none). A map over them cites entry IDs and scopes ID prefixes.
2. **Draft** `maps/<name>.md`: an OKF concept with `type: BehaviorMap` and one
   fenced `yaml map` block naming its source, its scope (capabilities or
   requirements; ID prefixes for `lid`), its nodes (`start`, `state`, `choice`, `end`) and transitions,
   labelled in the person's words, every state citing behaviors.
3. **Check.** `maps check [<name>]` (MCP `check_map`) reports errors (schema,
   structure, an uncited state, a citation that names no behavior or more than
   one, a label that reads as code or spec language) and warnings (a scenario in
   scope nothing covers, a citation not yet pinned or changed since it was, an
   outdated diagram). The CLI exits non-zero on an error,
   and with `--strict` on a warning too, so `context-kit maps check --strict` can
   gate CI.
4. **Render.** `maps render <name>` (MCP `render_map`) draws a map with no errors
   as a Mermaid flowchart; `--format json` gives its normalized model with each
   citation resolved to its kind, title, fingerprint and pin state. The same map and specs
   always give byte-identical output.
5. **Show it.** `maps render <name> --write` (CLI only) puts the diagram in the map
   file between generated-diagram markers, changing nothing else, so GitHub draws
   it. MCP offers only the read-only map tools, even with writes allowed.
6. **Pin.** Once a person has reviewed the map, `maps pin <name>` (CLI only)
   records each citation's fingerprint under the block's `pins`, changing nothing
   else. When a cited spec changes, the check warns `stale` naming the state that
   cites it, until someone reviews the map again and re-pins. Pins don't affect
   the diagram, so pin, check, render and check converge, and pinning and
   rendering again leave the file as it is.

## An example

The fictional chat app Pigeon has an `alerts` capability. Its map
[test/e2e/fixtures/maps/pigeon/maps/alerts.md](../test/e2e/fixtures/maps/pigeon/maps/alerts.md)
starts at *A teammate posts*, asks *What kind of post is it?*, and leads to *A quiet
dot appears next to the room* or *The room shows a number badge*, citing the
requirements behind each. Its written diagram is what GitHub shows on that page.

## Labels

Labels are checked mechanically and small: node labels up to 70 characters, `when`
labels up to 50, and no token that reads as code or spec language (backticks,
underscores, inner capitals such as `unreadCount`, file paths, `::`, `()`, `=>`,
`==`, diagram or web markup such as `<`, `{` or `%%`, spec IDs such as
`AUTH-UI-001`, or SHALL, MUST, WHEN, THEN). Whatever passes is drawn as plain
text: characters Mermaid treats specially become entity codes, so a label can
never turn into a directive, a style or a link. Product words
that look like code, such as `GitHub` or `iPhone`, go in the map's `vocabulary`.
Whether a label is really in the person's words is judgment, left to the skill and
to review.

## Later

Planned in the `behavior-maps` change: hub maps of a persona's or team's working
states, and declared status with evidence beside status derived from linked tests.
