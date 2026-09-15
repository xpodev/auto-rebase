import { reconcile } from './reconciler';
import { runSchedulerTick } from './scheduler';
import type { Store } from './store';
import type { GitHubClient } from './github-client';
import type { RebaseWorker } from './rebase-worker';

export function startOrchestrator(deps: {
  store: Store;
  client: GitHubClient;
  worker: RebaseWorker;
  baseBranch: string;
  pollIntervalMs: number;
}): { stop: () => void } {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await reconcile(deps.client, deps.store);
      const result = await runSchedulerTick(deps.store, deps.client, deps.worker, deps.baseBranch);
      if (result.attempted) {
        console.log('[auto-rebase] rebase cascade attempted for latest base-branch change');
      }
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
