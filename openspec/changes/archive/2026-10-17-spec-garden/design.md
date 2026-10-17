# Design

## Context

The `specs` addon reads canonical specs through the pinned OpenSpec CLI
(`lib/specs/openspec.mjs`) and audits them in `lib/specs/audit.mjs`. The audit
collects a snapshot twice and fails with `SNAPSHOT_CHANGED` if HEAD, dirty state
or the canonical hash moved in between. It returns a checklist of requirements,
each marked `semantic: not_assessed`, and the `audit-canonical-specs` skill does
the evidence work. `scripts/spec-links.mjs` already parses scenarios from
canonical and in-flight specs and finds `// spec:` links in tests.

OpenSpec merges deltas on archive (`ADDED`, `MODIFIED`, `REMOVED`, `RENAMED`
sections per capability) and moves the change to
`openspec/changes/archive/<date>-<name>/`. Archived deltas stay on disk, so the
history of each requirement can be reconstructed from them. OpenSpec does not
expose that history, and it does not check whether its domain taxonomy still
makes sense.

## Goals / Non-Goals

**Goals:**
- Repeatable, measurable signals about the shape of the canonical tree, tied to a
  snapshot so findings can be cited and rechecked.
- Structural maintenance happens through a normal reviewed change, never by
  rewriting `openspec/specs/` in place.
- Capability-sized specs over time: smaller units are easier to garden, audit
  and trace.

**Non-Goals:**
- Semantic similarity, cohesion scoring or embeddings in the deterministic layer.
  Those judgments belong to the skill, which can read and reason. The scanner
  reports only what it can compute exactly.
- Deciding that a requirement is obsolete. The report can show that a
  requirement has no history, no linked tests and lexical overlap with a newer
  one. Whether it is still true is my decision.
- Applying or archiving the maintenance change. The existing OpenSpec workflow
  does that.
- Gardening across stores. `--store` gardens one store's own tree. Overlap
  between a repository and the stores it references is out of scope for now.
- Scheduling. A periodic run can be set up later with whatever scheduler the
  user already has. This change provides the operation and the skill.

## Decisions

1. **Two layers, mirroring the audit.** `garden_specs` is deterministic and
   read-only. `garden-canonical-specs` is the skill that interprets it. Putting
   LLM judgment into the operation would make reports unrepeatable and untestable
   end to end. Alternative: a single skill that reads the whole tree. Rejected
   because an agent rereading 40 specs every time is slow and inconsistent, and
   gives nothing to diff between runs.

2. **Report shape.** One JSON report, bounded by the same `MAX_OUTPUT` budget:

   ```
   { root, source, adapter, snapshot: { head, dirty, canonicalHash },
     status: 'ok' | 'no_canonical_specs',
     limits: { maxRequirements, maxLines, overlapThreshold },
     specs: [{ id, lines, requirements, scenarios, flags: ['oversized', ...],
               requirementsWithoutScenarios: [...], domain: 'declared'|'undeclared'|'unchecked' }],
     requirements: [{ key, spec, requirement, scenarios,
                      history: [{ change, date, op }], lastChanged,
                      lockedBy: [change...], untested: [scenario...] | null }],
     overlap: [{ a: key, b: key, score, method: 'lexical' }],
     trace: { convention: 'spec-links' | null, status: 'collected' | 'not_collected' },
     taxonomy: { status: 'absent' | 'checked', undeclared: [...], empty: [...], retiredInUse: [...] } }
   ```

   Requirement `key`s are the audit's keys, so a garden finding and an audit
   finding about the same requirement line up.

3. **History from archived deltas.** Parse each
   `archive/<YYYY-MM-DD>-<name>/specs/<capability>/spec.md` and record
   `ADDED`/`MODIFIED`/`RENAMED` requirement headers against the capability. A
   `RENAMED FROM/TO` pair carries history forward to the new name. The date is
   the archive directory's prefix. A requirement with no history entries was
   written directly into `openspec/specs/`, and the report says so (`history: []`)
   instead of guessing. Rename predecessors are resolved by name and archive
   date, so same-day archive names and delta section order cannot erase earlier
   entries; history remains sorted by date. An `ADDED` or rename into a reused
   name begins a new lineage; predecessor traversal stops at the selected
   archive date. When multiple lineage starts share that date, the archives
   cannot disambiguate them: omit that day's disputed entries from `history`
   and report `historyAmbiguities` with the key, date, candidate changes and
   `same_day_name_reuse` reason. Empty history with an ambiguity is unknown,
   not evidence of a direct canonical edit. Alternative: `git log -L` per
   requirement. Rejected as slow, and a move inside a file defeats it.

4. **Locks from active changes.** Any active change (not `archive/`) whose delta
   names a capability marks that spec. One that names a requirement under
   `MODIFIED`, `REMOVED` or `RENAMED` marks that requirement. The skill must not
   propose moving or merging locked requirements. Archiving the maintenance
   change while another change still edits the same requirement in its old
   location would conflict.

