# Tasks

## 1. Manual discovery checks

- [ ] 1.1 Gemini CLI: in a workspace with a registered repository, run `agents install --agent gemini`, start `gemini` in `$(mktemp -d)`, and record its version, the date and whether `my-repos` is listed naming the repository in `test/manual-checks.md` (`agent-installation / Routing skill is discovered`)
- [ ] 1.2 GitHub Copilot CLI: the same with `--agent copilot` and `copilot`
- [ ] 1.3 Cursor: the same with `--agent cursor` (and once with `--agent claude,cursor`, noting which copy it lists) in Cursor's agent
- [ ] 1.4 For any harness that doesn't list it, open a fix or correct its row in the harness table; verify `node bin/hub.mjs validate`
