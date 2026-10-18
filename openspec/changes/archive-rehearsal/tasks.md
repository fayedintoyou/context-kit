# Tasks

## 1. Rehearse

- [ ] 1.1 `lib/specs/archival.mjs`: rehearse every active change on a scratch copy, attributing new issues per change, with a `baseline`. Tests linked to "A change that would not archive cleanly", "A clean rehearsal" and "Issues already in the canonical specs"
- [ ] 1.2 `lib/operations.mjs` and the CLI: `specs archive --rehearse [--store <id>]`, CLI-only and read-only, with a non-zero exit when a change introduces an issue

## 2. Check pull requests

- [ ] 2.1 `.github/workflows/openspec.yml`: an `archive-rehearsal` job on pull requests. Test linked to "Rehearsal in a pull request"
- [ ] 2.2 `docs/delivery.md`, and the `context-kit` skill's specs reference: what the check does and how to fix what it reports
