# Tasks

## 1. Archive spec-less changes

- [x] 1.1 Add the end-to-end test "archive --ready archives a change without spec deltas" in `test/e2e/archival.test.mjs`, linked to "Archive a change without spec deltas"; verify it fails with `ADAPTER_FORMAT` before the fix
- [x] 1.2 Accept an archive reply without `totals` in `lib/specs/openspec.mjs`, reporting `{}`; verify the new test and `npm test` pass
