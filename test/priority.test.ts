import { describe, it, expect } from 'vitest';
import { DEFAULT_PRIORITY_ORDER, parsePriorityOrder, rankQueue, rankWithTiers } from '../src/priority';
import type { PRRow } from '../src/types';

function row(overrides: Partial<PRRow>): PRRow {
  return {
    number: 1,
    headRef: 'f',
    headSha: 's',
    baseRef: 'main',
    isDraft: false,
    autoMergeEnabled: false,
    approved: false,
    ciStatus: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'queued',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('rankQueue', () => {
  const order = parsePriorityOrder([['AUTO_MERGE_ON', 'PR_APPROVED'], ['AUTO_MERGE_ON']]);

  it('orders by first matching tier, keeping input order within a tier', () => {
    const rows = [
      row({ number: 1, autoMergeEnabled: true }),
      row({ number: 2, autoMergeEnabled: true, approved: true }),
      row({ number: 3, autoMergeEnabled: true }),
    ];
    expect(rankQueue(rows, order).map((r) => r.number)).toEqual([2, 1, 3]);
  });

  it('drops PRs that match no tier', () => {
    const rows = [row({ number: 1, approved: true }), row({ number: 2, autoMergeEnabled: true })];
    expect(rankQueue(rows, order).map((r) => r.number)).toEqual([2]);
  });

  it('treats an empty tier as match-all', () => {
    expect(rankQueue([row({ number: 1 })], [[]]).map((r) => r.number)).toEqual([1]);
  });
});

describe('DEFAULT_PRIORITY_ORDER', () => {
  it('ranks auto-merge+CI, then CI only, then auto-merge only, and drops the rest', () => {
    const rows = [
      row({ number: 1 }),
      row({ number: 2, autoMergeEnabled: true }),
      row({ number: 3, ciStatus: 'passing' }),
      row({ number: 4, autoMergeEnabled: true, ciStatus: 'passing' }),
    ];
    expect(rankWithTiers(rows, DEFAULT_PRIORITY_ORDER).map((e) => [e.row.number, e.tier])).toEqual([
      [4, 0],
      [3, 1],
      [2, 2],
    ]);
  });
});

describe('parsePriorityOrder', () => {
  it('rejects unknown rule names', () => {
    expect(() => parsePriorityOrder([['NOPE']])).toThrow(/known rule/);
  });

  it('rejects a malformed priorityOrder', () => {
    expect(() => parsePriorityOrder({})).toThrow(/priorityOrder/);
    expect(() => parsePriorityOrder(['AUTO_MERGE_ON'])).toThrow(/array/);
  });
});
