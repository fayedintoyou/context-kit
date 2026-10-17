# Skills

Skills are reusable methods in the Agent Skills format (`SKILL.md` plus optional
`references/`).

- **Bundled skills** ship with the core and are referenced as `kit:<name>`:
  `context-kit` (this help), `reflect`, `independent-review` and
  `audit-canonical-specs`. Each comes with an addon.
- **Workspace skills** live in workspace addons (see `addons-and-install`).

| Task | CLI | MCP tool |
|---|---|---|
| List declared skills | `skills` | `list_skills` |
| Read a skill or its files | `read-skill <hub> <reference> [--file references/x.md]` | `read_skill` |

`agents install` puts enabled skills into Claude Code and Codex natively. Without
installing, the MCP server also offers each declared skill as a prompt (Claude
Code shows `/mcp__<server>__<skill>`).

- **reflect**: after substantial work, three parallel reviewers and a synthesizer
  turn the conversation's learnings into proposed edits on skills or hub concepts;
  nothing is applied without approval.
- **independent-review**: a separate reviewer checks a plan or deliverable before
  you act on it.
