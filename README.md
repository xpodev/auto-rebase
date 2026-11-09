# auto-rebase-bot

Polls a single GitHub repo and shepherds one PR at a time toward merge: it
picks the highest-priority eligible PR, rebases it onto the base branch,
**tracks** it, and keeps it rebased every time the base branch moves until it
merges. Then it moves on to the next one.

Rules, re-evaluated on every poll tick:

- **Eligibility.** Only approved, non-draft PRs are considered; everything
  else is skipped entirely. PRs with failing CI are excluded until a new
  commit is pushed.
- **Priority** (default; oldest-first within a tier):
  1. auto-merge on **and** CI passing
  2. CI passing
  3. auto-merge on

  PRs matching none of these are not rebased. "CI passing" means all checks
  named in `ciChecks` succeeded (or, if `ciChecks` is not set, the overall
  `statusCheckRollup` is green).
- **Preemption.** If a PR reaches a strictly higher tier than the tracked
  PR, the bot switches to it immediately and rebases it. The CI re-run that
  the bot's own rebase triggers does not demote the tracked PR.
- **Stale timeout.** If the tracked PR hasn't merged within `STALE_TIMEOUT`,
  it is marked stale and the bot moves to the next PR. A stale PR becomes
  eligible again once the author pushes a new commit.
- **Conflicts.** A PR that conflicts gets a comment, is marked conflicted,
  and the bot moves to the next PR in the same tick. It becomes eligible
  again once the author pushes a new commit.
- A tracked PR that merges, closes, loses approval, becomes a draft or
  starts failing CI is dropped and the next PR is picked.

See `docs/superpowers/specs/2026-09-15-auto-rebase-bot-design.md` for the full
design.

## Setup

1. Create a GitHub App on the target repo with permissions: `Pull requests:
   Read & write`, `Contents: Read & write`, `Commit statuses: Read`, `Checks:
   Read` (needed to read GitHub Actions check-run results via
   `statusCheckRollup` — `Commit statuses` alone only covers the older
   classic Status API and won't see Actions check runs). If branch
   protection requires status checks to re-run, no extra permission is
   needed — pushes trigger CI normally.
   **If you change an existing App's permissions, an org owner must approve
   the update on the installation** (Settings → installed GitHub Apps →
   review request) — updating the App definition alone does not apply to
   an already-installed instance.
2. Install the app on the repo and note the installation ID.
3. Set environment variables:

   | Variable                     | Required | Default          |
   |-------------------------------|----------|------------------|
   | `GITHUB_APP_ID`               | yes      | —                |
   | `GITHUB_APP_PRIVATE_KEY`      | yes      | —                |
   | `GITHUB_APP_INSTALLATION_ID`  | yes      | —                |
   | `GITHUB_REPO`                 | yes      | — (`owner/repo`) |
   | `BASE_BRANCH`                 | no       | `main`           |
   | `POLL_INTERVAL_MS`            | no       | `60000`          |
   | `GIT_WORKDIR`                 | no       | `.git-workdir`   |
   | `DB_PATH`                     | no       | `./pr-queue.db`  |
   | `STALE_TIMEOUT`               | no       | disabled (never stale) |
   | `CONFIG`                      | no       | built-in defaults |
   | `CONFIG_PATH`                 | no       | built-in defaults |

   `STALE_TIMEOUT` is how long a tracked PR may stay open before the bot
   gives up on it and moves on, e.g. `30s`, `5m`, `16h`, `40d`, or combined
   like `1h30m` (units: `ms`, `s`, `m`, `h`, `d`).

   `CONFIG` holds a JSON config inline (takes precedence); `CONFIG_PATH`
   points to a JSON file instead. Unknown keys are rejected. Keys:

   ```json
   {
     "ciChecks": ["build", "test"],
     "priorityOrder": [["AUTO_MERGE_ON", "CI_PASSING"], ["CI_PASSING"], ["AUTO_MERGE_ON"]]
   }
   ```

   - `ciChecks`: names of the required CI checks (GitHub Actions job/check-run
     names or classic commit-status contexts). CI counts as passing only when
     all of them succeeded, failing if any failed, and pending while any is
     missing or still running. Other checks are ignored. If omitted, the
     overall `statusCheckRollup` state is used.
   - `priorityOrder`: each inner list is a tier whose rules must all match;
     earlier tiers win, and oldest-first breaks ties within a tier. PRs
     matching no tier are never rebased (an empty tier `[]` matches
     everything). Rules: `AUTO_MERGE_ON`, `PR_APPROVED`, `CI_PASSING`,
     `CI_PENDING`. Unapproved, draft, and failing-CI PRs are always excluded
     before ranking. The default is shown above.

4. `npm install && npm run build && npm start`

## Docker

1. `cp .env.example .env` and fill in the required variables (the private
   key must keep its real line breaks — see the comment in
   `.env.example`).
2. `docker compose up --build`

State (`GIT_WORKDIR`, `DB_PATH`) is persisted in the `auto-rebase-data`
named volume, mounted at `/data`.

## Development

- `npm test` — unit + local-git integration tests (no network required).
- Manual end-to-end verification against a real repo/App installation is a
  separate manual runbook, not part of automated CI (see spec's Testing
  Strategy section).
