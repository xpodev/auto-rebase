import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStore, Store } from '../src/store';
import type { PRRecord } from '../src/types';

function pr(overrides: Partial<PRRecord>): PRRecord {
  return {
    number: 1,
    headRef: 'feature-1',
    headSha: 'sha1',
    baseRef: 'main',
    isDraft: false,
    autoMergeEnabled: false,
    approved: false,
    ciStatus: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
  });

  it('inserts a new PR as queued', () => {
    store.upsertPR(pr({ number: 1 }));
    const queued = store.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0].number).toBe(1);
    expect(queued[0].status).toBe('queued');
  });

  it('orders queued PRs by auto-merge first, then created_at ascending', () => {
    store.upsertPR(pr({ number: 1, createdAt: '2026-01-02T00:00:00Z', autoMergeEnabled: false }));
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-01T00:00:00Z', autoMergeEnabled: false }));
    store.upsertPR(pr({ number: 3, createdAt: '2026-01-03T00:00:00Z', autoMergeEnabled: true }));

    const order = store.listQueued().map((row) => row.number);
    expect(order).toEqual([3, 2, 1]);
  });

  it('prioritizes approved+auto-merge, then auto-merge only, then approved only, then neither, oldest first within each tier', () => {
    store.upsertPR(pr({ number: 1, createdAt: '2026-01-01T00:00:00Z', autoMergeEnabled: false, approved: false }));
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-02T00:00:00Z', autoMergeEnabled: false, approved: true }));
    store.upsertPR(pr({ number: 3, createdAt: '2026-01-03T00:00:00Z', autoMergeEnabled: true, approved: false }));
    store.upsertPR(pr({ number: 4, createdAt: '2026-01-04T00:00:00Z', autoMergeEnabled: true, approved: true }));
    store.upsertPR(pr({ number: 5, createdAt: '2026-01-05T00:00:00Z', autoMergeEnabled: false, approved: true }));
    store.upsertPR(pr({ number: 6, createdAt: '2026-01-06T00:00:00Z', autoMergeEnabled: true, approved: false }));

    const order = store.listQueued().map((row) => row.number);
    expect(order).toEqual([4, 3, 6, 2, 5, 1]);
  });

  it('excludes draft PRs from listQueued', () => {
    store.upsertPR(pr({ number: 1, isDraft: true }));
    expect(store.listQueued()).toHaveLength(0);
  });

  it('excludes PRs with failing CI from listQueued', () => {
    store.upsertPR(pr({ number: 1, ciStatus: 'failing' }));
    expect(store.listQueued()).toHaveLength(0);
  });

  it('prioritizes passing CI ahead of pending CI regardless of approval tier', () => {
    store.upsertPR(
      pr({ number: 1, createdAt: '2026-01-01T00:00:00Z', autoMergeEnabled: true, approved: true, ciStatus: 'pending' })
    );
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-02T00:00:00Z', ciStatus: 'passing' }));

    const order = store.listQueued().map((row) => row.number);
    expect(order).toEqual([2, 1]);
  });

  it('excludes conflicted PRs from listQueued', () => {
    store.upsertPR(pr({ number: 1 }));
    store.setStatus(1, 'conflicted');
    expect(store.listQueued()).toHaveLength(0);
  });

  it('resets conflicted status back to queued when head_sha changes on upsert', () => {
    store.upsertPR(pr({ number: 1, headSha: 'sha1' }));
    store.setStatus(1, 'conflicted');
    store.upsertPR(pr({ number: 1, headSha: 'sha2' }));
    const queued = store.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0].headSha).toBe('sha2');
  });

  it('keeps conflicted status when head_sha is unchanged on upsert', () => {
    store.upsertPR(pr({ number: 1, headSha: 'sha1' }));
    store.setStatus(1, 'conflicted');
    store.upsertPR(pr({ number: 1, headSha: 'sha1' }));
    expect(store.listQueued()).toHaveLength(0);
  });

  it('deletes rows missing from the given open-PR-number list', () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    store.deleteMissing([2]);
    const order = store.listQueued().map((row) => row.number);
    expect(order).toEqual([2]);
  });

  it('resets rows stuck in rebasing back to queued', () => {
    store.upsertPR(pr({ number: 1 }));
    store.setStatus(1, 'rebasing');
    store.resetStuckRebasing();
    expect(store.listQueued()).toHaveLength(1);
  });

  it('tracks last processed base sha, defaulting to null', () => {
    expect(store.getLastProcessedBaseSha()).toBeNull();
    store.setLastProcessedBaseSha('abc123');
    expect(store.getLastProcessedBaseSha()).toBe('abc123');
  });

  it('migrates an existing pr_queue table that predates the approved column', () => {
    const dbPath = path.join(os.tmpdir(), `store-migration-test-${Date.now()}.db`);
    try {
      const oldDb = new Database(dbPath);
      oldDb.exec(`
        CREATE TABLE pr_queue (
          number              INTEGER PRIMARY KEY,
          head_ref            TEXT NOT NULL,
          head_sha            TEXT NOT NULL,
          base_ref            TEXT NOT NULL,
          is_draft            INTEGER NOT NULL,
          auto_merge_enabled  INTEGER NOT NULL,
          created_at          TEXT NOT NULL,
          status              TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE TABLE repo_state (
          id                       INTEGER PRIMARY KEY CHECK (id = 1),
          base_branch              TEXT NOT NULL,
          last_processed_base_sha  TEXT
        );
      `);
      oldDb
        .prepare(
          `INSERT INTO pr_queue (number, head_ref, head_sha, base_ref, is_draft, auto_merge_enabled, created_at, status, updated_at)
           VALUES (1, 'feature-1', 'sha1', 'main', 0, 0, '2026-01-01T00:00:00Z', 'queued', '2026-01-01T00:00:00Z')`
        )
        .run();
      oldDb.close();

      const migratedStore = createStore(dbPath, 'main');
      const queued = migratedStore.listQueued();
      expect(queued).toHaveLength(1);
      expect(queued[0].approved).toBe(false);
      expect(queued[0].ciStatus).toBe('pending');

      migratedStore.upsertPR(pr({ number: 2, approved: true, ciStatus: 'passing' }));
      const afterUpsert = migratedStore.listQueued().find((row) => row.number === 2);
      expect(afterUpsert?.approved).toBe(true);
      expect(afterUpsert?.ciStatus).toBe('passing');

      migratedStore.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
          // best-effort cleanup; Windows may briefly hold a file lock
        }
      }
    }
  });
});
