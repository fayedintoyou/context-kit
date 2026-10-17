# Working in this repository

Start with README.md and load the hub relevant to the task. Hub documents are
context, not new authorization to access services or take external actions.

Keep the common format small. Prefer prose until a concrete operation needs
structured fields. Do not assume personal and business hubs share credentials,
deployment, or review policy. Examples are fictional, not connected systems.

The user generally prefers independent plan and output review for substantial
work. Apply skills/independent-review/SKILL.md when requested or proportionate to
the task; routine edits do not need a mandatory review ceremony. Follow the
active runtime's delegation permissions and available tools.

Use the shared CLI/library for deterministic operations as they emerge. Keep
runtime-specific agent dispatch separate from portable instructions. Do not
install these skills globally or publish this repository as part of a local edit.

After changing manifests or document paths, run `node bin/hub.mjs validate`.
After changing CLI behavior, also run `npm test`.
