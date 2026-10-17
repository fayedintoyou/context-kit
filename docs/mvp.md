# Local MVP

The first useful loop is: create a workspace, discover relevant context, retrieve
a skill, capture a finding, and find it again from either a CLI or an agent.

## Acceptance criteria

- A fresh workspace can be initialized without modifying an existing directory.
- Personal content can live outside this public toolkit repository.
- CLI and MCP use the same operation implementations and input validation.
- An agent can list hubs, search their documents, retrieve context and skills,
  and capture a note when writes are enabled.
- Captures are new Markdown files, never automatic commits or pushes. They remain
  distinct from maintained instructions until deliberately incorporated.
- Invalid IDs, paths, and inputs produce useful errors. References cannot escape
  their configured roots through ordinary traversal or existing symlinks.
- End-to-end tests exercise real CLI subprocesses and an official MCP SDK client.

## Deliberately later

Remote HTTP hosting, phone setup, interactive pages, external service credentials,
discovering hubs across repository checkouts, and arbitrary user-installed
operation execution. Specs shared across repositories are already readable
through OpenSpec stores that a hub declares or a repository references.
This iteration proves local behavior before deploying it.
