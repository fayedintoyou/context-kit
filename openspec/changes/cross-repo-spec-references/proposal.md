# Proposal

## Why

Specs can live beside a repository's code or in a shared OpenSpec store used across repositories. `local-context-mvp` lets a workspace read declared stores, but an agent in a repository still cannot tell which shared requirements apply to that repository, and audits treat a repository as if its own specs were the whole contract.

## What Changes

- Read the store references a repository declares in its OpenSpec config (`references:`), one level deep, with per-store health.
- Return referenced store specs alongside, but separate from, the repository's own specs, each labeled with its source.
- Extend repository audits with referenced store requirements, marked `applicability: not_assessed` and keyed by store, kept apart from the repository's own checklist.
- Keep store audits structural only, and say in the report that semantic review of a shared requirement starts from each referencing repository.
- Out of scope: following a store's own references, cloning or fetching stores, writing to stores, and remote hosting.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `canonical-spec-audit`: adds referenced-store discovery and reference-aware audits. This capability is introduced by `local-context-mvp`, which must be archived first.

## Impact

Spec adapter, audit report shape (additive fields), the `list_specs` and `audit_specs` operations, CLI `specs` subcommands, the audit skill, and tests. No new dependencies. Depends on the OpenSpec store and reference behavior in the pinned 1.14.3 release, which OpenSpec labels beta.
