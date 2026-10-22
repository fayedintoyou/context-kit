# Delivering a change

A change's deltas say what should eventually be true. A pull request is one
independently reviewable step towards it. Progress is derived from git, never
recorded by hand.

Use [independent-review](../skills/independent-review/SKILL.md) for proportionate
plan/output review gates before implementation and readiness, then validate the
reviewed current head and merge only within the user's authorization.

```
proposal (target truth) ─accepted→ slices.yaml ─→ PRs, in parallel where independent
   → reconcile ("did we build it?") → archive → canonical specs → garden ("is it well shaped?")
```

1. **Slice.** For a change too large for one PR, write
   `openspec/changes/<change>/slices.yaml` with the `slice-change` skill. Each
   slice names the requirements it implements, its dependencies and optional
   paths. Check it with `specs status <change>`.
2. **Build.** `specs next <change>` returns a packet for every slice that is
   ready. Give a worker one packet: implement this slice, nothing else. Every
   commit for a slice carries these lines (anywhere in the message), and the
   PR description repeats them:

   ```
   OpenSpec-Change: <change>
   OpenSpec-Slice: <slice>
   ```

   `npm test` requires linked tests only for the scenarios of slices that have
   landed or carry these trailers on the current branch, so the first slice can
   land green while later ones are still pending ([testing](testing.md)).
   Once a slice lands, its scenarios are required everywhere, so update every
   open pull request's branch (rebase onto or merge the default branch) before
   landing it. Re-running an old `pull_request` run reuses its old merge ref, so
   push the updated branch instead; the link check names a slice that landed
   after the tree it tests.

3. **Review.** Review each PR against its slice with `reconcile-change` and
   `independent-review`, using `specs slice <change> <slice>` as the brief.
4. **Reconcile.** When `specs status` shows `readyToReconcile`, run
   `reconcile-change` on the whole change. Work outside the change becomes a
   proposal amendment or a separate change, never silent scope.
5. **Archive after merge, then garden.** Don't archive in PRs. The `openspec`
   workflow (`.github/workflows/openspec.yml`) runs on every push to the default
   branch. It archives each change whose tasks are all ticked and whose planned
   slices have all landed (`specs archivable` shows which), runs the tests and
   pushes the archive commit. To keep a change open, leave a task unticked. Then
   run `garden-canonical-specs` to keep canonical truth well organized.

Canonical specs change only by archiving a change. On pull requests, the
workflow's `canonical-guard` check fails when `openspec/specs/` is edited
directly; the `canonical-edit` label allows a deliberate exception.

The archive can fail only after merge: `openspec validate --strict` on a change
checks its deltas, not the canonical specs they produce, so a requirement that
grows past OpenSpec's 500-character limit passes review and then fails the
archive on the default branch. The workflow's `archive-rehearsal` check catches
that on the pull request. `specs archive --rehearse [--store <id>]` archives
every active change, ready or not, in archive order into a scratch copy of
`openspec/`, validates the copy strictly after each change and reports the issues
each one introduces, with the spec and requirement, under its name. Issues the
canonical specs already had are listed as `baseline` and do not fail the check.
The check fails, and the command exits non-zero, only when a change introduces
an issue, such as `notes` requirement `Note export` being over 500 characters.
Nothing in the repository changes.

To fix what it reports, edit the change's delta, never the canonical spec:
shorten the requirement to the one behavior it states, move examples and edge
cases into scenarios, or split it into several requirements. A change that can't
be applied at all, such as MODIFIED of a requirement that doesn't exist, is
reported as that change's issue, and the changes after it are still rehearsed.
Run the command locally before pushing to see the same result.

To use the process in another repository, add a caller workflow pinned to a
Context Kit commit:

```yaml
name: openspec process
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
permissions:
  contents: write
jobs:
  openspec:
    uses: fayedintoyou/context-kit/.github/workflows/openspec.yml@<commit>
    with:
      kit: npx --yes --package=github:fayedintoyou/context-kit#<commit> context-kit
      test: npm test
```

Its jobs run on GitHub's `ubuntu-latest`. A repository with its own runner names it with
`runs-on`, as one label or a JSON list of labels, so a private repository's minutes aren't spent:

```yaml
    with:
      runs-on: '["self-hosted", "my-mac"]'
```

