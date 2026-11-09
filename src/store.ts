import Database from 'better-sqlite3';
import type { CiStatus, PRRecord, PRRow, PRStatus, Tracking } from './types';

export interface Store {
  upsertPR(pr: PRRecord): void;
  deleteMissing(openNumbers: number[]): void;
  setStatus(number: number, status: PRStatus): void;
  // Rebase candidates: queued, approved, non-draft, CI not failing — oldest first, unranked.
  listQueued(): PRRow[];
  resetStuckRebasing(): void;
  getTracking(): Tracking | null;
  setTracking(tracking: Tracking): void;
  clearTracking(): void;
  close(): void;
}

interface PRRowSql {
  number: number;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  is_draft: number;
  auto_merge_enabled: number;
  approved: number;
  ci_status: CiStatus;
  created_at: string;
  status: PRStatus;
  updated_at: string;
}

function toPRRow(row: PRRowSql): PRRow {
  return {
    number: row.number,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    isDraft: row.is_draft === 1,
    autoMergeEnabled: row.auto_merge_enabled === 1,
    approved: row.approved === 1,
    ciStatus: row.ci_status,
    createdAt: row.created_at,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function createStore(dbPath: string, baseBranch: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_queue (
      number              INTEGER PRIMARY KEY,
      head_ref            TEXT NOT NULL,
      head_sha            TEXT NOT NULL,
      base_ref            TEXT NOT NULL,
      is_draft            INTEGER NOT NULL,
      auto_merge_enabled  INTEGER NOT NULL,
      approved            INTEGER NOT NULL DEFAULT 0,
      ci_status           TEXT NOT NULL DEFAULT 'pending',
      created_at          TEXT NOT NULL,
      status              TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      base_branch              TEXT NOT NULL,
      last_processed_base_sha  TEXT,
      tracked_pr               INTEGER,
      tracked_since            TEXT,
      tracked_base_sha         TEXT,
      tracked_ci_passed        INTEGER NOT NULL DEFAULT 0
    );
  `);

  const existingColumns = db.prepare(`PRAGMA table_info(pr_queue)`).all() as Array<{ name: string }>;
  if (!existingColumns.some((column) => column.name === 'approved')) {
    db.exec(`ALTER TABLE pr_queue ADD COLUMN approved INTEGER NOT NULL DEFAULT 0`);
  }
  if (!existingColumns.some((column) => column.name === 'ci_status')) {
    db.exec(`ALTER TABLE pr_queue ADD COLUMN ci_status TEXT NOT NULL DEFAULT 'pending'`);
  }

  const repoStateColumns = db.prepare(`PRAGMA table_info(repo_state)`).all() as Array<{ name: string }>;
  for (const [name, type] of [
    ['tracked_pr', 'INTEGER'],
    ['tracked_since', 'TEXT'],
    ['tracked_base_sha', 'TEXT'],
    ['tracked_ci_passed', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!repoStateColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE repo_state ADD COLUMN ${name} ${type}`);
    }
  }

  db.prepare(
    `INSERT OR IGNORE INTO repo_state (id, base_branch, last_processed_base_sha) VALUES (1, ?, NULL)`
  ).run(baseBranch);

  const getExistingStatusAndSha = db.prepare(
    `SELECT status, head_sha FROM pr_queue WHERE number = ?`
  );
  const insertOrReplace = db.prepare(`
    INSERT INTO pr_queue (number, head_ref, head_sha, base_ref, is_draft, auto_merge_enabled, approved, ci_status, created_at, status, updated_at)
    VALUES (@number, @headRef, @headSha, @baseRef, @isDraft, @autoMergeEnabled, @approved, @ciStatus, @createdAt, @status, @updatedAt)
    ON CONFLICT(number) DO UPDATE SET
      head_ref = excluded.head_ref,
      head_sha = excluded.head_sha,
      base_ref = excluded.base_ref,
      is_draft = excluded.is_draft,
      auto_merge_enabled = excluded.auto_merge_enabled,
      approved = excluded.approved,
      ci_status = excluded.ci_status,
      created_at = excluded.created_at,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);

  return {
    upsertPR(pr: PRRecord): void {
      const existing = getExistingStatusAndSha.get(pr.number) as
        | { status: PRStatus; head_sha: string }
        | undefined;

      let status: PRStatus = existing?.status ?? 'queued';
      // A new commit from the author gives conflicted/stale PRs another chance.
      if (
        (existing?.status === 'conflicted' || existing?.status === 'stale') &&
        existing.head_sha !== pr.headSha
      ) {
        status = 'queued';
      }

      insertOrReplace.run({
        number: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        isDraft: pr.isDraft ? 1 : 0,
        autoMergeEnabled: pr.autoMergeEnabled ? 1 : 0,
        approved: pr.approved ? 1 : 0,
        ciStatus: pr.ciStatus,
        createdAt: pr.createdAt,
        status,
        updatedAt: new Date().toISOString(),
      });
    },

    deleteMissing(openNumbers: number[]): void {
      const placeholders = openNumbers.length > 0 ? openNumbers.map(() => '?').join(',') : 'NULL';
      db.prepare(`DELETE FROM pr_queue WHERE number NOT IN (${placeholders})`).run(...openNumbers);
    },

    setStatus(number: number, status: PRStatus): void {
      db.prepare(`UPDATE pr_queue SET status = ?, updated_at = ? WHERE number = ?`).run(
        status,
        new Date().toISOString(),
        number
      );
    },

    listQueued(): PRRow[] {
      const rows = db
        .prepare(
          `SELECT * FROM pr_queue
           WHERE status = 'queued' AND is_draft = 0 AND approved = 1 AND ci_status != 'failing'
           ORDER BY created_at ASC`
        )
        .all() as PRRowSql[];
      return rows.map(toPRRow);
    },

    resetStuckRebasing(): void {
      db.prepare(`UPDATE pr_queue SET status = 'queued', updated_at = ? WHERE status = 'rebasing'`).run(
        new Date().toISOString()
      );
    },

    getTracking(): Tracking | null {
      const row = db
        .prepare(
          `SELECT tracked_pr, tracked_since, tracked_base_sha, tracked_ci_passed FROM repo_state WHERE id = 1`
        )
        .get() as
        | {
            tracked_pr: number | null;
            tracked_since: string | null;
            tracked_base_sha: string | null;
            tracked_ci_passed: number;
          }
        | undefined;
      if (row?.tracked_pr == null || row.tracked_since == null || row.tracked_base_sha == null) {
        return null;
      }
      return {
        number: row.tracked_pr,
        since: row.tracked_since,
        baseSha: row.tracked_base_sha,
        ciPassed: row.tracked_ci_passed === 1,
      };
    },

    setTracking(tracking: Tracking): void {
      db.prepare(
        `UPDATE repo_state SET tracked_pr = ?, tracked_since = ?, tracked_base_sha = ?, tracked_ci_passed = ?
         WHERE id = 1`
      ).run(tracking.number, tracking.since, tracking.baseSha, tracking.ciPassed ? 1 : 0);
    },

    clearTracking(): void {
      db.prepare(
        `UPDATE repo_state SET tracked_pr = NULL, tracked_since = NULL, tracked_base_sha = NULL, tracked_ci_passed = 0
         WHERE id = 1`
      ).run();
    },

    close(): void {
      db.close();
    },
  };
}
