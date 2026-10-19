## Purpose

Landing a pull request only when the head that was tested and reviewed is the one merged, its checks are green, and substantial work carries an independent review or an explicit, recorded skip.

## ADDED Requirements

### Requirement: Land only the tested head
`context-kit pr land <n> --sha <sha>` SHALL merge pull request `<n>` only if it is open, targets the default branch, isn't conflicting, its head is `<sha>` both before and immediately before the merge, and every check on that head has finished successfully. It SHALL merge pinned to `<sha>` with the repository's allowed method, and otherwise refuse with a reason code, making no merge call.

#### Scenario: A routine pull request lands
- **WHEN** an open pull request against the default branch, with green checks and only routine changes, is landed with its head SHA
- **THEN** it is merged pinned to that SHA, the default branch contains the merge, its head branch is deleted, and pull requests based on that branch are listed

#### Scenario: Refused before merging
- **WHEN** a pull request is landed with a SHA that isn't its head, or with a check failed or still running, or against a branch other than the default, or its head moves just before the merge
- **THEN** the command refuses with the matching reason code and makes no merge call

### Requirement: Review before substantial work lands
A pull request that changes CI, deploy or workflow files, or adds, removes or renames requirements in an OpenSpec change, or carries the `substantial` label, SHALL land only with a review record on it naming its head SHA (`Reviewed-SHA: <sha>`), or with `--skip-review "<reason>"`, which SHALL be posted on the pull request before the merge and reported.

#### Scenario: Substantial work and its review
- **WHEN** a substantial pull request is landed first with no review record, then with a record for an older SHA, then with a record for its head
- **THEN** the first two are refused, the second reporting the record as stale, and the third merges citing the record

#### Scenario: An explicit skip
- **WHEN** a substantial pull request without a review record is landed with `--skip-review` and a reason
- **THEN** a comment recording the skip and its reason is posted before the merge, and the result reports the skip
