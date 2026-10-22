# pull-request-landing Specification

## Purpose
Landing a pull request only when the head that was tested and reviewed is the one merged, the repository's expected checks passed on it, and substantial work carries an approving independent review or an explicit, posted skip; with a tripwire on raw merge commands.

## Requirements

### Requirement: Land only the tested head
`context-kit pr land <n> --sha <sha>` SHALL merge only an open, non-conflicting pull request into the default branch whose head is `<sha>`, read again just before the merge. It SHALL refuse a required merge queue, merge pinned to `<sha>`, fail closed on incomplete evidence, and refuse with a code otherwise, making no merge call unless GitHub itself rejects the pinned merge.

#### Scenario: A routine pull request lands
- **WHEN** an open, routine pull request against the default branch, whose expected checks passed, is landed with its head SHA
- **THEN** it is merged pinned to that SHA, the default branch contains the merge, and its head branch is deleted

#### Scenario: Wrong head, base or file list
- **WHEN** a pull request is landed with a SHA that isn't its head, against a branch other than the default, or with a changed-file list shorter than the pull request's count
- **THEN** the command refuses with `HEAD_MISMATCH`, `NOT_DEFAULT_BASE` or `EVIDENCE_INCOMPLETE` and makes no merge call

#### Scenario: A required merge queue
- **WHEN** the repository requires a merge queue for the default branch
- **THEN** the command refuses with `MERGE_QUEUE_UNSUPPORTED` and makes no merge call

#### Scenario: Movement before the merge
- **WHEN** the head, the base or a check changes between the gates and the refresh just before the merge
- **THEN** the command refuses with `HEAD_MOVED`, `BASE_MOVED` or `CHECKS_CHANGED` and makes no merge call

#### Scenario: GitHub rejects the pinned merge
- **WHEN** the head moves after the refresh and GitHub rejects the pinned merge
- **THEN** the command reports `MERGE_REJECTED`, saying a merge call was made

### Requirement: One repository and its policy
The command SHALL resolve one repository, from `--repo` or the current checkout's `origin`, refusing a conflicting `GH_REPO`, and use it for every GitHub call. It SHALL read the landing policy from the default branch's tip, reporting its provenance, refuse a missing or invalid policy, and use the head's policy only with `--bootstrap-policy` when the default branch has none.

#### Scenario: Conflicting repository
- **WHEN** the command runs with `GH_REPO` naming a repository other than the one it resolved
- **THEN** it refuses with `REPO_AMBIGUOUS` and makes no call to the pull request

#### Scenario: A pull request can't loosen its own gate
- **WHEN** a pull request's head, or the local checkout, holds a policy that expects fewer checks than the default branch's
- **THEN** the default branch's policy decides, and the result names its branch and SHA

#### Scenario: The first policy
- **WHEN** the default branch has no policy and a pull request adding one is landed, without and then with `--bootstrap-policy`
- **THEN** the first refuses with `NO_POLICY`, and the second uses the head's policy and treats the pull request as substantial

### Requirement: The expected checks passed
Each check the policy expects SHALL have a successful latest run on the head SHA from exactly its named producer: app, and for Actions the workflow and event. A skipped run SHALL pass only for an entry that gives a reason. Missing, pending or failed SHALL refuse. With no checks expected, landing SHALL require a posted `--no-checks` reason.

#### Scenario: A check that never ran
- **WHEN** a pull request whose only finished check is an ancillary one is landed, while an expected check never ran
- **THEN** the command refuses with `CHECKS_MISSING`, naming the missing check

#### Scenario: A same-named check from elsewhere
- **WHEN** the only successful run of an expected check's name comes from another workflow, event or app
- **THEN** the command refuses with `CHECKS_MISSING`

#### Scenario: A newer check that can't be traced
- **WHEN** an expected check's latest traceable run succeeded, and a newer check run with the same name can't be traced to its workflow
- **THEN** the command refuses with `EVIDENCE_INCOMPLETE`

#### Scenario: A re-run supersedes a failure
- **WHEN** an expected check failed on its first attempt and succeeded on a re-run
- **THEN** the check passes; and when the order is reversed, the command refuses with `CHECKS_FAILED`

#### Scenario: A newer run outweighs an older one's attempts
- **WHEN** an older workflow run's expected check succeeded on its third attempt, and a newer run of the same workflow failed or is still pending
- **THEN** the command refuses with `CHECKS_FAILED` or `CHECKS_PENDING`

#### Scenario: A skipped check
- **WHEN** an expected check was skipped, once where the policy gives it a skip reason and once where it doesn't
- **THEN** the first passes with its reason in the result, and the second refuses

#### Scenario: Waiting for checks
- **WHEN** an expected check is pending and the command runs with `--wait` and a short `--timeout`
- **THEN** it lands if the check succeeds in time, and otherwise refuses with `CHECKS_PENDING`

#### Scenario: No checks expected
- **WHEN** the policy expects no checks, and the pull request is landed without and then with `--no-checks "<reason>"`
- **THEN** the first refuses with `CHECKS_NONE_EXPECTED`, and the second posts the reason on the pull request before merging

### Requirement: Review before substantial work lands
Work SHALL be substantial unless every changed path matches the policy's routine exemption; no label makes it routine, and workflow files, `.context-kit/`, OpenSpec deltas and the `substantial` label always make it substantial. It SHALL land only with an output review record approving its head SHA, the newest for that SHA deciding, or a `--skip-review` reason posted first.

