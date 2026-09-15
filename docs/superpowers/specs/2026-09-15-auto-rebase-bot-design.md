# Auto-Rebase Bot — Design Spec

Date: 2026-09-15
Status: Approved

## Problem

Open PRs against a shared base branch (e.g. `main`) go stale every time another
PR merges. Rebasing all of them immediately on every merge wastes CI minutes —
most of those rebases will be redone again before the PR is actually mergeable.
Instead, PRs should be rebased one at a time, in priority order, only when it's
actually their turn — i.e. only the PR that's about to be looked at / merged
next gets kept current.

## Goals

- When a PR merges into the base branch, rebase exactly one other open PR: the
  highest-priority eligible one.
- Priority: PRs with GitHub auto-merge enabled first, then by creation date
  (oldest first).
- Never rebase draft PRs.
- Minimize CI triggers: only ever one rebase (one force-push) per merge event,
  not one per queued PR.
- If a rebase conflicts, don't block the rest of the queue — skip that PR,
  notify its author via a PR comment, and try the next eligible PR instead.

## Non-goals

- Multi-repo / multi-org support (single repo for now).
- Handling direct pushes to the base branch that don't go through a PR merge
  (out of scope — only PR merges trigger rebases).
- A UI/dashboard. Operational visibility is via PR comments + logs.

## Architecture

Single Node.js/TypeScript service, polling GitHub on an interval (no webhook
receiver, no external infra beyond the one process + a SQLite file).

```
┌─────────────────────────────────────────────────────────────┐
│                        Orchestrator                          │
│   (poll loop: tick → Reconciler → Scheduler → Rebase Worker) │
└───────┬─────────────────────┬───────────────────┬────────────┘
        │                     │                   │
        ▼                     ▼                   ▼
┌───────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ GitHub Client  │   │      Store        │   │  Rebase Worker  │
│ (Octokit, App  │   │ (SQLite: pr_queue │   │ (git rebase +   │
│  install token)│   │  + repo_state)    │   │  force-push)    │
└───────────────┘   └──────────────────┘   └─────────────────┘
```

### Components

- **GitHub Client** — wraps `@octokit/rest` + `@octokit/auth-app`. Mints/caches
  installation access tokens. Exposes: `listOpenPRs()`, `getBaseBranchHeadSha()`,
  `commentOnPR(number, body)`.
- **Store (SQLite via `better-sqlite3`)** — see Data Model below.
- **Reconciler** — each poll tick, fetches live open PRs and syncs the
  `pr_queue` table: upserts rows for open PRs (refreshing `head_sha`,
  `is_draft`, `auto_merge_enabled`), deletes rows for PRs no longer open, and
  clears `conflicted` status on any row whose `head_sha` changed since last
  seen (a new push means the author may have fixed things — give it another
  shot).
- **Scheduler** — after reconciling, compares live base-branch HEAD SHA to
  `repo_state.last_processed_base_sha`. If different, a merge happened. Sorts
  `pr_queue` rows with `status = 'queued'` and `is_draft = 0` by priority
  (`auto_merge_enabled DESC, created_at ASC`) and hands the top one to the
  Rebase Worker. On conflict, tries the next row in that same sorted list
  (same triggering base SHA) until one succeeds or the list is exhausted.
- **Rebase Worker** — for a given PR row: fetches the base branch and the PR's
  head ref into a local working clone (cached on disk, one clone reused across
  runs), performs `git rebase <base>`, and on success pushes with
  `git push --force-with-lease` (protects against clobbering a commit someone
  pushed to the PR branch after the bot last read it). On conflict, aborts the
  rebase and reports failure to the Scheduler.
- **Orchestrator** — the poll loop itself: on each tick, calls Reconciler, then
  Scheduler; only after a rebase attempt succeeds *or* the eligible queue is
  exhausted does it persist the new `last_processed_base_sha`.

### Data model (SQLite)

```sql
CREATE TABLE pr_queue (
  number              INTEGER PRIMARY KEY,
  head_ref            TEXT NOT NULL,       -- branch name, for pushing back
  head_sha            TEXT NOT NULL,
  base_ref            TEXT NOT NULL,
  is_draft            INTEGER NOT NULL,    -- 0/1
  auto_merge_enabled  INTEGER NOT NULL,    -- 0/1
  created_at          TEXT NOT NULL,       -- ISO 8601, PR creation time
  status              TEXT NOT NULL,       -- 'queued' | 'rebasing' | 'conflicted'
  updated_at          TEXT NOT NULL
);

CREATE TABLE repo_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  base_branch              TEXT NOT NULL,
  last_processed_base_sha  TEXT
);
```

Single-row `repo_state` (id always 1) since this is one repo/one base branch.

### Config (env vars)

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_REPO` (`owner/repo`)
- `BASE_BRANCH` (default `main`)
- `POLL_INTERVAL_MS` (default `60000`)
- `GIT_WORKDIR` (path for the cached local clone)

## State machine (per PR row)

- `queued` — eligible, waiting for its turn.
- `rebasing` — transient; a rebase attempt is in flight for this PR.
- `conflicted` — last rebase attempt hit a merge conflict; excluded from
  scheduling until a new push changes `head_sha` (Reconciler resets it to
  `queued` automatically when that happens).

Rows are deleted when the PR is no longer open (merged or closed) or becomes
a draft (re-added if it's later marked ready for review).

Crash recovery: on startup, any row left in `rebasing` (from a process crash
mid-attempt) is reset to `queued` — safe because `--force-with-lease` means an
interrupted push either fully succeeded or didn't happen at all, never a
partial/corrupt state.

## Error handling

- **GitHub API errors** (rate limit, 5xx, network): log and skip the tick;
  retried naturally on the next poll interval. No special backoff needed given
  a 60s+ poll interval already provides spacing.
- **Git operation failures unrelated to conflicts** (network failure during
  fetch/push, auth token expiry): log, leave the row's status unchanged (do
  *not* mark `conflicted` — that's reserved for actual merge conflicts), retry
  on the next triggering event. After 3 consecutive failures for the same PR,
  post a warning comment so it doesn't fail silently forever.
- **Merge conflict during rebase**: `git rebase --abort`, mark row
  `conflicted`, post a PR comment explaining the branch is out of date and
  has conflicts with the base branch that need manual resolution, then the
  Scheduler moves to the next eligible PR for the same triggering event.
- **`--force-with-lease` rejection** (someone pushed to the PR branch after
  the bot last read its `head_sha`): treat as transient, not a conflict — abort
  cleanly, leave status as `queued`; the next Reconciler pass will pick up the
  new `head_sha` and it'll be retried on the next merge event.

## Testing strategy

- **Unit tests**: priority-sort function, Reconciler diff logic (mocked
  Octokit responses → expected `pr_queue` upserts/deletes), state-machine
  transition functions — pure functions, no real git or GitHub calls.
- **Integration tests**: Rebase Worker exercised against local temp git repos
  (a base branch + PR branch constructed with `git` directly) covering both
  the clean-rebase path and the conflict path — no GitHub dependency.
- **End-to-end**: a manual runbook against a disposable test repo + real
  GitHub App installation; not part of automated CI, documented separately.
