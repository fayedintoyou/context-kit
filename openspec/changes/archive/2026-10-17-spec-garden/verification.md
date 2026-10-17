# Verification

`npm test`: 95 end-to-end and link-check tests pass. `npm run spec-links`,
`node bin/hub.mjs validate` and `openspec validate spec-garden --strict` pass.
No unit tests or dependencies were added. `npm install` synchronized the lock's
root metadata with the existing pinned dependencies and executable entries.

Garden fixtures exercise CLI/MCP parity, addon gating, declared stores, audit key
and snapshot parity, read-only file hashes, collection races, pending-only trees,
limits, locks, lexical overlap and budget truncation, trace and taxonomy errors.
History fixtures use pinned OpenSpec new-change proposals and real archives,
including reverse-alphabetical same-day archives, combined modification/rename,
and reuse of an old requirement name. Ambiguous same-day lineage starts are
reported explicitly rather than assigned to both requirements.

Calibration ran on this checkout and `~/context/node_modules/context-kit`.
Both have 10 canonical capabilities, 48 requirements and 59 scenarios; the
largest has 9 requirements and 85 lines. Both have zero overlap pairs at 0.35.
Retained built-in defaults: 12 requirements, 300 lines, overlap threshold 0.35.
The pinned checkout's addon layout fails the current workspace loader, so that
report used the identical `gardenSpecs(openSpec(root))` path directly. Nothing
in the pinned checkout or its parent workspace was changed.

The CLI retirement experiment confirms that removing the last requirement is
blocked until `.openspec.yaml` declares `retire_capabilities: true` alongside
`schema`. With the marker, archive deletes the spec and prunes its empty folder.
The skill describes proposal tasks for this; this change remains unarchived.

Independent reviewer `review_garden` evaluated the actual implementation and
ran the skill on isolated fixture copies. The oversized fixture produced one
strictly valid `garden-2026-10-17` change: an identical requirement/scenario move,
a deferred locked requirement, and a retirement question with no unconfirmed
removal. Canonical SHA256 before and after was identical:
`04f8f6101c61e54e897af88645fa590a311e946e2945ff6fb4789edbcb4c3d66`.
The healthy fixture created no change.

Accepted review findings: same-day archive ordering dropped addition history;
a combined delta dropped modification history; reused names conflated lineages.
The implementation now follows rename predecessors, retains both operations,
and reports unresolved same-day name reuse under `historyAmbiguities`. Focused
rechecks passed all reproductions with no unresolved material objections.
Local raw reports and review notes are under `.state/review-garden/`.
