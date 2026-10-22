# Proposal

## Why

The output review of `credential-free-repositories` found three low-severity gaps. An SSH login
that looks like a token but has no known prefix (an old 20-character GitLab token) was kept. When
an scp-like login was dropped, `host:repos/r.git` became `ssh://host/repos/r.git`, which turns a
path relative to the login's home into an absolute one. And a plain username in an HTTPS URL
(as Bitbucket and Azure copy it) failed `validate` with only a generic credentials message.

## What Changes

- SSH keeps only a well-known login: `git`, or a lowercase name of at most 15 characters with at
  most three digits. Any other login is dropped and reported as `removed`.
- An scp-like upstream stays scp-like: dropping its login leaves `host:path`, which is now an
  upstream when the host holds a dot or is `[IPv6]`.
- `validate`'s message for an unclean `resource` says `use <clean form>`, which holds no secret.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-registry`: "Credential-free resources" narrows the kept SSH login, keeps scp-like
  form and names the clean form in `validate`.

## Impact

- `lib/repos.mjs` (`normalizeUpstream`, `cleanUpstream`, `registry`)
- `test/e2e/repos.test.mjs`, `docs/format.md`, `skills/context-kit/references/repositories.md`
