# Capturing

Capture saves a finding as a new **unreviewed** note in a hub's `inbox/`, without
committing or pushing anything.

```sh
echo "What I learned" | npm run hub -- capture <hub-id> "Title" [--by human:<you>]
```

Over MCP the tool is `capture_note`, offered only when the server runs with
`--allow-write` (`agents install --allow-write`).

Each note is an OKF concept with `type: Note`, `status: draft`, no `verified`, and
`generated.by` naming who captured it: the MCP client's name and version, or the
CLI's `--by` actor (default `context-kit/<version>`). Agents cannot claim to be a
human.

Capture refuses the toolkit checkout itself: notes belong in your workspace.

## Reviewing notes

Read them with `browse <hub> inbox --inbox` and `read <hub> <id> --inbox`. Fold
anything durable into a curated concept, add `verified: { by: human:<you>, at:
<now> }` if you checked it, then delete the note. Commit when you choose.
