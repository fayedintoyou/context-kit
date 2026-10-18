# Proposal

> Planning package for reusable method/skill documentation. Implementing the public
> package remains gated on the application pilot and independent plan review. This
> change adds no CLI/MCP runtime behavior or common-format schema.

## Why

Context Kit connects context to accepted specifications and delivery, but needs a lightweight method for the preceding product decisions and subsequent evaluation. A reusable method should let people maintain alternatives, promote selected intent and assess outcomes without equating completed code with validated value.

## What Changes

- Develop a portable planning skill and Markdown templates for product outcomes, enabling capabilities, competing hypotheses, experiments, decisions and evaluation records.
- Describe proposal-only seeds separately from implementation-ready changes; link intent to existing OpenSpec delivery rather than duplicating its status or acceptance machinery.
- Explain ownership: project plans live with their project; hubs hold durable context, chosen working methods and navigation; private feedback and credentials remain in their authoritative systems.
- Supply a fictional example showing two roadmap views, typed dependencies and a feedback-to-decision-to-work-to-observation trace.
- Include a behavior-preserving refactor path with explicit existing scenario/test
  references and `skip_specs: true` only when there is no spec-level behavior change.
- Learn from an application pilot before fixing template fields. Record manual authoring as the baseline; any demonstrated need for CLI/MCP validation or projections becomes a separately scoped behavior change.

## Capabilities

### New Capabilities

None in this documentation/skill seed (`skip_specs: true`). Do not invent CLI requirements for an operation we have not needed yet.

### Modified Capabilities

None. Existing knowledge, progressive disclosure, skill library, change progress and archival behavior remain authoritative.

## Impact

Future skill/reference files, addon registration if appropriate, delivery documentation and a fictional example. No common hub-format fields, database, anonymous intake service, agent runtime orchestration or personal project content in the public toolkit.

## Relationship to delivery work

[PR #24](https://github.com/fayedintoyou/context-kit/pull/24) owns cross-repository delivery of accepted store contracts: party destinations, qualified change identity, evidence, packets and reconciliation. This seed sits upstream (intent/decisions) and downstream (evaluation). It does not modify that PR or copy its delivery machinery. A single-project pilot needs no store; cross-repository contracts use the existing contracts lifecycle and the delivery capability when available.

## Refinement checkpoint

Bring anonymized lessons from one real roadmap revision and one feedback disposition through linked work and evaluation. Choose only template fields that earned their place, decide whether to extend an existing skill or add one, and assess any proposed command through observable CLI/MCP scenarios in a later change. Tooling extraction does not block the pilot.
