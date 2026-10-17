---
name: audit-canonical-specs
description: Compare a repository's canonical specifications with its implementation and tests. Use after meaningful behavior changes or archival, before releases, or for a requested periodic audit.
---

# Audit canonical specifications

Run the Context Kit `audit_specs` tool (MCP), or from a workspace instance
`npm run hub -- specs audit` (for another repository, `context-kit --root
<repository> specs audit`). The adapter
owns spec discovery and parsing. OpenSpec is the first supported source; pending
change deltas are not canonical. A structural pass is not a semantic verdict.

Read the returned snapshot, structural findings, and requirement checklist. If
there are no canonical specs, report the gap. If the tree is dirty, distinguish
working-tree evidence from committed evidence. For each requirement in scope,
inspect the implementation and relevant tests or runtime behavior. Record source
paths, symbols and concrete checks. Classify it as supported, contradicted, or
uncertain; absence of a test alone does not prove absence of implementation.

Attach findings to the audit's Git HEAD, dirty flag, canonical hash, adapter
version and requirement keys. Record any additional evidence needed to identify
dirty implementation files. If code or specs change during review, recheck the
affected claims. Do not relabel the deterministic audit as semantic verification.

Specs may also live in a shared OpenSpec store used by several repositories.
A repository audit lists requirements from stores it references under
`referenced`, keyed `store:<id>/...` and marked `applicability: not_assessed`;
`referenceWarnings` names stores that could not be read. First decide whether
each referenced requirement applies to this repository, citing the evidence,
then assess implementation as above. Report a missing referenced store as a
coverage gap. `specs audit --store <id>` checks a store's structure only;
assess its requirements from each referencing repository instead.

Propose whether a mismatch requires an implementation fix, an intentional spec
change, or further investigation. Never silently rewrite canonical intent to fit
the current code. Use the repository's existing spec lifecycle for accepted
changes; for OpenSpec, use its proposal/apply/archive workflow directly.

For substantial findings, use an independent reviewer with the original intent
and actual evidence. Report coverage and unresolved uncertainty. Save a report
with the task, or capture it in an explicitly selected private workspace. This
skill does not authorize publishing private evidence.

Trigger semantic review after relevant behavior changes or archival, before a
release, and when the user requests a periodic review. Scheduled CI can produce
a fresh structural report and checklist; it does not run this reasoning process
or certify implementation compliance.
