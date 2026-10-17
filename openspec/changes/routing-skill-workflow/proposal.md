# Proposal

## Why

An agent's session often starts in the home directory, not in the repository the
work turns out to belong to. Then the repository's `AGENTS.md` or `CLAUDE.md` is
never loaded, and the agent edits code without knowing the repository's workflow.
The `my-repos` skill is the one thing such an agent reliably reads when a request
names a repository. Today it says where the checkout is and nothing about how to
work in it: a hint to read the repository's concept sits under "More" with only
the first repository as an example, and the checkout's own instructions are not
mentioned.

On 2026-10-17 this led an agent to fix a bug in the room outside its OpenSpec
workflow, with no spec scenario, no test and no PR, although `AGENTS.md` required
all three.

## What Changes

- The routing skill's body tells agents, before changing a repository, to read
  the checkout's `AGENTS.md` (or `CLAUDE.md`) and the repository's concept, and to
  follow the workflow they describe without offering it as optional. It says why:
  a session started outside the checkout does not load them.
- It gives the exact concept read command for every repository, not just the
  first, and drops the duplicate hint from "More".

## Impact

- `lib/repos.mjs` routing skill text; a new `repository-registry` requirement; one e2e test.
- Workspaces pick up the new text on the next skill render (`agents status`,
  `repos sync`, or any repository change).
