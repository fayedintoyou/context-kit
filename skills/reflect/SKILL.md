---
name: reflect
disable-model-invocation: true
description: Review the active conversation with three parallel reviewers, surface durable learnings, and route each to a concrete edit on an existing skill or hub concept. Use when the user says reflect.
---

# Reflect

Mine the current conversation for durable learnings, then route them into edits on
skills or hub knowledge. Invoke when the user says "reflect" or "/reflect".

Skip when the conversation is trivial, off-topic, or already covered by a skill the
agent followed correctly. One-offs are not learnings: a learning must change what
a future agent does on a different task.

The reviewer and synthesizer prompts live beside this file in `references/`. Read
them from the skill directory, or through Context Kit with
`read_skill` and `file: "references/<name>.md"` (CLI: `read-skill <hub> kit:reflect --file references/<name>.md`).

## 1. Locate the active transcript

Read only this conversation's transcript, from this project's transcript store.
Never search transcripts across projects or workspaces; they hold unrelated,
possibly private, conversations. Use `/bin/ls` because `ls` may be aliased.

- **Claude Code:** `~/.claude/projects/<slug>/`, where the slug is the working
  directory with non-alphanumeric characters replaced by `-`; confirm the
  directory exists before reading. List candidates with
  `/bin/ls -t <dir>/*.jsonl | head -10`; subagent transcripts are under
  `<dir>/<session-id>/subagents/`. The opening prompt is the first `"type":"user"`
  record that is the user's own words, not a meta or injected message.
- **Codex:** `/bin/ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -10`. Read only
  each file's first line (`head -n 1`) and keep files whose `session_meta` `cwd`
  equals the current workspace.
- **Cursor:** the `agent-transcripts/` directory named in the system prompt;
  candidates are `<id>.jsonl`, `<id>/<id>.jsonl` and `<parent>/subagents/<child>.jsonl`.

Take the candidate whose first user message matches this conversation's opening
prompt. If none matches, or the runtime keeps no transcript, write a tight digest
of the session instead: goals, user corrections, failures, decisions, outcomes.

## 2. Spawn three reviewers in parallel

Start all three in one step with the runtime's subagent mechanism. Give each
read access to the tools the transcript references (MCP servers, issue trackers,
CI logs) so it can check facts, and tell it not to edit files. Tell every
reviewer and the synthesizer never to copy credential-like strings (API tokens,
keys, passwords, connection strings) into findings, evidence or edits, and to
write `<redacted secret>` instead.

| Lens | Prompt | Model role |
|---|---|---|
| Judgment | `references/judgment-reviewer.md` | `reflect judgment`: strongest reasoning model |
| Tooling | `references/tooling-reviewer.md` | `reflect tooling`: a different model family when available |
| Divergent | `references/divergent-reviewer.md` | `reflect divergent`: strongest reasoning model |

Choose models from the live runtime; do not hard-code provider names, and send
the transcript only to providers the runtime already uses. If the workspace has a
concept with `type: Model Roles`, use its lines for the roles above and for
`reflect synthesizer`. Use high reasoning effort. If a requested model is
rejected, use the closest available one and say so.

Pass each prompt verbatim with its placeholders filled:

- `{{TRANSCRIPT_PATH_OR_DIGEST}}`: the transcript path from step 1, or the digest.
- `{{SKILLS_AND_HUBS}}`: the routing targets, from `skills` / `list_skills` and
  `list` / `list_hubs`: each skill's reference, name, description and file path
  (`kit:<name>` is `skills/<name>/SKILL.md` in the Context Kit checkout), and each
  hub's ID and description.

Reviewers return findings in their response.

## 3. Synthesize

Run one more subagent with `references/synthesizer.md` verbatim, filling the same
placeholders and inlining each reviewer's full output where marked, on the
`reflect synthesizer` model (default: the judgment model). It verifies the
evidence for everything it accepts and returns Accepted, Rejected and Backlog lists.

## 4. Structural enforcement check

Move any Accepted item that a test, lint rule, script, schema, metadata flag or
runtime check would enforce more reliably to Backlog. Prose is the last resort:
Context Kit's own scenario-linked tests (`docs/testing.md`) are the model.

## 5. Apply

Present the synthesizer's full Accepted, Rejected and Backlog output, then wait for
explicit approval before applying any Accepted edit. The user picks the subset and
may redirect routings. Skill and hub edits shape every future agent that reads them.

File each Backlog item without waiting as a note in the workspace hub the user
names; if they named none, ask once, suggesting their personal hub. Title it
`Backlog: <title>`, put tags in the body, and paraphrase rather than quote private
transcript content. Use `capture_note`, or the CLI `capture` when the MCP server
is read-only. Open an issue in a tracker only when the user asks. If the
transcript shows secrets pasted into chat or inlined in commands, file a backlog
item telling the user to rotate them.

Follow each approved row's routing exactly:

- **`edit <skill path>`, trivial** (one bullet, a tightened sentence, a corrected
  fact): edit the skill directly.
- **`edit <skill path>`, substantive** (a new section or pattern table, more than
  about ten lines): use the runtime's skill-authoring skill (`skill-creator`,
  `create-skill`) and its draft, test and iterate loop; otherwise draft, try it on
  a realistic prompt, and revise.
- **`tune description: <skill path>`** (the skill exists but did not trigger):
  rewrite the `description` with concrete trigger phrases and test it the same way.
- **`new skill: <kebab-name>`**: create it through the skill-authoring skill in
  Agent Skills format. Do not improvise its shape.
- **`hub concept: <hub>/<concept-id>`** (a durable fact about the user, team or
  domain, not a method): edit that OKF concept or add one, update `generated`,
  and leave `verified` for the user to add.

Bundled skills live in the Context Kit checkout (`kit:<name>` resolves to
`skills/<name>/SKILL.md` there). Edits to them are toolkit changes: make them in
that checkout, run its tests, and propose the diff; commit only when the user
asks. Workspace skills and hubs belong to the user's workspace; run `validate`
there after editing.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<path>`. What changed, one line each.
- New skills created: `<path>`. One line each (rare).
- Backlog captured: `<note path>` (`<tags>`). One line each.
- Dropped: one line per rejected finding with the synthesizer's reason.