5. **Lexical overlap, labeled as such.** Normalize requirement name, text and
   scenario text (NFKC, lowercase, strip RFC 2119 keywords and stop words, light
   suffix stripping), take word 3-shingles, and report Jaccard similarity at or
   above `overlapThreshold` (default 0.35). Pairs are O(n²), which is fine at
   hundreds of requirements. Above the output budget the report keeps the top
   pairs by score and says it truncated. The method is in every entry so nobody
   reads it as semantic.

6. **Trace through the existing link convention.** Extract the scenario and link
   parsing from `scripts/spec-links.mjs` into `lib/specs/links.mjs`. Both the
   script and the garden report use it. If the repository has no `test/`
   directory or no links at all, trace is `not_collected` and `untested` is
   `null` rather than claiming every scenario is untested. Repositories with
   other traceability conventions get `not_collected`. The skill then searches
   code itself.

7. **Taxonomy file.** `openspec/taxonomy.yaml`, optional:

   ```yaml
   limits:            # optional; defaults shown
     maxRequirements: 12
     maxLines: 300
     overlapThreshold: 0.35
   domains:
     location-search:
       purpose: Finding locations by text, radius and filters.
       limits: { maxRequirements: 20 }   # optional per-domain override
   retired:
     - locations-platform              # names that should no longer exist
   ```

   It lives beside `config.yaml` rather than in it because OpenSpec validates
   its own config schema. A malformed file fails with `INVALID_CONFIG` naming
   the problem, the same code the workspace config uses. When the file is absent,
   domain checks report `unchecked` and only size, history, locks, overlap and
   trace are collected. Alternative: infer domains by clustering. Rejected
   because the point of the file is to record what I intend.

8. **The skill writes one change, or none.** The skill's procedure is:
   1. Run `garden_specs`. If `no_canonical_specs`, report it and stop.
   2. Triage the signals: oversized or undeclared specs, overlap pairs, history
      gaps combined with untested scenarios, and retired names in use.
   3. For each lead, read the specs involved, search the code and tests, and
      check git history. Record evidence (paths, symbols, commits) and a
      confidence level.
   4. Classify each finding as split, move, merge, rename, clarify, or
      **candidate retirement**. Drop leads that don't hold up. Skip anything
      locked and list it as deferred.
   5. If nothing survives, report the tree healthy with the snapshot and stop.
      Don't create an empty change.
   6. Otherwise create one change, `garden-<date>`, with a proposal listing each
      finding and its evidence, delta specs that express it, `taxonomy.yaml`
      updates, and tasks. Present candidate retirements to me as questions. A
      retirement goes into the deltas only after I confirm it.
   7. Validate the change with `openspec validate --strict` and hand it to me for
      review. Use `independent-review` when the change is large.

   How each move is expressed:
   - A **move** of a requirement between capabilities is a `REMOVED` in the
     source and an `ADDED` in the target with identical text and scenario names,
     so meaning is unchanged and reviewers can diff it.
   - A **split** is a set of moves into new capabilities.
   - A **merge** keeps one requirement and removes the other, with the surviving
     text covering both. It is a semantic change and is marked as such.
   - A **rename** uses `RENAMED`.

   Moving a scenario to another capability changes its `// spec:` link key. The
   change's tasks include updating those links, and `npm test` (spec-links)
   fails until they match.

9. **Store gardening.** `--store <id>` reads the store through the adapter like
   `audit_specs --store`. Archived history is read from the store's root when it
   has `openspec/changes/archive`. Trace is `not_collected` because a store has
   no code. Locks come from the store's active changes.

## Risks / Trade-offs

- **Lexical overlap misses paraphrases and flags boilerplate.** The skill treats
  it as a lead, and RFC 2119 and stop-word stripping reduce the noise. Embedding
  similarity could be added later as an opt-in signal with its model named in
  the report.
- **Archive history depends on archive hygiene.** A requirement edited directly
  in `openspec/specs/` has a gap in its history. The report shows gaps as gaps.
- **Moving requirements churns test link keys.** This is acceptable because the
  spec-links check makes the breakage loud. A future alias mechanism could avoid
  it.
- **Retiring an entire capability.** Removing every requirement can leave an
  empty spec. Verified against pinned OpenSpec 1.14.3: archive refuses the
  removal without `retire_capabilities: true` alongside `schema` in the change's
  `.openspec.yaml`. With that marker and no unaccounted content it deletes the
  canonical spec and prunes the empty folder. The skill proposes tasks for the
  marker and preserving any unaccounted content, never direct canonical deletion.

## Open Questions

- Should `audit_specs` include the garden report's `lockedBy` so audits also
  warn about in-flight edits? Leaning no, to keep the audit focused.
- Default limits calibrated on 2026-10-17 against this repository and
  `~/context/node_modules/context-kit`: both have 10 canonical capabilities,
  48 requirements and 59 scenarios, with maxima of 9 requirements and 85 lines
  (`canonical-spec-audit`). Both report zero lexical pairs at 0.35. Retain
  12 requirements / 300 lines / 0.35 as built-in defaults; neither available
  tree warrants raising them. The pinned copy's addon layout is rejected by
  the current workspace loader, so its report was run with the same
  `gardenSpecs(openSpec(root))` path directly, without changing the pin.
