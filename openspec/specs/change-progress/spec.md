# change-progress Specification

## Purpose
Deliver an accepted change as independently mergeable slices: plan them in the change, derive which have landed from commit trailers and pull requests, hand out self-contained work packets, and check what was built against the change before archive.

## Requirements

### Requirement: Slice plan
An active change MAY include `slices.yaml` dividing it into slices. Each slice SHALL have an id, the change requirements it implements as `<capability> / <requirement name>`, the slices it depends on, and optional path globs. In a store's change, every slice SHALL name with `repo` the party it lands in. In a repository's change, no slice SHALL. The plan MAY name a base branch and SHALL hold no status.

#### Scenario: Valid plan
- **WHEN** a change has a plan whose slices cover its requirements with acyclic dependencies
- **THEN** `specs status` lists every slice and requirement without error

#### Scenario: Plan across party repositories
- **WHEN** a store change has one slice with `repo: site` and another with `repo: game`
- **THEN** `specs status <change> --store <id>` lists each slice with its party and that party's upstream

### Requirement: Slice plan validation
A plan with a duplicate or invalid slice id, an unknown or cyclic dependency, an implemented requirement absent from the change's deltas, or a path that leaves the repository SHALL fail with `INVALID_CONFIG` naming the file and the problem. So SHALL a store plan whose slice names no `repo` or a party the store does not declare, or a repository plan whose slice names a `repo`.

#### Scenario: Invalid plan
- **WHEN** a plan has a dependency cycle, or implements a requirement the change's deltas do not contain
- **THEN** the operation fails with `INVALID_CONFIG` naming `slices.yaml` and the cycle or requirement

#### Scenario: Unknown party
- **WHEN** a store plan's slice names `repo: mobile` and the store's parties file does not declare `mobile`, or a repository plan's slice names any `repo`
- **THEN** the operation fails with `INVALID_CONFIG` naming `slices.yaml` and the slice

### Requirement: Slice landing
The `specs` addon SHALL provide a read-only `specs status <change>` operation, `change_status` over MCP, that derives each slice's state from its `OpenSpec-Change` and `OpenSpec-Slice` trailer commits: `landed` when one is reachable from the base branch, `in_progress` when one exists only elsewhere, `ready` when every dependency has landed, `unknown` when its evidence cannot be read, else `blocked`.

#### Scenario: Partly delivered change
- **WHEN** one slice's trailer commit is merged into the base branch, a second slice's trailer commit exists only on a feature branch, and a third slice depends on the second
- **THEN** status reports the slices `landed`, `in_progress` and `blocked`, names the feature branch, and counts one of three slices landed

#### Scenario: Status over MCP
- **WHEN** an MCP client calls `change_status` in a workspace with the `specs` addon enabled
- **THEN** it returns the same result as the CLI, and the tool is absent when the addon is disabled

#### Scenario: Slice landed in another repository
- **WHEN** a `game` slice of store `shared` change `embed` has a commit with `OpenSpec-Change: shared:embed` on the `game` checkout's default branch
- **THEN** the slice is `landed` with that commit, its evidence names repository `game` and the checkout, and a slice depending on it is `ready`

#### Scenario: Same change name elsewhere
- **WHEN** the `game` checkout's default branch has commits with `OpenSpec-Change: embed` and `OpenSpec-Change: other:embed` for the same slice id, and none with `shared:embed`
- **THEN** the `shared` store's slice is not `landed`, and those commits are not reported as its evidence or as stray trailers

### Requirement: Requirement progress
Status SHALL report each requirement in the change's deltas as `landed` when all its covering slices have landed, `partial` when some have, `in_progress` when none has but one is in progress, `unstarted`, or `unplanned` when no slice covers it. Change totals SHALL be derived from these states and never stored.

#### Scenario: Requirement covered by two slices
- **WHEN** a requirement is implemented by two slices and only one has landed
- **THEN** the requirement is `partial` and the change is not ready to reconcile

#### Scenario: No plan
- **WHEN** an active change has no `slices.yaml`
- **THEN** status reports the plan `absent` and every requirement `unplanned`

### Requirement: Pull request enrichment
When the GitHub CLI is available, status SHALL name the pull requests that carry a slice's trailers and SHALL treat an open one as `in_progress` and a merged one as `landed`. For a party slice, pull requests SHALL come from the party's repository, and a merged one SHALL count as `landed` only when it merged into that party's base branch. When the GitHub CLI is unavailable or fails, pull requests SHALL be reported `not_collected` with the reason, and git evidence alone SHALL decide each state.

