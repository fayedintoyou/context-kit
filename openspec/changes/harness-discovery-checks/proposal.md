# Proposal

## Why

`machine-setup` added Gemini CLI, GitHub Copilot CLI and Cursor to `agents install`,
and its `agent-installation / Harness discovery checks` requirement gives each of
them a manual check in `test/manual-checks.md`: after an install, a session started
outside every checkout lists `my-repos`. Claude Code and Codex are checked end to
end (`test/e2e/discovery.test.mjs`). None of the other three is installed on the
owner's machine, so their checks have never been run. This change carries running
them, so `machine-setup` can archive without claiming results nobody recorded.

## What Changes

- Run the manual discovery check for each of Gemini CLI, Copilot CLI and Cursor on
  a machine that has it, following the `Routing skill is discovered` entry in
  `test/manual-checks.md`.
- Record each run there: harness version, date, and whether `my-repos` is listed
  with a description naming the repository.
- A harness that doesn't list the skill gets a bug fix in its own change, or a
  correction to the harness table in `skills/context-kit/references/addons-and-install.md`
  if its documented skill location turns out to be wrong.

No requirement changes: the checks are already specified (`skip_specs`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None.

## Impact

- `test/manual-checks.md` gains recorded outcomes.
- Possibly the harness table in `addons-and-install.md` and the README.
