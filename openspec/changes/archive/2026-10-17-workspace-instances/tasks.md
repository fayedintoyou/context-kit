# Tasks

## 1. Instances

- [x] 1.1 Declare `context-kit` and `context-kit-mcp` executables and the repository in the core package.json, and verify they run from an installed copy in the e2e test
- [x] 1.2 Write a pinned `package.json` and ignore `node_modules/` on `init`, with `--kit <npm-spec>` and a default of the core repository at its current commit, and verify with the e2e test "an initialized workspace runs the core from its own dependencies" linked to "Run the core from an instance"
- [x] 1.3 Document instances in the README and verify the documented commands run

## 2. Integration

- [x] 2.1 Run `npm test` and `openspec validate workspace-instances --strict`, and verify both pass
