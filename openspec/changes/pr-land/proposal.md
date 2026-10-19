# Proposal

## Why

Agents merge Faye's pull requests themselves, through `gh api … /pulls/<n>/merge` pinned to a tested
SHA (her working-with-agents preferences). The steps around a merge are written there as prose:
- refresh the head, base and checks;
- for substantial work, require an independent output review of the tested head;
- merge only into the default branch;
- afterwards confirm the merge, delete the branch and recheck dependent pull requests.

On 2026-10-19 three substantial pull requests (room #40, context-kit #42, room #50) merged without the
review, through 21 hand-written merge calls. A late review then found real bugs in all three. The agent
knew the rule and skipped it under momentum.

**Trust model (decided with Faye):** agents act in good faith but forget. This change makes the gated
path the easy one, and puts a tripwire on the raw path. It does not stop an agent determined to bypass
it, because merge credentials stay with the agent. Server-side enforcement (rulesets plus a trusted
required review check) is out of scope here. It would need GitHub Pro for the private room repository
and a reviewer the merging agent can't impersonate.

## What Changes

- **`context-kit pr land <n> --sha <tested>`** (CLI only). It lands a pull request only when:
  - it's open, targets the default branch, isn't conflicting, isn't behind a required merge queue, and
    its head is the given SHA, all checked again immediately before the merge;
  - the repository's **expected checks** all passed on that head;
  - for **substantial** work, a structured **review record** approves that head, or an explicit,
    posted `--skip-review "<reason>"`.

  Work is substantial by default. It counts as routine only by a narrow, stated exemption. The command
  merges pinned to the SHA. Afterwards it reports what happened to dependent pull requests, deletes the
  head branch only when that's safe, and reports a clear outcome even when cleanup fails or the merge's
  result is unknown.
- **A landing policy per repository,** `.context-kit/landing.json`, owned by the repository: its
  expected checks, checks that may be skipped (with why), and its routine exemptions. The toolkit
  ships the mechanism, not Faye's policy.
- **A review record format,** posted as a pull request comment, that the independent-review skill
  tells reviewers (or the agent relaying their result) to post.
- **A tripwire.** `agents install` adds a pre-command hook to Claude Code that refuses raw `gh` merge
  commands (`gh pr merge`, `gh api … /pulls/<n>/merge`), and tells the agent to use
  `context-kit pr land`. Where a runtime has no such hook (Codex today), the install reports that, and
  the gap is documented.

## Capabilities

### New Capabilities

- `pull-request-landing`: landing a pull request through its gates, and the tripwire on raw merges.

### Modified Capabilities

- `agent-installation`: installs and removes the merge tripwire for runtimes that support pre-command
  hooks, and reports runtimes that don't.

## Impact

- `lib/landing.mjs` (new), `lib/operations.mjs`, `lib/arguments.mjs` (value flags), `bin/hub.mjs`
  (usage), `lib/help.mjs`
- `lib/install.mjs` (the tripwire record kind), `bin/merge-guard.mjs` (new, the hook)
- `skills/independent-review/SKILL.md` (posting a review record),
  `skills/context-kit/references/commands.md`, `docs/delivery.md`
- `test/e2e/landing.test.mjs` and `test/e2e/merge-guard.test.mjs` (new)
- After it lands, the workspace: room's and context-kit's `.context-kit/landing.json`, and one line in
  working-with-agents preferences: merge with `context-kit pr land`
