import { reconcile } from './reconciler';
import { runSchedulerTick } from './scheduler';
import type { Store } from './store';
import type { GitHubClient } from './github-client';
import type { RebaseWorker } from './rebase-worker';
import type { PriorityTier } from './priority';

export function startOrchestrator(deps: {
  store: Store;
  client: GitHubClient;
  worker: RebaseWorker;
  baseBranch: string;
  pollIntervalMs: number;
  priorityOrder?: PriorityTier[];
  staleAfterMs?: number | null;
}): { stop: () => void } {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await reconcile(deps.client, deps.store);
      await runSchedulerTick(deps.store, deps.client, deps.worker, deps.baseBranch, {
        priorityOrder: deps.priorityOrder,
        staleAfterMs: deps.staleAfterMs,
      });
    } catch (err) {
      console.error('[auto-rebase] poll tick failed:', err);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.pollIntervalMs);

  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