#### Scenario: Open pull request
- **WHEN** `gh` reports an open pull request whose description carries a slice's trailers and no local branch has its commits
- **THEN** the slice is `in_progress` and names the pull request

#### Scenario: GitHub CLI missing
- **WHEN** `gh` is not on the path
- **THEN** pull requests are `not_collected` and landed slices are still reported from git

#### Scenario: Party pull request merged elsewhere
- **WHEN** `gh` in the `game` checkout reports a merged pull request carrying a `game` slice's qualified trailers, merged into a branch other than the party's base
- **THEN** the slice is not `landed` from that pull request, and the pull request is named in its evidence

### Requirement: Next slices
The system SHALL provide `specs next <change>`, `next_slices` over MCP, returning a packet for every `ready` slice, and `specs slice <change> <slice>`, `read_slice` over MCP, returning the packet for any slice. Both SHALL accept a store. Neither SHALL write anything.

#### Scenario: Parallel ready slices
- **WHEN** two slices depend only on a landed slice and neither has trailer commits
- **THEN** `specs next` returns packets for both, each with its requirements, the landed dependency's commit and its trailers

#### Scenario: Nothing ready
- **WHEN** every unlanded slice is in progress or blocked
- **THEN** `specs next` returns no packets and says why

### Requirement: Slice packet
A packet SHALL contain the change, the slice, the base branch and commit, each implemented requirement's delta text and scenarios with the canonical text it modifies, the dependencies with their landing commits, the declared paths and the trailers to use, and, once started, the commits, branches or pull requests to review. A party slice's packet SHALL also name the store, party, upstream and checkout path or `null`, use the party's base, and name each dependency's repository.

#### Scenario: Packet for a modified requirement
- **WHEN** a slice implements a requirement the change modifies
- **THEN** its packet contains both the delta text and the canonical text it replaces

#### Scenario: Packet for a party slice
- **WHEN** a caller runs `specs next <change> --store shared` and calls `read_slice` with that store, for a ready `site` slice that depends on a landed `game` slice
- **THEN** both return a packet naming store `shared`, party `site`, its upstream and checkout, the `site` default branch and commit as base, the dependency's commit labeled repository `game`, and `OpenSpec-Change: shared:<change>`

### Requirement: Reconcile report
The system SHALL provide a read-only `specs reconcile <change>`, `reconcile_change` over MCP, that reports, with the change's status:
- per slice, files its trailer commits changed outside its declared paths, or `unchecked` when it declares none
- files changed by more than one slice
- trailer commits naming an unknown slice of the change
- requirements no slice implements
- scenarios of the change that no test links, or `not_collected` when the repository has no test links

#### Scenario: Out-of-scope file
- **WHEN** a landed slice declares `src/search/**` and its trailer commit also changes `src/ingest/retry.mjs`
- **THEN** the report lists `src/ingest/retry.mjs` as out of scope for that slice

#### Scenario: Stray trailer
- **WHEN** a commit carries this change's trailer with a slice id the plan does not contain
- **THEN** the report lists the commit and the unknown slice id

#### Scenario: Untested change scenario
- **WHEN** every requirement has landed but one of the change's scenarios has no linked test
- **THEN** the report lists that scenario as untested

### Requirement: Delivery skills
The toolkit SHALL bundle `slice-change` and `reconcile-change` skills in the `specs` addon. `slice-change` SHALL write only a slice plan for an accepted change, made of independently mergeable slices, and validate it with `specs status`.

#### Scenario: Specs addon lists the delivery skills
- **WHEN** a caller lists addons in a workspace with the `specs` addon enabled
- **THEN** the `specs` entry lists `slice-change` and `reconcile-change` with the audit and garden skills

### Requirement: Reconcile without absorbing scope
`reconcile-change` SHALL judge an implementation against its change from the reconcile report and evidence, resolve divergence by recommending a proposal amendment or a separate change rather than absorbing scope, and review a single slice's pull request through `independent-review` with the slice packet as the brief.

#### Scenario: Divergence is surfaced, not absorbed
- **WHEN** an agent reconciles a change whose landed slice added behavior outside the change's requirements
- **THEN** it reports the divergence with evidence and recommends amending the proposal or a separate change, and edits neither the deltas nor canonical specs

### Requirement: Party remote and base
A party's evidence SHALL come from the checkout remote whose URL matches the party upstream, not from `origin` by assumption. Its base branch is the plan's base, else that remote's default branch. Its base commit is that remote's fetched branch tip, never a local branch; without one, the party's slices are `unknown` with reason `remote_not_fetched`. Landing, packets and test links SHALL all use that commit, and pull requests SHALL be read from the party upstream by name.

