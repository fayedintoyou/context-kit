## ADDED Requirements

### Requirement: Credential-free resources
A Repository's clean upstream SHALL be its `resource` without userinfo, query or fragment, keeping scheme, host, port and path; an SSH upstream keeps a login name without a password, such as `git@`. `validate` SHALL report a Repository whose `resource` is not clean, naming the concept and never echoing the resource.

#### Scenario: Resource carrying credentials
- **WHEN** Repository concepts have resources with a password, a token as the user, an `access_token` query or a fragment
- **THEN** `validate` fails naming each concept, and no secret appears in its output

#### Scenario: SSH login name kept
- **WHEN** a Repository concept's `resource` is `git@github.com:acme/billing.git`
- **THEN** `validate` passes and `repos` shows that resource unchanged

### Requirement: Adding never writes credentials
`repos add` and `add_repo` SHALL store only the upstream's clean form, whether given or taken from a checkout's remote, in the concept, the hub's index and every generated file, and when anything was removed SHALL say so in the result without echoing it. Their errors SHALL name an upstream only by its clean form or identity.

#### Scenario: Checkout remote with a token
- **WHEN** a caller adds a repository with `--path` to a checkout whose `origin` is `https://faye:<token>@github.com/acme/billing.git?access_token=<token>`
- **THEN** the concept's `resource` is `https://github.com/acme/billing.git`, the result says credentials were removed, and no form of the token is in the hub, its index, the workspace state, stdout or stderr

#### Scenario: Agent adds an upstream with a token
- **WHEN** an MCP client calls `add_repo` with an upstream holding a token as its user and in its query
- **THEN** the concept stores the clean form, and neither the hub nor the tool result holds the token

#### Scenario: Refusals never echo the upstream
- **WHEN** a caller adds an upstream with a token that a hub already registers, or one that is not a git upstream
- **THEN** the command fails naming the existing repository by the clean form, or saying it is not an upstream, without the token

### Requirement: Resources are shown clean
`repos`, `list_repos` and the generated routing skill SHALL show each Repository's clean upstream, never its `resource` as written. Free text redacted before output SHALL be redacted in time linear in its length.

#### Scenario: Hand-written resource with a token
- **WHEN** a Repository concept's `resource` holds a token in its userinfo and query, and a caller runs `repos`, calls `list_repos` and syncs the routing skill
- **THEN** each shows the clean upstream, and no form of the token is in their output or the generated skill

#### Scenario: Long input redacted quickly
- **WHEN** a `repos setup --ask` answer is a path of 200,000 characters with no URL in it
- **THEN** setup reports it as not a checkout within a few seconds

## MODIFIED Requirements

### Requirement: Add a repository to a hub
`repos add <hub> [<upstream>]` SHALL write a `type: Repository` concept into the named hub, personal or shared, with the upstream's clean form as `resource`, the given title, aliases and description, `status: draft` and a `generated` actor and time, and SHALL list it in the hub's index. With `--path` it SHALL take the upstream from that checkout's remote when none is given and record the checkout.

#### Scenario: Add by upstream
- **WHEN** a caller adds `https://github.com/me/room` to a hub with a title and two aliases
- **THEN** the hub gains a draft Repository concept with those fields, the hub's index links it, `validate` passes, and `repos` lists it as missing

#### Scenario: Add from a checkout
- **WHEN** a caller adds a repository to a team hub with `--path` pointing at a checkout whose `origin` is the upstream, giving no upstream
- **THEN** the concept's `resource` is that remote's clean form, the checkout is recorded for this machine only, and an installed routing skill names the repository

#### Scenario: Already registered
- **WHEN** a caller adds an upstream that a hub already registers, or an alias another repository uses
- **THEN** the command fails naming the existing repository or alias and writes nothing
