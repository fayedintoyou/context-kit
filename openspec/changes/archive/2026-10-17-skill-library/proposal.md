# Proposal

## Why

Context Kit ships reusable methods as skills, but agents can only read a skill's `SKILL.md`, and invoking one depends on each runtime's own skill installation. The user wants a `reflect` skill that turns each conversation's learnings into edits on skills and hub knowledge, shipped with the toolkit and invokable on its own, so the toolkit and bespoke skills improve with use.

## What Changes

- Bundle a portable `reflect` skill (`kit:reflect`) with reviewer and synthesizer prompt references.
- `read_skill` accepts a `file` within the skill's directory, so agents can read a skill's references.
- New `list_skills` operation and CLI `skills` list the skills declared by a workspace's hubs, with name and description.
- The MCP server offers each declared skill as an MCP prompt, so clients can invoke it directly (for example as a slash command) without installing skills globally.
- New workspaces declare `kit:reflect` in the starter hub.

## Capabilities

### New Capabilities
- `skill-library`: bundled skills, reading skill files, listing skills and serving them as MCP prompts.

### Modified Capabilities
None.

## Impact

`skills/reflect/`, `lib/hubs.mjs`, `lib/workspace.mjs`, `lib/operations.mjs`, `bin/hub.mjs`, `bin/mcp.mjs`, README, e2e tests. No new dependencies.
