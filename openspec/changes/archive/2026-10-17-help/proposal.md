# Proposal

## Why

Context Kit has grown a CLI, MCP tools, addons, an installer and a knowledge format, but no help beyond a usage line. People and agents need to learn how to use it from the tool itself, and that help must not drift as commands change.

## What Changes

- A core `context-kit` skill, shipped with the always-on `core` addon: a short orientation whose help topics live in its `references/` (getting started, knowledge, navigating, capturing, addons and installing, specs, skills, commands, troubleshooting).
- `context-kit help [topic]` and a `help` MCP tool serve the same topic files, so help is one source.
- Help works even when a workspace's addon configuration is broken.
- A test fails when any CLI command, MCP tool or error code is missing from the help.

## Capabilities

### New Capabilities
- `help`: help topics through CLI, MCP and the core skill, kept complete by test.

### Modified Capabilities
None.

## Impact

`skills/context-kit/`, `addons/core/addon.json`, new `lib/help.mjs`, `lib/operations.mjs`, `bin/hub.mjs`, `lib/workspace.mjs` (starter hub declares the core skill), tests.