and copy the lifecycle paragraph from this repository's `openspec/config.yaml`
context. The job pushes with the workflow token, which doesn't trigger other
workflows, so the archive commit neither loops nor redeploys. If the default
branch is protected, the job needs a token allowed to push to it.

Merge commits and rebases keep commit trailers. GitHub's default squash message
keeps the PR's commit messages too; if you squash with a custom message, keep
the trailers in the PR description and have `gh` installed so merged PRs still
count as landed.

When a change's slices merge into an integration branch (the plan's `base`) that
later merges to the default branch as one pull request, that branch is the
landing evidence. If the repository squashes and deletes merged branches, that
evidence disappears with the branch, and the archive after merge fails with
`Base branch not found`. Before that last merge, set `base` to the default branch
in `slices.yaml`, and put `OpenSpec-Change: <change>` and every slice's
`OpenSpec-Slice: <slice>` line in the squash message. The default branch then
carries the evidence itself.

Context Kit dogfoods this: `openspec/changes/change-progress/slices.yaml`
planned the change that added it.

## Landing a pull request

Merge with `context-kit pr land <n> --sha <tested-sha>` rather than a raw `gh` merge.
It lands the pull request only when it is open, targets the default branch, isn't
conflicting or behind a required merge queue, and its head is the SHA you tested;
the repository's expected checks all passed on that head; and, for substantial work,
an output review record approves that head, or you pass `--skip-review "<reason>"`,
which is posted on the pull request. It re-reads the head, base and checks just
before merging, merges pinned to the SHA, then deletes the branch only when that's
safe and reports the pull requests that were based on it. The `commands` help topic
has every flag and refusal code.

Each repository owns its gate in `.context-kit/landing.json` on its default branch:
the checks it expects, each named by its exact producer (app, and for Actions the
workflow file and event) with an optional skip reason, and the paths that count as
routine. Everything else is substantial. The pull request that adds the first policy
lands with `--bootstrap-policy`. The toolkit ships the mechanism; which checks matter
and which paths are routine is each repository's decision.

The review record is a comment the reviewer, or the agent relaying their result,
posts on the pull request (the `independent-review` skill gives the block):
`Reviewed-SHA`, `Phase: output`, `Reviewer`, `Outcome`, `Findings` and `Evidence`.
The newest record for the head decides.

**Trust model.** Agents are assumed to act in good faith and to forget under
momentum. `pr land` makes the gated path the easy one, and `agents install` adds a
Claude Code `PreToolUse` hook that denies raw `gh pr merge` and `gh api … PUT
…/pulls/<n>/merge` commands. That tripwire follows a bounded contract: it reads
segments and ordinary quoting, and reads past `env`, `time` and `command` with their
usual options, but not `sh -c`, `eval` or `env -S` strings, aliases or scripts.
None of this stops an agent determined to bypass it, because the merge credentials
stay with the agent. The residual bypasses are:

- disabling the hook, or merging another way: `curl`, a script, another client;
- runtimes without pre-command hooks (Codex today, reported `unsupported`);
- a skip reason the agent writes itself (it is posted publicly on the pull request);
- a review record the agent posts itself: `gh` comments carry the merging user's
  identity, so authorship can't prove independence, and a record is audit evidence;
- the short window between the final re-read of checks, base, labels and review
  records and the merge (the head itself is pinned by GitHub);
- a sub-second window in cleanup: the head branch is re-read immediately before it
  is deleted, but GitHub's REST API has no conditional ref delete, so a push landing
  between that read and the delete would be deleted with the branch.

Closing them needs server-side enforcement: rulesets plus a required review check
from a producer the merging agent can't impersonate. That is out of scope here.

## A change across repositories

A shared store (`specs stores`) holds specs several repositories agree on, such as
a contract between the parties its `openspec/parties.yaml` declares. A store holds
no code, so a store change is planned in the store and built in its parties: each
slice names with `repo` the party it lands in, and its evidence comes from that
party's checkout. The delivery commands take `--store <id>`; run them from the
workspace, whose registry records the party checkouts.

A fictional walk-through: hub `team/shared` declares store `shared`, whose
parties are `site` (`https://github.com/example/site`) and `game`
(`https://github.com/example/game`), with contract `game-embedding: [site, game]`.
The store's change `embed` adds the contract:

```markdown
### Requirement: Guest handshake
The game SHALL accept the page that embeds it as its host.

#### Scenario: Game accepts its host
...

### Requirement: Host frame
The site SHALL open the game in a frame.

#### Scenario: Site opens the game
...
```

Its `slices.yaml` lands one slice in each party. Each party also proposes its own
change in its own repository (`accept-host` in `game`, `embed-game` in `site`)
for the app-internal detail, and the slice's PR implements both, so its paths
include that change:

```yaml
slices:
  - id: game-guest
    repo: game
    implements: [game-embedding / Guest handshake]
    paths: ["src/embed/**", "test/embed/**", "openspec/changes/accept-host/**"]
  - id: site-host
    repo: site
    implements: [game-embedding / Host frame]
    depends_on: [game-guest]
    paths: ["src/embed/**", "test/embed/**", "openspec/changes/embed-game/**"]
```

Its `tasks.md` has a task per slice and a final task, left unticked, that holds the
change open until the finishing step:

```markdown
- [ ] 1.1 game-guest lands in game
- [ ] 1.2 site-host lands in site
- [ ] 2.1 Finish: reconcile, then archive in the store's repository
```

1. **Record the checkouts** once per machine: `repos locate team/shared/game
   ~/src/game` and `repos locate team/shared/site ~/src/site` (or `repos clone`).
   Without one, a party's slices are `unknown`, never `ready` or `landed`.
2. **Build.** `specs status embed --store shared` shows `game-guest` ready and
   `site-host` blocked. `specs next embed --store shared` returns the
   `game-guest` packet naming store `shared`, party `game` with its upstream,
   checkout and party remote, the party's base, and the qualified trailers. The
   worker branches from that remote in the `game` checkout, and every commit and
   the PR description carry:

   ```
   OpenSpec-Change: shared:embed
   OpenSpec-Slice: game-guest
   ```

   The qualifier keeps `game`'s own changes, and other stores', from counting.
   A commit's or PR's `OpenSpec-Slice` lines count for every `OpenSpec-Change` it
   names, and squash merges combine every commit's trailers. So carry **one sliced
   change per pull request**: a party PR may also carry the party's own change only
   when that change has no slice plan. Otherwise deliver the two in separate PRs.
   Tests link the contract's scenarios with the store's id, in any tracked file:

   ```js
   // spec: embedding / Accept a host page
   // spec: shared:game-embedding / Game accepts its host
   test('accepts the embedding page as host', ...);
   ```

   A party's own link checker (one like Context Kit's `npm test` check) must
   ignore links whose capability carries a `<store-id>:` qualifier: they name the
   store's scenarios, which the party's own specs don't have.
3. **Review** the PR in the party's repository, against
   `specs slice embed game-guest --store shared`. Its `review` lists the commits,
   the party's pull requests and the linked tests read from the slice's latest
   commit. After it merges, `game`'s own workflow archives `accept-host`. Fetch the
   checkout (`git -C ~/src/game fetch`): a slice lands only on the party remote's
   fetched base. `specs next` then offers `site-host`, with `game-guest`'s commit
   labeled repository `game` as its dependency, and it goes the same way in
   `site`. A party PR can't tick the store's tasks: tick `1.1` and `1.2` in the
   store's repository as their slices land.
4. **Finish.** No workflow sees a party merge from the store's repository, so
   after the last party slice lands, the store change is finished by hand:

   ```sh
   git -C ~/src/game fetch && git -C ~/src/site fetch
   context-kit specs reconcile embed --store shared
   # tick 2.1 in the store's openspec/changes/embed/tasks.md
   context-kit specs archivable --store shared        # embed: ready
   context-kit specs archive --ready --store shared
   ```

   then commit the result in the store's repository and merge it there.
   Reconcile checks each slice's commits against its paths in its party's
   repository and reads the contract's links from each party at its base, and
   from each in-progress slice's latest commit. `specs archive --ready --store`
   writes only under the store's `openspec/`: `embed` moves to its archive and
   `game-embedding` becomes canonical in the store.

Each change is archived where it lives: `accept-host` and `embed-game` by their
party's own workflow when their PR merges, and the store's `embed` by the
finishing step. `specs archivable --store shared` lists a store change that is
`ready` but not yet archived.