#### Scenario: Source changes are substantial
- **WHEN** a pull request changing source files, labelled `routine`, is landed without a review record
- **THEN** the command refuses with `REVIEW_MISSING`, naming the files that made it substantial

#### Scenario: A docs-only change is routine
- **WHEN** a pull request changing only paths the policy exempts is landed without a review record
- **THEN** it merges, and the result names the exemption

#### Scenario: Stale, planning and malformed records
- **WHEN** a substantial pull request's only records are an approval for an older SHA, a plan-phase approval, and a record missing a field
- **THEN** the command refuses with `REVIEW_MISSING`, reporting them as stale, not applicable and malformed

#### Scenario: A later record supersedes an approval
- **WHEN** a substantial pull request has an approval for its head followed by a changes-requested record for the same head
- **THEN** the command refuses with `REVIEW_MISSING`; and with a later approval again, it merges citing that record

#### Scenario: An explicit skip
- **WHEN** a substantial pull request without a review record is landed with `--skip-review` and a reason
- **THEN** a comment recording the skip and its reason is posted before the merge, and the result reports the skip

### Requirement: Outcomes after the merge
After a merge the command SHALL confirm it, delete the head branch only when it is this repository's, unmoved and unshared, and report the pull requests that were based on it. It SHALL report failed cleanup as `merged_cleanup_incomplete`, count a lost response as merged only if merged at the requested head, else `MERGE_UNKNOWN`, and never retry a merge.

#### Scenario: A branch that can't be deleted
- **WHEN** a pull request merges and its head branch is shared by another open pull request, is from a fork, or has moved
- **THEN** the branch is kept, the status is `merged_cleanup_incomplete`, and the result gives the reason

#### Scenario: Dependent pull requests
- **WHEN** a pull request merges while another open pull request is based on its head branch
- **THEN** the result reports that pull request's old and new base, and that it needs revalidating

#### Scenario: A lost merge response
- **WHEN** the merge response is lost, and the pull request turns out merged at the requested head, not merged, or merged at another head
- **THEN** the first is reported merged, and the others `MERGE_UNKNOWN` with what was seen, with no second merge call

### Requirement: A tripwire on raw merges
For Claude Code, installing agents SHALL add a PreToolUse hook that denies a shell command with a raw `gh pr merge`, or a `gh api` PUT to a pull request's merge endpoint, in any segment, flag order or ordinary quoting, as the token and segment contract defines (not inside `sh -c` or `eval` strings), pointing to `context-kit pr land`. Other commands SHALL run untouched.

#### Scenario: A raw merge is caught
- **WHEN** an agent in Claude Code runs `gh pr merge 5`, `gh api -X PUT repos/o/r/pulls/5/merge`, or `GH_DEBUG=1 gh api --method=put "/repos/o/r/pulls/5/merge"` chained after `context-kit pr land`
- **THEN** each is denied with Claude Code's deny decision and a message to use `context-kit pr land`

#### Scenario: Other commands run
- **WHEN** an agent runs `gh pr view 5`, `gh api repos/o/r/pulls/5`, a GET of the merge endpoint, or `echo "gh pr merge"`
- **THEN** the hook produces no decision and the command runs

### Requirement: Wait for GitHub to index workflow runs
A check run with an expected Actions check's name and app whose check suite no workflow run on the head yet claims SHALL be untraced, not missing, and SHALL never pass. Without `--wait` it SHALL refuse `CHECKS_UNTRACEABLE`; with `--wait` it SHALL be polled like a pending check until traced or timed out.

#### Scenario: A workflow run indexed late
- **WHEN** an expected check's run succeeded but the head's workflow-runs listing is empty on the first reads and complete later, and the command runs with `--wait`
- **THEN** it keeps polling and lands once the check is traced to its named workflow and event

#### Scenario: An untraced check without waiting
- **WHEN** an expected check's run exists but no workflow run on the head claims its check suite, and the command runs without `--wait`, or with `--wait` until it times out
- **THEN** it refuses with `CHECKS_UNTRACEABLE`, not `CHECKS_MISSING`, and makes no merge call

### Requirement: Squash merges keep slice trailers
When `pr land` squash-merges a pull request whose commits or description carry `OpenSpec-Change` or `OpenSpec-Slice` trailers, the merge SHALL get an explicit message ending with those trailer lines, each once, then the `Co-authored-by` lines GitHub would add. It SHALL write no trailer the pull request doesn't carry, and SHALL refuse malformed trailers with `TRAILERS_INVALID` and slices named for different changes with `TRAILERS_CONFLICT`.

#### Scenario: Slice trailers survive a squash
- **WHEN** a pull request whose commits and description carry `OpenSpec-Change: deliver` and `OpenSpec-Slice: storage`, one commit a `Co-authored-by` line and one another author, is landed with squash
- **THEN** the merge call is pinned to the head SHA and carries a title and a message ending with each trailer once and both co-authors, and `specs status deliver` without `gh`, on a commit with that message, reports `storage` landed

#### Scenario: No trailers are invented
- **WHEN** a pull request without slice trailers is squash-merged, or one with them is rebase-merged
- **THEN** the merge call carries no commit title or message

#### Scenario: Conflicting or malformed trailers
- **WHEN** a pull request's commits or description name slices for different changes or a slice without a change, or carry a trailer value that isn't an id
- **THEN** the command refuses with `TRAILERS_CONFLICT` or `TRAILERS_INVALID`, posts nothing and makes no merge call
