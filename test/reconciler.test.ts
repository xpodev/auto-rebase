import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconcile } from '../src/reconciler';
import { createStore, Store } from '../src/store';
import type { GitHubClient } from '../src/github-client';
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

function fakeClient(prs: PRRecord[]): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue(prs),
    getBaseBranchHeadSha: vi.fn(),
    commentOnPR: vi.fn(),
  };
}

describe('reconcile', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
  });

  it('adds newly seen open PRs to the store', async () => {
    const client = fakeClient([pr({ number: 1 }), pr({ number: 2 })]);
    await reconcile(client, store);
    const numbers = store.listQueued().map((row) => row.number);
    expect(numbers.sort()).toEqual([1, 2]);
  });

  it('removes PRs no longer reported as open', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient([pr({ number: 2 })]);
    await reconcile(client, store);
    const numbers = store.listQueued().map((row) => row.number);
    expect(numbers).toEqual([2]);
  });

  it('refreshes head_sha for an existing PR', async () => {
    store.upsertPR(pr({ number: 1, headSha: 'old-sha' }));
    const client = fakeClient([pr({ number: 1, headSha: 'new-sha' })]);
    await reconcile(client, store);
    const [row] = store.listQueued();
    expect(row.headSha).toBe('new-sha');
  });
});
