import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runSchedulerTick, buildConflictComment } from '../src/scheduler';
import { createStore, Store } from '../src/store';
import type { GitHubClient } from '../src/github-client';
import type { RebaseWorker, RebaseResult } from '../src/rebase-worker';
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

function fakeClient(baseSha: string): GitHubClient {
  return {
    listOpenPRs: vi.fn(),
    getBaseBranchHeadSha: vi.fn().mockResolvedValue(baseSha),
    commentOnPR: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeWorker(results: RebaseResult[]): RebaseWorker {
  let call = 0;
  return {
    rebasePR: vi.fn().mockImplementation(async () => results[call++]),
  };
}

describe('runSchedulerTick', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
  });

  it('does nothing when the base branch sha has not changed', async () => {
    store.setLastProcessedBaseSha('sha-a');
    store.upsertPR(pr({ number: 1 }));
    const client = fakeClient('sha-a');
    const worker = fakeWorker([]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(false);
    expect(worker.rebasePR).not.toHaveBeenCalled();
  });

  it('rebases the single highest-priority PR when the base sha changed', async () => {
    store.setLastProcessedBaseSha('sha-a');
    store.upsertPR(pr({ number: 1, createdAt: '2026-01-02T00:00:00Z' }));
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-01T00:00:00Z' }));
    const client = fakeClient('sha-b');
    const worker = fakeWorker([{ outcome: 'success' }]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(true);
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);
    expect(worker.rebasePR).toHaveBeenCalledWith({ headRef: 'feature-1', baseRef: 'main' });
    expect(store.getLastProcessedBaseSha()).toBe('sha-b');
  });

  it('cascades to the next PR and comments when the first conflicts', async () => {
    store.setLastProcessedBaseSha('sha-a');
    store.upsertPR(pr({ number: 1, createdAt: '2026-01-01T00:00:00Z' }));
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-02T00:00:00Z' }));
    const client = fakeClient('sha-b');
    const worker = fakeWorker([{ outcome: 'conflict' }, { outcome: 'success' }]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(true);
    expect(worker.rebasePR).toHaveBeenCalledTimes(2);
    expect(client.commentOnPR).toHaveBeenCalledWith(1, buildConflictComment('main'));

    const rows = store.listQueued().map((row) => row.number);
    expect(rows).toEqual([2]);
  });

  it('marks last processed sha even when the queue is empty', async () => {
    store.setLastProcessedBaseSha('sha-a');
    const client = fakeClient('sha-b');
    const worker = fakeWorker([]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(false);
    expect(store.getLastProcessedBaseSha()).toBe('sha-b');
  });
});

describe('buildConflictComment', () => {
  it('mentions the base ref and manual resolution', () => {
    const comment = buildConflictComment('main');
    expect(comment).toContain('main');
    expect(comment).toContain('conflict');
  });
});
