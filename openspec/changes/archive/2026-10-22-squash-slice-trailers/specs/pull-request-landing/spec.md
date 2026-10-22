## ADDED Requirements

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
