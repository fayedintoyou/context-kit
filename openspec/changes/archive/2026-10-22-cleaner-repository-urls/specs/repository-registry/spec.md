## MODIFIED Requirements

### Requirement: Credential-free resources
A Repository's clean upstream SHALL be its `resource` without userinfo, query or fragment, keeping scheme, host, port and path; an SSH upstream keeps only a well-known login without a password (`git`, or a short lowercase name with few digits), and an scp-like one stays scp-like. `validate` SHALL report a Repository whose `resource` is not clean, naming the concept and its clean form, never echoing the resource.

#### Scenario: Resource carrying credentials
- **WHEN** Repository concepts have resources with a password, a token as the user, an `access_token` query or a fragment
- **THEN** `validate` fails naming each concept, and no secret appears in its output

#### Scenario: SSH login name kept
- **WHEN** a Repository concept's `resource` is `git@github.com:acme/billing.git`
- **THEN** `validate` passes and `repos` shows that resource unchanged

#### Scenario: Token-like SSH login dropped
- **WHEN** a caller adds `abcdefghijKLMNOPQRST@gitlab.com:me/garden.git`, an ssh:// URL with that login, and scp-like upstreams with logins `faye` and `git`
- **THEN** the first two are stored without the login and reported as `removed`, the others are stored unchanged, and the token is in no hub file or output

#### Scenario: scp-like path kept
- **WHEN** an scp-like upstream whose login was dropped, and one that kept `faye@`, are cloned
- **THEN** git asks ssh for the same relative path on the same host as the original, as `host` and `faye@host`

#### Scenario: Plain username suggests the clean form
- **WHEN** a Repository's `resource` is `https://faye@bitbucket.org/faye-team/bucket.git`
- **THEN** `validate` fails naming the concept and saying to use `https://bitbucket.org/faye-team/bucket.git`
