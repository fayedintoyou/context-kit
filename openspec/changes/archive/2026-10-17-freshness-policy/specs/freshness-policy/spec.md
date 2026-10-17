# Spec Delta

## Purpose

Tell people and agents, on every read, whether a concept can be used as written, should be checked against its sources, or must be regenerated, according to a policy each hub tunes per kind of knowledge.

## ADDED Requirements

### Requirement: Freshness policy
A hub MAY declare `freshness` in `hub.json` with an optional `default` and an optional `types` map from OKF type to maximum age, each an ISO 8601 duration of years, months, weeks, days, hours or minutes. Validation SHALL reject any other shape.

#### Scenario: Invalid policy
- **WHEN** a hub declares a freshness age that is not an ISO 8601 duration, or an unknown key
- **THEN** validation fails with `INVALID_MANIFEST` naming the problem

### Requirement: Freshness decision
Every read SHALL report each concept's freshness as `refresh` when the current time is at or after its `stale_after`; otherwise `verify` when a maximum age applies (its type's, else the hub default) and the time since its latest verification, or its generation when never verified, exceeds it, or when it has neither; otherwise `read`. Each decision SHALL carry a reason and, when an age or `stale_after` applies, the instant it is or becomes due.

#### Scenario: Read, verify and refresh
- **WHEN** a hub's policy sets one day for metrics and a year by default, and its concepts are a metric verified two days ago, a guide generated last month, a concept past its `stale_after`, a metric with no timestamps, and a concept of an unlisted type in a hub without a default
- **THEN** reads report verify, read, refresh, verify and read respectively, with reasons

### Requirement: Freshness everywhere
Browse entries, read results, context documents and search results SHALL include the same freshness decision.

#### Scenario: Same decision on every path
- **WHEN** a concept due for verification is browsed, read, returned by context and found by search
- **THEN** each result reports the same freshness action and due instant
