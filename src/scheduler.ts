import type { Store } from './store';
import type { GitHubClient } from './github-client';
import type { RebaseWorker } from './rebase-worker';
import type { PRRow, Tracking } from './types';
import { DEFAULT_PRIORITY_ORDER, rankWithTiers, type PriorityTier, type RankedPR } from './priority';

export function buildConflictComment(baseRef: string): string {
  return (
    `This PR could not be automatically rebased onto the latest \`${baseRef}\` due to a merge conflict. ` +
    `Please resolve the conflict manually (for example, \`git rebase origin/${baseRef}\`) and push the result.`
  );
}

export interface SchedulerOptions {
  priorityOrder?: PriorityTier[];
  staleAfterMs?: number | null;
  now?: () => Date;
}

export interface TickResult {
  attempted: boolean; // a rebase was attempted this tick
  tracked: number | null; // PR tracked at the end of the tick
}

const log = (message: string): void => console.log(`[auto-rebase] ${message}`);

// Our own rebase restarts CI, so a tracked PR whose CI already passed would otherwise
// drop a tier (and be preempted) every time we rebase it. Pending counts as passing for it.
function withTrackedCiCredit(rows: PRRow[], tracking: Tracking | null): PRRow[] {
  if (!tracking?.ciPassed) return rows;
  return rows.map((row) =>
    row.number === tracking.number && row.ciStatus === 'pending' ? { ...row, ciStatus: 'passing' } : row
  );
}

/**
 * One poll tick. The bot tracks at most one PR at a time and keeps it rebased onto
 * the base branch until it merges. Each tick it re-evaluates:
 *  - the tracked PR is dropped if it merged/closed, lost eligibility, or exceeded the
 *    stale timeout (in which case it is parked as 'stale');
 *  - a PR in a strictly higher priority tier preempts the tracked one;
 *  - conflicts mark the PR 'conflicted' and move on to the next candidate.
 */
export async function runSchedulerTick(
  store: Store,
  client: GitHubClient,
  worker: RebaseWorker,
  baseBranch: string,
  options: SchedulerOptions = {}
): Promise<TickResult> {
  const priorityOrder = options.priorityOrder ?? DEFAULT_PRIORITY_ORDER;
  const staleAfterMs = options.staleAfterMs ?? null;
  const now = (options.now ?? (() => new Date()))();

  const currentBaseSha = await client.getBaseBranchHeadSha(baseBranch);
  let eligible = store.listQueued();
  let tracking = store.getTracking();

  if (tracking) {
    const trackedRow = eligible.find((row) => row.number === tracking!.number);
    if (!trackedRow) {
      log(`PR #${tracking.number} is no longer a candidate (merged, closed, draft, unapproved, failing CI or conflicted); untracking`);
      store.clearTracking();
      tracking = null;
    } else if (staleAfterMs !== null && now.getTime() - Date.parse(tracking.since) >= staleAfterMs) {
      log(`PR #${tracking.number} did not merge within the stale timeout; skipping it until a new commit is pushed`);
      store.setStatus(tracking.number, 'stale');
      eligible = eligible.filter((row) => row !== trackedRow);
      store.clearTracking();
      tracking = null;
    } else if (trackedRow.ciStatus === 'passing' && !tracking.ciPassed) {
      tracking = { ...tracking, ciPassed: true };
      store.setTracking(tracking);
    }
  }

  const ranked = rankWithTiers(withTrackedCiCredit(eligible, tracking), priorityOrder);

  let trackedEntry: RankedPR | undefined;
  if (tracking) {
    trackedEntry = ranked.find((entry) => entry.row.number === tracking!.number);
    if (!trackedEntry) {
      log(`PR #${tracking.number} no longer matches any priority tier; untracking`);
    } else if (ranked[0].tier < trackedEntry.tier) {
      log(`PR #${ranked[0].row.number} has higher priority than tracked PR #${tracking.number}; switching`);
      trackedEntry = undefined;
    }
    if (!trackedEntry) {
      store.clearTracking();
      tracking = null;
    }
  }

  // Tracked PR first (if still valid), then everything else in priority order.
  const candidates = trackedEntry
    ? [trackedEntry, ...ranked.filter((entry) => entry !== trackedEntry)]
    : ranked;

  let attempted = false;
  for (const { row: candidate } of candidates) {
    const isTracked = tracking?.number === candidate.number;
    if (isTracked && tracking!.baseSha === currentBaseSha) {
      return { attempted, tracked: candidate.number }; // up to date — wait for it to merge
    }

    attempted = true;
    store.setStatus(candidate.number, 'rebasing');
    const result = await worker.rebasePR({ headRef: candidate.headRef, baseRef: candidate.baseRef });

    if (result.outcome === 'success') {
      store.setStatus(candidate.number, 'queued');
      store.setTracking({
        number: candidate.number,
        since: isTracked ? tracking!.since : now.toISOString(),
        baseSha: currentBaseSha,
        ciPassed: isTracked ? tracking!.ciPassed : candidate.ciStatus === 'passing',
      });
      log(`PR #${candidate.number} (${candidate.headRef}) rebased onto ${baseBranch}@${currentBaseSha}; tracking it`);
      return { attempted, tracked: candidate.number };
    }

    if (result.outcome === 'conflict') {
      store.setStatus(candidate.number, 'conflicted');
      if (isTracked) {
        store.clearTracking();
        tracking = null;
      }
      await client.commentOnPR(candidate.number, buildConflictComment(candidate.baseRef));
      log(`PR #${candidate.number} (${candidate.headRef}) had a conflict rebasing onto ${baseBranch}; moving to the next PR`);
      continue;
    }

    store.setStatus(candidate.number, 'queued');
    log(`PR #${candidate.number} (${candidate.headRef}) rebase failed transiently, will retry next tick: ${result.error}`);
    if (isTracked) {
      // Keep tracking; the stale timeout still bounds how long we wait on it.
      return { attempted, tracked: candidate.number };
    }
  }

  return { attempted, tracked: null };
}
