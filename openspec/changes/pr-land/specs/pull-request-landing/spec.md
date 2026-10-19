## Purpose

Landing a pull request only when the head that was tested and reviewed is the one merged, the repository's expected checks passed on it, and substantial work carries an approving independent review or an explicit, posted skip; with a tripwire on raw merge commands.

## ADDED Requirements

### Requirement: Land only the tested head
`context-kit pr land <n> --sha <sha>` SHALL merge only an open, non-conflicting pull request into the default branch whose head is `<sha>`, read again just before the merge. It SHALL refuse a required merge queue, merge pinned to `<sha>`, fail closed on incomplete evidence, and refuse with a code otherwise, making no merge call unless GitHub itself rejects the pinned merge.

#### Scenario: A routine pull request lands
- **WHEN** an open, routine pull request against the default branch, whose expected checks passed, is landed with its head SHA
- **THEN** it is merged pinned to that SHA, the default branch contains the merge, its head branch is deleted, and the pull requests that were based on it are reported with their new base

#### Scenario: Refused before merging
- **WHEN** a pull request is landed with a SHA that isn't its head, against a branch other than the default, with an incomplete file list, or its head or base moves before the merge
- **THEN** the command refuses with the matching code and makes no merge call

### Requirement: The expected checks passed
Each check the repository's landing policy expects SHALL have a current, successful run on the head SHA, a skipped one passing only when the policy lists it with a reason. Missing, pending, failed or superseded-only runs SHALL refuse, and a pull request with no landing policy SHALL be refused.

#### Scenario: A check that never ran
- **WHEN** a pull request whose only finished check is an ancillary one is landed, while an expected check never ran
- **THEN** the command refuses, naming the missing check

### Requirement: Review before substantial work lands
Work SHALL be substantial unless every changed path matches the policy's routine exemption; workflow files, OpenSpec deltas and the `substantial` label always make it substantial. Substantial work SHALL land only with an output review record approving its head SHA, the newest record for that SHA deciding, or with `--skip-review "<reason>"` posted on the pull request before the merge.

#### Scenario: Substantial work and its review
- **WHEN** a substantial pull request is landed with no review record, then with an approving record for an older SHA, then with an approval for its head superseded by a changes-requested record, then with a current approval
- **THEN** the first three are refused, the second reporting the record as stale, and the last merges citing the record

#### Scenario: An explicit skip
- **WHEN** a substantial pull request without a review record is landed with `--skip-review` and a reason
- **THEN** a comment recording the skip and its reason is posted before the merge, and the result reports the skip

### Requirement: Outcomes after the merge
After a merge the command SHALL confirm it, delete the head branch only when it is this repository's, unmoved and unshared, report the pull requests that were based on it, and report a merge whose cleanup failed or whose outcome is unknown as such, never retrying a merge on its own.

#### Scenario: Merged but not cleaned up
- **WHEN** a pull request merges and its head branch is shared by another open pull request, or the merge response is lost
- **THEN** the branch is kept with the reason, or the outcome is reconciled from the pull request's state, and the result says so

### Requirement: A tripwire on raw merges
Installing agents SHALL add, for runtimes with pre-command hooks, a hook that refuses raw `gh` merge commands and points to `context-kit pr land`, removed again on uninstall, and SHALL report runtimes without such hooks as unsupported.

#### Scenario: A raw merge is caught
- **WHEN** an agent in Claude Code runs `gh pr merge` or a `gh api` PUT to a pull request's merge endpoint, and another runs `gh pr view`
- **THEN** the first is refused with a message to use `context-kit pr land`, and the second runs
