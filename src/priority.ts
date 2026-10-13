import type { PRRow } from './types';

const RULES = {
  AUTO_MERGE_ON: (pr: PRRow) => pr.autoMergeEnabled,
  PR_APPROVED: (pr: PRRow) => pr.approved,
  CI_PASSING: (pr: PRRow) => pr.ciStatus === 'passing',
  CI_PENDING: (pr: PRRow) => pr.ciStatus === 'pending',
} as const;

export type PriorityRuleName = keyof typeof RULES;

// A tier is a list of rules that must ALL match. An empty tier matches every PR.
export type PriorityTier = PriorityRuleName[];

export interface PriorityConfig {
  priorityOrder: PriorityTier[];
}

// Equivalent to the original hard-coded ordering: passing CI first, then
// auto-merge+approved, auto-merge, approved, everything else.
export const DEFAULT_PRIORITY_ORDER: PriorityTier[] = (['CI_PASSING', null] as const).flatMap((ci) =>
  [['AUTO_MERGE_ON', 'PR_APPROVED'], ['AUTO_MERGE_ON'], ['PR_APPROVED'], []].map(
    (tier) => (ci ? [ci, ...tier] : tier) as PriorityTier
  )
);

export function parsePriorityConfig(raw: unknown): PriorityTier[] {
  const order = (raw as { priorityOrder?: unknown } | null)?.priorityOrder;
  if (!Array.isArray(order)) {
    throw new Error('Priority config must be an object with a "priorityOrder" array');
  }
  return order.map((tier, i) => {
    if (!Array.isArray(tier)) {
      throw new Error(`priorityOrder[${i}] must be an array of rule names`);
    }
    return tier.map((rule, j) => {
      if (typeof rule !== 'string' || !(rule in RULES)) {
        throw new Error(
          `priorityOrder[${i}][${j}] is not a known rule: ${JSON.stringify(rule)} (known: ${Object.keys(RULES).join(', ')})`
        );
      }
      return rule as PriorityRuleName;
    });
  });
}

function tierIndex(pr: PRRow, order: PriorityTier[]): number {
  return order.findIndex((tier) => tier.every((rule) => RULES[rule](pr)));
}

// Drops PRs matching no tier; sorts the rest by tier, keeping input order within a tier.
export function rankQueue(rows: PRRow[], order: PriorityTier[]): PRRow[] {
  return rows
    .map((row) => ({ row, tier: tierIndex(row, order) }))
    .filter((entry) => entry.tier !== -1)
    .sort((a, b) => a.tier - b.tier)
    .map((entry) => entry.row);
}
