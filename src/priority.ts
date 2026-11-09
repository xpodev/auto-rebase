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

// Approval and non-draft are hard prerequisites applied before ranking, so the
// default only orders by auto-merge and CI. PRs with neither are not rebased.
export const DEFAULT_PRIORITY_ORDER: PriorityTier[] = [
  ['AUTO_MERGE_ON', 'CI_PASSING'],
  ['CI_PASSING'],
  ['AUTO_MERGE_ON'],
];

export function parsePriorityOrder(order: unknown): PriorityTier[] {
  if (!Array.isArray(order)) {
    throw new Error('"priorityOrder" must be an array of tiers');
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

export function tierIndex(pr: PRRow, order: PriorityTier[]): number {
  return order.findIndex((tier) => tier.every((rule) => RULES[rule](pr)));
}

export interface RankedPR {
  row: PRRow;
  tier: number; // lower is higher priority
}

// Drops PRs matching no tier; sorts the rest by tier, keeping input order within a tier.
export function rankWithTiers(rows: PRRow[], order: PriorityTier[]): RankedPR[] {
  return rows
    .map((row) => ({ row, tier: tierIndex(row, order) }))
    .filter((entry) => entry.tier !== -1)
    .sort((a, b) => a.tier - b.tier);
}

export function rankQueue(rows: PRRow[], order: PriorityTier[]): PRRow[] {
  return rankWithTiers(rows, order).map((entry) => entry.row);
}
