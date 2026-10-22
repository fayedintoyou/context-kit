# Proposal

## Why

A Repository concept's `resource` lives in a hub, and hubs are committed, pushed and often
shared. `repos add --path <checkout>` copied the checkout's `origin` URL as written into the
concept (`resource`, description and body), the hub's index and the generated `my-repos` skill,
and echoed it in its result and in `REPOSITORY_EXISTS`. An origin holding a token
(`https://x:TOKEN@github.com/o/r`, `?access_token=...`) became a committed credential in a
shared hub. `repos`, `list_repos` and the routing skill also showed a hand-written `resource`
as written, carrying any secret in it into agent context. Separately, `redact()` took 11 to 19
seconds on 100,000 characters: its scheme pattern backtracked over every long run.

## What Changes

- A Repository's clean upstream is its `resource` without userinfo, query or fragment, keeping
  scheme, host, port and path so it still clones. SSH keeps a plain login name (`git@`), which
  is not a secret; a login with a password goes whole. It has the same identity as the original,
  so matching checkouts is unchanged.
- `repos add` and `add_repo` store only the clean form, given or derived from a checkout, and say
  in the result (`removed`) when something was dropped, without echoing it. Their errors name an
  upstream only by its clean form or identity; `Not a git upstream` no longer echoes the input.
- `validate` reports a Repository whose `resource` is not clean, naming the concept, never the URL.
- `repos`, `list_repos`, the routing skill and clone use the clean form.
- `redact()` is a linear scan with the same results.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-registry`: new requirements "Credential-free resources", "Adding never writes
  credentials" and "Resources are shown clean"; "Add a repository to a hub" stores the clean form.

## Impact

- `lib/repos.mjs` (`cleanUpstream`, `registry`, `addRepository`, `redact`)
- `test/e2e/repos.test.mjs`, `docs/format.md`, `skills/context-kit/references/repositories.md`
- Out of scope: a shared store's `parties.yaml` upstreams, and generic concept reads (`read`,
  `browse`, `search`), which show a hub's files as written; `validate` now flags such a
  `resource` so it can be fixed at the source.
