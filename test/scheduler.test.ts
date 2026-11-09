import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runSchedulerTick, buildConflictComment, type SchedulerOptions } from '../src/scheduler';
import { createStore, Store } from '../src/store';
import type { GitHubClient } from '../src/github-client';
import type { RebaseWorker, RebaseResult } from '../src/rebase-worker';
import type { PRRecord } from '../src/types';

function pr(overrides: Partial<PRRecord>): PRRecord {
  const number = overrides.number ?? 1;
  return {
    number,
    headRef: `feature-${number}`,
    headSha: `sha-${number}`,
    baseRef: 'main',
    isDraft: false,
    autoMergeEnabled: true,
    approved: true,
    ciStatus: 'pending',
    createdAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`,
    ...overrides,
  };
}

function fakeClient(baseSha: string): GitHubClient & { setBase(sha: string): void } {
  let current = baseSha;
  return {
    listOpenPRs: vi.fn(),
    getBaseBranchHeadSha: vi.fn().mockImplementation(async () => current),
    commentOnPR: vi.fn().mockResolvedValue(undefined),
    setBase(sha: string) {
      current = sha;
    },
  };
}

function fakeWorker(results: RebaseResult[] = []): RebaseWorker {
  let call = 0;
  return {
    rebasePR: vi.fn().mockImplementation(async () => results[call++] ?? { outcome: 'success' }),
  };
}

const T0 = new Date('2026-03-01T00:00:00Z');
const at = (ms: number): SchedulerOptions['now'] => () => new Date(T0.getTime() + ms);

describe('runSchedulerTick', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
  });

  it('rebases and tracks the highest-priority PR when nothing is tracked', async () => {
    store.upsertPR(pr({ number: 1 })); // auto-merge only
    store.upsertPR(pr({ number: 2, ciStatus: 'passing' })); // auto-merge + CI
    const worker = fakeWorker();

    const result = await runSchedulerTick(store, fakeClient('base-a'), worker, 'main', { now: at(0) });

    expect(result).toEqual({ attempted: true, tracked: 2 });
    expect(worker.rebasePR).toHaveBeenCalledWith({ headRef: 'feature-2', baseRef: 'main' });
    expect(store.getTracking()).toEqual({
      number: 2,
      since: T0.toISOString(),
      baseSha: 'base-a',
      ciPassed: true,
    });
  });

  it('applies the default order: auto-merge+CI, then CI, then auto-merge; skips PRs with neither', async () => {
    store.upsertPR(pr({ number: 1, autoMergeEnabled: false })); // neither: never rebased
    store.upsertPR(pr({ number: 2 })); // auto-merge only
    store.upsertPR(pr({ number: 3, autoMergeEnabled: false, ciStatus: 'passing' })); // CI only
    const worker = fakeWorker([{ outcome: 'conflict' }, { outcome: 'conflict' }]);

    const result = await runSchedulerTick(store, fakeClient('base-a'), worker, 'main');

    expect((worker.rebasePR as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].headRef)).toEqual([
      'feature-3',
      'feature-2',
    ]);
    expect(result.tracked).toBeNull();
  });

  it('never touches unapproved or draft PRs', async () => {
    store.upsertPR(pr({ number: 1, approved: false, ciStatus: 'passing' }));
    store.upsertPR(pr({ number: 2, isDraft: true, ciStatus: 'passing' }));
    const worker = fakeWorker();

    const result = await runSchedulerTick(store, fakeClient('base-a'), worker, 'main');

    expect(result).toEqual({ attempted: false, tracked: null });
    expect(worker.rebasePR).not.toHaveBeenCalled();
  });

  it('does not rebase the tracked PR again while the base is unchanged', async () => {
    store.upsertPR(pr({ number: 1 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker();

    await runSchedulerTick(store, client, worker, 'main');
    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result).toEqual({ attempted: false, tracked: 1 });
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);
  });

  it('re-rebases the tracked PR when the base moves, keeping its tracking start time', async () => {
    store.upsertPR(pr({ number: 1 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker();

    await runSchedulerTick(store, client, worker, 'main', { now: at(0) });
    client.setBase('base-b');
    await runSchedulerTick(store, client, worker, 'main', { now: at(5000) });

    expect(worker.rebasePR).toHaveBeenCalledTimes(2);
    expect(store.getTracking()).toMatchObject({ number: 1, since: T0.toISOString(), baseSha: 'base-b' });
  });

  it('keeps the tracked PR over a newer PR in the same tier', async () => {
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker();
    await runSchedulerTick(store, client, worker, 'main');

    store.upsertPR(pr({ number: 1 })); // older, same tier
    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.tracked).toBe(2);
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);
  });

  it('switches to a PR that reaches a higher tier while another is tracked', async () => {
    store.upsertPR(pr({ number: 1 })); // auto-merge only
    store.upsertPR(pr({ number: 2, autoMergeEnabled: false })); // not eligible yet
    const client = fakeClient('base-a');
    const worker = fakeWorker();
    await runSchedulerTick(store, client, worker, 'main');
    expect(store.getTracking()?.number).toBe(1);

    store.upsertPR(pr({ number: 2, autoMergeEnabled: false, ciStatus: 'passing' })); // CI passing tier
    const result = await runSchedulerTick(store, client, worker, 'main', { now: at(1000) });

    expect(result).toEqual({ attempted: true, tracked: 2 });
    expect(worker.rebasePR).toHaveBeenLastCalledWith({ headRef: 'feature-2', baseRef: 'main' });
    expect(store.getTracking()?.since).toBe(new Date(T0.getTime() + 1000).toISOString());
  });

  it('does not let the CI re-run triggered by our own rebase demote the tracked PR', async () => {
    store.upsertPR(pr({ number: 1, ciStatus: 'passing' })); // auto-merge + CI
    const client = fakeClient('base-a');
    const worker = fakeWorker();
    await runSchedulerTick(store, client, worker, 'main');

    store.upsertPR(pr({ number: 1, ciStatus: 'pending' })); // CI restarted after our push
    store.upsertPR(pr({ number: 2, autoMergeEnabled: false, ciStatus: 'passing' })); // CI-only tier
    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.tracked).toBe(1);
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);
  });

  it('untracks a PR that merged or closed and moves to the next one', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker();
    await runSchedulerTick(store, client, worker, 'main');
    expect(store.getTracking()?.number).toBe(1);

    store.deleteMissing([2]); // #1 merged
    client.setBase('base-b');
    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.tracked).toBe(2);
  });

  it('untracks a PR that loses approval', async () => {
    store.upsertPR(pr({ number: 1 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker();
    await runSchedulerTick(store, client, worker, 'main');

    store.upsertPR(pr({ number: 1, approved: false }));
    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.tracked).toBeNull();
    expect(store.getTracking()).toBeNull();
  });

  it('marks the tracked PR stale after the timeout and moves to the next one', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker();
    const opts = { staleAfterMs: 60_000 };

    await runSchedulerTick(store, client, worker, 'main', { ...opts, now: at(0) });
    await runSchedulerTick(store, client, worker, 'main', { ...opts, now: at(59_999) });
    expect(store.getTracking()?.number).toBe(1);

    const result = await runSchedulerTick(store, client, worker, 'main', { ...opts, now: at(60_000) });

    expect(result).toEqual({ attempted: true, tracked: 2 });
    expect(store.listQueued().map((row) => row.number)).toEqual([2]); // #1 parked as stale
  });

  it('never goes stale when no timeout is configured', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker();

    await runSchedulerTick(store, client, worker, 'main', { now: at(0) });
    const result = await runSchedulerTick(store, client, worker, 'main', { now: at(1e12) });

    expect(result.tracked).toBe(1);
  });

  it('on conflict, comments and moves to the next PR in the same tick', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker([{ outcome: 'conflict' }, { outcome: 'success' }]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.tracked).toBe(2);
    expect(client.commentOnPR).toHaveBeenCalledWith(1, buildConflictComment('main'));
    expect(store.listQueued().map((row) => row.number)).toEqual([2]);
  });

  it('drops the tracked PR when re-rebasing it conflicts, and switches to the next', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker([{ outcome: 'success' }, { outcome: 'conflict' }, { outcome: 'success' }]);
    await runSchedulerTick(store, client, worker, 'main');

    client.setBase('base-b');
    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.tracked).toBe(2);
    expect(client.commentOnPR).toHaveBeenCalledWith(1, buildConflictComment('main'));
  });

  it('keeps tracking through a transient failure and retries next tick', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient('base-a');
    const worker = fakeWorker([
      { outcome: 'success' },
      { outcome: 'transient-failure', error: 'network' },
      { outcome: 'success' },
    ]);
    await runSchedulerTick(store, client, worker, 'main');

    client.setBase('base-b');
    const failed = await runSchedulerTick(store, client, worker, 'main');
    expect(failed.tracked).toBe(1);
    expect(store.getTracking()?.baseSha).toBe('base-a');

    await runSchedulerTick(store, client, worker, 'main');
    expect(store.getTracking()).toMatchObject({ number: 1, baseSha: 'base-b' });
    expect(worker.rebasePR).toHaveBeenCalledTimes(3);
  });

  it('honors a custom priority order', async () => {
    store.upsertPR(pr({ number: 1, autoMergeEnabled: false }));
    const worker = fakeWorker();

    const result = await runSchedulerTick(store, fakeClient('base-a'), worker, 'main', {
      priorityOrder: [[]],
    });

    expect(result.tracked).toBe(1);
  });
});

describe('buildConflictComment', () => {
  it('mentions the base ref and manual resolution', () => {
    const comment = buildConflictComment('main');
    expect(comment).toContain('main');
    expect(comment).toContain('conflict');
  });
});
