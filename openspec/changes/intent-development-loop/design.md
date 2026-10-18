# Design

## Context

See [proposal](proposal.md). Context Kit already supplies progressive knowledge reads,
skills/addons and OpenSpec audit/delivery/review workflows. `docs/delivery.md` starts
at an accepted change; it does not own product priorities or evidence that a delivered
feature was valuable. The common hub format deliberately favors Markdown until a
concrete operation needs fields. Personal project material belongs in its workspace.

## Goals / Non-Goals

**Goals:** make an observed development method portable through instructions, small
templates and a fictional worked example, while reusing existing delivery authority.

**Non-Goals:** a roadmap database/UI, automated intent approval, anonymous intake,
runtime-specific worker dispatch, new hub fields, synchronizing third-party boards
or rewriting the cross-repository delivery plan. This documentation change has
`skip_specs: true`; a new command needs a separately scoped behavior change.

## Decisions

### 1. Pilot first, package a small optional method

Prepare one `product-development` skill with references for experiment and refactor
briefs under `skills/product-development/`, registered through the existing `specs`
addon. The skill routes into existing OpenSpec propose/apply and independent review
rather than implementing another lifecycle. Check existing skill routing before
registration so one user request does not trigger competing workflows. The skill is
explicitly for intent, hypotheses, prioritization and translation into planned work;
it does not take over ordinary implementation or feedback record updates.

Do not install globally or change a user's addons as part of authoring the toolkit.
The normal deliberate workspace upgrade/sync owns distribution. A separate new addon
adds installation decisions with no demonstrated benefit for this initial method.

### 2. Minimal concepts and ownership

The templates use ordinary prose for origin, desired outcome, hypothesis, competing
direction, decision, smallest experiment, prerequisites, change/test/PR references
and observation/next decision. Each field must earn its place through the pilot.
Keep product priority, delivery and evaluation distinct; typed implementation,
learning and related links explain relationships without forcing all work serially.
Shared IDs are project-local conventions, not a new global registry or OKF type system.

Authoritative project plans live with their project; hubs hold durable context and
navigation; canonical behavior remains OpenSpec; git/host evidence determines delivery.
The private inbox or source system remains authoritative for raw feedback. Public
examples and roadmap summaries do not copy private submissions or identifiers.

### 3. Two working paths, one translation boundary

Gameplay/product work states the hypothesis and smallest useful observation before
promoting selected work into an implementation-ready change. Future ideas stay seeds;
passing tests cannot imply validated value. An outcome can remain pending or be
unsupported after technically successful delivery. Do not make future human playtest
participation an implementation checkbox that blocks code delivery/archive.

Pure refactors state concrete friction, bounded code ownership and preserved accepted
behavior/API/save/test invariants. Use a scaffolded change with `skip_specs: true`
when there is no spec-level behavior change; do not invent requirements to make a
file move appear specified. A behavior repair or changed guarantee needs real deltas.
Content/config tuning within an existing contract records the product change and
conformance evidence without falsely claiming it is a pure refactor. Existing
scenario tests are preferable to tests mirroring extracted helpers; add focused
characterization only for meaningful uncovered invariants.

Both paths use proportionate independent plan review, implementation, output review
and resolution before readiness. Record actual gates honestly; late review cannot
restore an earlier missing gate. The skill never approves a requirement or authorizes
publication, messages, deployment or merging merely because a template is complete.

### 4. Evidence threshold and fictional example

Before implementing the packaged skill, retain pilot evidence of one real roadmap
revision and one reviewed feedback disposition connected to selected work and an
observed result. Manual/private records are sufficient; a bespoke feedback backend
is not required for the method. Link the evidence in the private/project source and
bring only anonymized lessons into toolkit planning. Do not publish the pilot's
identity, private repo links, messages or local paths in this public repository.

Create `examples/product-development/` as a conformant fictional hub plus narrative
walkthrough of two roadmap lenses, alternative hypotheses, one selected experiment,
one pure refactor, proposal-only seeds and separate delivery/evaluation results. It
must be labeled fictional so its example observations cannot be mistaken for pilot
evidence. A walkthrough dry-run can assess whether an agent finds the intended
artifacts without inventing a database; it is not a product-value validation.

### 5. Respect existing and in-progress delivery contracts

[PR #24](https://github.com/fayedintoyou/context-kit/pull/24) remains responsible for
party destinations, qualified store change identity, evidence, packets, reconciliation
and archival. Read its final landed behavior before writing any worked multi-repo
delivery instructions. Until available, the method links the selected repository-local
change and names any external contract dependency without claiming store delivery
exists. No new trailers, progress derivation or authority to fetch party repos here.

## Risks / Trade-offs

- [A template becomes paperwork] -> retain only fields used by the pilot and make
  ordinary prose the default; do not fully plan every future idea.
- [Refactor guidance masks changed behavior] -> require preserved scenario references
  and route actual behavioral changes back through deltas before implementation.
- [Example content leaks private evidence] -> fictional data only and explicit review
  of source links/paths before publishing.
- [Another skill duplicates existing workflows] -> narrow trigger/routing review and
  reuse propose/apply/reconcile rather than add a parallel governance process.

## Migration Plan

Complete the pilot evidence first. Author the skill, references and fictional hub,
register it in the specs addon and update discovery/docs through the existing format.
Run validation, skill discovery/read checks and applicable installation fixture tests,
then independent review. Rollback removes the optional skill registration and example;
project plans and canonical delivery behavior are unaffected. User workspaces upgrade
deliberately after the toolkit change lands; no automatic repin or installation here.