#### Scenario: Fork checkout
- **WHEN** a `game` checkout's `origin` is a fork with default branch `dev` and a trailer commit on it, its `upstream` remote is the party with default branch `main`, and the GitHub CLI's default repository is the fork
- **THEN** the slice is judged against `upstream/main`, the fork's commit and pull requests do not land it, and the GitHub CLI is asked about the party upstream

#### Scenario: Party remote not fetched
- **WHEN** a `game` slice's trailer commit is only on the checkout's local `main`, and the party remote has just been added and not fetched
- **THEN** the slice is `unknown` with reason `remote_not_fetched` and a `git fetch` remedy, its dependents are `blocked`, and after fetching it is `in_progress`

#### Scenario: Local base behind its remote
- **WHEN** a slice's trailer commit and a linked test are on the party remote's `main`, and the checkout's local `main` is older
- **THEN** the slice is `landed`, the packet's base commit is the remote's tip, and reconcile finds the linked test

### Requirement: Missing party evidence
When the workspace records no checkout for a party's upstream, that party's slices SHALL be `unknown` with reason `checkout_missing` and the remedies `repos locate` and `repos clone`. Slices depending on one SHALL be `blocked`, and a requirement any of them covers SHALL NOT be `landed`.

#### Scenario: No checkout for a party
- **WHEN** a store change has a `game` slice and the workspace records no checkout for the `game` upstream
- **THEN** status reports the slice `unknown` with reason `checkout_missing` and both remedies, its dependents are `blocked`, and `specs next` returns no packet for it

### Requirement: Delivery from a store
`specs status`, `next`, `slice` and `reconcile` SHALL accept `--store <id>`, and `change_status`, `next_slices`, `read_slice` and `reconcile_change` SHALL accept `store`, reading the change from that store under the same declared-or-referenced rule as spec reads. Party checkouts SHALL come from the workspace's registry. A store change's trailer value SHALL be `<store-id>:<change>`, and a party slice SHALL be judged only in its party's repository against its party base.

#### Scenario: Store change over CLI and MCP
- **WHEN** a hub declares store `shared`, and a caller runs `specs status embed --store shared` and calls `change_status` with that change and store
- **THEN** both return the same result labeled with the store as source, and the same call with an undeclared store fails with `UNKNOWN_STORE`

### Requirement: Reconcile across parties
For party slices, reconcile SHALL check each slice's trailer commits against its paths within its party's repository, and SHALL report files shared by slices of the same repository. Every changed file SHALL be labeled with its repository. Test links SHALL be read from every party a slice names, and untested scenarios are `not_collected` only when no party's links could be read.

#### Scenario: Out-of-scope file in a party repository
- **WHEN** a landed `site` slice declares `src/embed/**` and its trailer commit in the `site` checkout also changes `src/nav.ts`
- **THEN** `specs reconcile <change> --store <id>` lists `src/nav.ts` as out of scope for that slice, labeled with repository `site`

### Requirement: Contract test links
A party repository SHALL link a test to a store scenario with `// spec: <store-id>:<capability> / <scenario>` in any file git tracks. Such links SHALL count only for that store, from the party's base commit for landed slices and from a slice's latest trailer commit while it is in progress. An in-progress slice with no local trailer commit reports its links `not_collected` with reason `no_local_commit`. Results SHALL name the repository and commit read.

#### Scenario: Party tests are found
- **WHEN** the `game` default branch has a tracked file containing `// spec: shared:game-embedding / Game accepts its host`, and the `site` slice's latest commit, not yet merged, links `shared:game-embedding / Site opens the game`
- **THEN** reconcile reports neither scenario untested, naming each link's repository, file, line and the commit read, and the in-progress `site` slice's packet lists its link

#### Scenario: Pull request with no local commit
- **WHEN** a `site` slice is `in_progress` only because the GitHub CLI reports an open pull request, and the `site` checkout has none of its commits
- **THEN** `specs slice --store` and `read_slice` report the slice's links `not_collected` with reason `no_local_commit`, reconcile still reads links from the party base, and the slice stays `in_progress`

#### Scenario: Unqualified or other-store links
- **WHEN** a party file links `game-embedding / Game accepts its host` without a qualifier, or with `other:` as the qualifier
- **THEN** the link does not count for store `shared`, and the scenario is reported untested
