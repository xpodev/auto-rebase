import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';
import { createStore, Store } from '../src/store';
import type { GitHubClient } from '../src/github-client';
import type { RebaseWorker } from '../src/rebase-worker';
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

describe('startOrchestrator', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('reconciles and schedules on an immediate tick, then again each interval', async () => {
    let baseSha = 'sha-a';
    const client: GitHubClient = {
      listOpenPRs: vi.fn().mockResolvedValue([pr({ number: 1 })]),
      getBaseBranchHeadSha: vi.fn().mockImplementation(async () => baseSha),
      commentOnPR: vi.fn(),
    };
    const worker: RebaseWorker = {
      rebasePR: vi.fn().mockResolvedValue({ outcome: 'success' }),
    };

    const handle = startOrchestrator({
      store,
      client,
      worker,
      baseBranch: 'main',
      pollIntervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.listOpenPRs).toHaveBeenCalledTimes(1);
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);
    expect(store.getLastProcessedBaseSha()).toBe('sha-a');

    baseSha = 'sha-b';
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.listOpenPRs).toHaveBeenCalledTimes(2);
    expect(worker.rebasePR).toHaveBeenCalledTimes(2);
    expect(store.getLastProcessedBaseSha()).toBe('sha-b');

    handle.stop();
    baseSha = 'sha-c';
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.listOpenPRs).toHaveBeenCalledTimes(2);
  });
});
