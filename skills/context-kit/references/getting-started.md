# Getting started

Context Kit has two parts:

- **The core toolkit** (this repository): the CLI, the MCP server, bundled skills
  and addons. It holds no personal content.
- **Your workspace**: a directory, usually its own private Git repository, that
  holds your hubs and pins a version of the core in `package.json`.

## Set up

```sh
npx -y github:fayedintoyou/context-kit setup ~/context --addons reflect,review --agent claude,codex
```

This creates `~/context` pinned to a core commit, runs `npm install`, and installs
the enabled skills and an MCP server into Claude Code and Codex. Restart the agents
afterwards. To create a workspace without installing it: `context-kit init <dir>`.

## First commands (inside the workspace)

```sh
npm run hub -- list                           # hubs in this workspace
npm run hub -- browse personal/main           # what a hub holds
npm run hub -- read personal/main README      # one concept
npm run hub -- search "deploy"                # text across every concept
echo "Idea" | npm run hub -- capture personal/main "Title"   # an unreviewed note
npm run validate                              # check every hub
```

Output is JSON. Run `context-kit help` for the topic list.

Register the repositories you work on so agents go straight to them (see
`repositories`): `npm run hub -- repos add <hub> <github-url> --alias <names>`, or
`repos scan ~` on a new machine to find checkouts of repositories already listed.
A hub can be personal or shared by a team through Git; both work the same way.

## Upgrade

Change the `context-kit` dependency in the workspace's `package.json` to a newer
commit, then `npm install`, `npm run validate` and `npm run agents -- install`.
