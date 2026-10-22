## ADDED Requirements

### Requirement: Wait for GitHub to index workflow runs
A check run with an expected Actions check's name and app whose check suite no workflow run on the head yet claims SHALL be untraced, not missing, and SHALL never pass. Without `--wait` it SHALL refuse `CHECKS_UNTRACEABLE`; with `--wait` it SHALL be polled like a pending check until traced or timed out.

#### Scenario: A workflow run indexed late
- **WHEN** an expected check's run succeeded but the head's workflow-runs listing is empty on the first reads and complete later, and the command runs with `--wait`
- **THEN** it keeps polling and lands once the check is traced to its named workflow and event

#### Scenario: An untraced check without waiting
- **WHEN** an expected check's run exists but no workflow run on the head claims its check suite, and the command runs without `--wait`, or with `--wait` until it times out
- **THEN** it refuses with `CHECKS_UNTRACEABLE`, not `CHECKS_MISSING`, and makes no merge call
