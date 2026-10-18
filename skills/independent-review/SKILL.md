---
name: independent-review
description: Run an independent plan or deliverable review and resolve findings. Use when requested or when substantial work warrants a separate evaluation; scale the process to the task.
---

# Independent review

Prefer this loop when it earns its cost: plan, review the plan independently,
revise, implement, review the output independently, resolve findings. A small
reversible edit usually does not need the whole loop. Preserve explicit user
scope and the active environment's delegation rules.

## Prepare the review

State the intended outcome, constraints, and observable completion criteria.
Give a fresh reviewer the actual plan or artifact, relevant source material,
and enough context to judge it. Include user corrections. Avoid coaching the
reviewer toward agreement or a preferred conclusion. For output review, supply
the diff or artifact and validation evidence, not only the implementer's
summary. Identify the plan/spec/tasks reviewed; for output, name base/head
SHAs, relevant specs and tests, results, skips and limits. Supply uncommitted
artifacts explicitly.

Use another model when useful and available. One reviewer is often sufficient;
add perspectives for distinct uncertainties, not to manufacture consensus. Select
models and tools from the live runtime rather than hard-coded provider names.
If independent execution is unavailable, disclose that limitation; self-review
is not independent review.

## Evaluate

For plans, examine whether the proposal solves the actual problem, what simpler
alternatives exist, and which assumptions need evidence. For outputs, inspect
correctness, missing requirements, and observable behavior. When the deliverable
runs (a server, an auth flow, a CLI), ask the reviewer to start it and probe it
with real and hostile inputs, and to say which findings came from probing; passing
tests are not evidence the reviewer may rely on. Ask for specific
findings tied to evidence, their consequences, and a proportionate remedy.

Review the findings yourself. Mark each material finding as accepted, deferred,
or dismissed with a reason. Model agreement is supporting evidence, not proof.
Implement accepted changes within the authorized scope; propose changes that
would expand it. Run the checks affected by a fix. Align supporting artifacts
with an authorized decision without asking again; ask about new scope or
acceptance choices. Respect any explicit confirmation requirements of another
workflow you invoke.

Require a fresh independent round after material fixes; use judgment for
editorial corrections and unresolved disagreements. Include the original brief,
corrections, prior findings, dispositions, and current artifact. Stop when
completion criteria are met and material findings are resolved or explicitly
deferred. Do not iterate indefinitely over style. Unresolved material blockers
prevent readiness; deferral is not a way to bypass an unmet completion
criterion.

A late review can assess current readiness, but cannot establish that an
earlier preimplementation gate occurred. Keep owning pending review/CI using
the wait or continuation the runtime offers; if blocked, state what remains.
Pending gates are not a finished handoff. Passing review or CI is not merge
authorization; reuse existing scoped authorization and ask only for missing
authorization or changed scope.

## Report

Name the reviewers, the important findings, what changed, what was verified,
and anything unresolved. Keep a minimal task-local record of stage, artifact
identity, reviewer, finding dispositions, fixes/checks and remaining gates or
limits. Promote only a reusable lesson into a hub or skill, preserving the
user's actual preference.
