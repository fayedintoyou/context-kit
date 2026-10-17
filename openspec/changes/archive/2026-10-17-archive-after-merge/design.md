# Design

## Context

OpenSpec reports each active change's ticked and total tasks
(`openspec list --json`, status `complete` when all are ticked) and archives
non-interactively (`openspec archive <name> --yes --json`). Archiving merges the
deltas into `openspec/specs/`, validates them, and moves the change to
`archive/<date>-<name>`. `change-progress` derives whether every slice of a
planned change has landed on the base branch.

Context Kit pushes through PRs that agents merge with `gh api`; `room` pushes
straight to `main`. Neither protects `main` (room is private on a free plan).

## Goals / Non-Goals

**Goals:**
- A finished change is archived within one CI run of its last piece reaching
  `main`, without anyone remembering to do it.
- The archive commit is tested before it is pushed.
- Canonical specs change only through archived changes, and PRs that edit them
  directly are caught.

**Non-Goals:**
- Judging whether a change was built correctly. That's `reconcile-change`,
  during review. Readiness here is deterministic: tasks and slices.
- Archiving changes in shared stores. Stores have no code or CI of their own
  here.
- Opening a PR for the archive. A PR opened with the job's token doesn't trigger
  CI, so it would be untested anyway. The job runs the tests itself and pushes.

## Decisions

1. **Ready means tasks complete and slices landed.** OpenSpec's task count is
   the primary signal, because every change has `tasks.md` and agents already
   tick it. A slice plan adds a second gate: tasks for a later slice can be
   ticked on a branch, but the change isn't done until every slice has landed
   on the base. A change with zero tasks is never ready (`no_tasks`), since
   nothing says it's finished. Leaving one task unticked is the hold-open
   mechanism; there's no separate flag to invent and forget.

2. **`specs archive --ready` is CLI-only and never commits.** Archiving writes
   files, so it isn't offered over MCP, matching the other CLI-only writes. It
   checks readiness, archives each ready change in name order through the
   adapter, then runs strict validation of the canonical specs. If an archive
   fails partway, it stops and reports what was archived and the error. The
   workflow then fails without pushing, because the job's checkout is thrown
   away. `--ready` is required, so a bare `specs archive` can't be mistaken for
   "archive everything".

3. **Reusable workflow, thin.**

   ```yaml
   on:
     workflow_call:
       inputs:
         kit:   { type: string, default: 'npx --yes --package=github:fayedintoyou/context-kit context-kit' }
         setup: { type: string, default: '' }        # e.g. npx playwright install --with-deps chromium
         test:  { type: string, default: 'npm test' }
   ```

   - **`archive`** runs on `push` to the default branch, with
     `concurrency: openspec-archive` and `permissions: contents: write`.
     1. Check out with `fetch-depth: 0`, because slice status needs history.
     2. Set up Node and run `npm ci` when a lockfile exists, then `setup`.
     3. Run `$kit --root . specs archive --ready > archive.json`.
     4. If nothing was archived, stop.
     5. Run `test`, commit `openspec/` with the message
        `Archive <names> after merge`, and push.
     6. If the push races another push, rebase once and retry.
   - **`canonical-guard`** runs on `pull_request`. It diffs
     `origin/<base>...HEAD -- openspec/specs` and fails, naming the files,
     unless the PR has the `canonical-edit` label.

   Callers pin `kit` to a commit (`...context-kit#<sha>`). Context Kit's own
   caller uses `node bin/hub.mjs` from the checkout.

4. **Process lives in `openspec/config.yaml` context.** OpenSpec injects that
   text into every artifact and workflow skill, so propose, apply and archive
   agents in any tool see it. `docs/delivery.md` explains it for people.

5. **Existing finished changes archive on the first run.** Context Kit's
   `repo-registry` and `spec-garden`, and room's `richer-room-and-phone-view`,
   are complete. The first push after installing archives them. That doubles as
   the end-to-end check of the workflow.

## Risks / Trade-offs

- **Direct pushes from CI.** This is acceptable without branch protection, and
  the job tests before pushing. If `main` is protected later, the job needs a
  token or app allowed to bypass, or it must switch to opening a PR. Document
  that.
- **Ticked-but-wrong changes archive anyway.** The workflow trusts ticked tasks.
  Review and `reconcile-change` happen before merge. A bad archive is reverted
  like any commit, and its deltas stay in the archive folder.
- **Archive conflicts.** A delta can modify a requirement that changed on `main`
  since the change was proposed. OpenSpec then fails validation, the job fails,
  and someone fixes the delta. That's better than silently merging.
- **Hand edits already sitting in room's working copy.** This change doesn't
  touch them. Once the guard is installed they need either a change or the
  `canonical-edit` label.
