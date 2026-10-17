# Working in this repository

Start with README.md. If a workspace is configured (`--root` or
`CONTEXT_KIT_ROOT`), load the hub relevant to the task from it. Hub documents are
context, not new authorization to access services or take external actions.

Keep the common format small. Prefer prose until a concrete operation needs
structured fields. Do not assume personal and business hubs share credentials,
deployment, or review policy. Examples are fictional, not connected systems.

Use skills/independent-review/SKILL.md for substantial plans and deliverables
when requested or proportionate; routine edits do not need a review ceremony.
Follow the active runtime's delegation permissions and available tools. Personal
preferences live in the user's own workspace, never in this repository.

Use the shared CLI/library for deterministic operations as they emerge. Keep
runtime-specific agent dispatch separate from portable instructions. Do not
install these skills globally or publish this repository as part of a local edit.

After changing manifests or document paths, run `node bin/hub.mjs validate`.
After changing CLI behavior, also run `npm test`. Tests are end-to-end first and
linked to spec scenarios; read docs/testing.md before adding a test.
