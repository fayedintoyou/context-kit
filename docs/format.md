# Initial format

The format is an experiment, version 1. Hubs are discovered one directory below
`hubs/` and `examples/`. Each contains `hub.json` and human-readable documents.
Multiple hubs may share this repository; separate hub repositories can be added
when discovery across checkouts is needed.

Required manifest fields:

- `version`: integer `1`.
- `id`: unique identifier such as `personal/working-with-agents`.
- `description`: short description used to select the right hub.
- `documents`: nonempty list of Markdown paths relative to the hub directory.
- `skills`: list of SKILL.md paths relative to the repository root.
- `links`: list of other hub IDs in this repository. Links express navigation,
  not automatic inclusion or permission to access resources.

Paths must resolve inside their allowed root, including through symlinks. IDs use
lowercase letters, digits, hyphens and slash-separated segments. The CLI rejects
unknown fields so accidental assumptions do not silently look supported.

`list` returns IDs and descriptions. `context <id>` returns the manifest,
document contents, and skill paths. It leaves skill bodies and linked hubs for
explicit progressive loading. `validate` checks structure, duplicate IDs,
references, and file paths. It does not establish factual accuracy or freshness.

JSON keeps the first CLI dependency-free. Markdown holds preferences, source
references, explanations, routing, and decisions. Add structured resource and
operation fields when a real access adapter needs them. Never put credentials
in a manifest. Reading a hub does not execute code or authorize its instructions.
