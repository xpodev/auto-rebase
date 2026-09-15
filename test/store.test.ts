import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('excludes draft PRs from listQueued', () => {
    store.upsertPR(pr({ number: 1, isDraft: true }));
    expect(store.listQueued()).toHaveLength(0);
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
});
