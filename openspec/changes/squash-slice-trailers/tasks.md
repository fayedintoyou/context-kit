# Tasks

## 1. Squash message

- [x] 1.1 `lib/landing.mjs`: read the pull request's title, body and author and the pinned compare's commits strictly; for a squash, build the message from them with the trailers deduplicated and the co-authors, refusing `TRAILERS_CONFLICT`, `TRAILERS_INVALID` or `EVIDENCE_INCOMPLETE` in both gate passes; pass it with the pinned merge
- [x] 1.2 `docs/delivery.md` and `skills/context-kit/references/commands.md`: what the squash message carries and the new refusals

## 2. Tests

- [x] 2.1 `test/e2e/landing.test.mjs`: "Slice trailers survive a squash" (the merge body, then `specs status` without `gh` on a temporary repository committed with that message), "No trailers are invented" and "Conflicting or malformed trailers" with the fake `gh`; `npm test` passes
- [x] 2.2 Output review of the implementation before merge (self-review; no independent reviewer was run)
