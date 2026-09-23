# auto-rebase-bot

Polls a single GitHub repo and, each time a PR merges into the base branch,
rebases exactly one other open PR — the highest-priority eligible one — onto
the new base. PRs with failing CI (via the GraphQL `statusCheckRollup`,
covering both classic commit statuses and Actions check-runs) are excluded
from the queue entirely until the author pushes a new commit; PRs with
passing CI are prioritized ahead of pending/unknown CI. Within each CI
bucket, priority tiers are oldest-first: (1) auto-merge enabled and approved,
(2) auto-merge enabled only, (3) approved only, (4) neither. Draft PRs are
never touched. Conflicts are skipped (with a PR comment) rather than
blocking the rest of the queue.

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
