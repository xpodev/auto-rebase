import type { Store } from './store';
import type { GitHubClient } from './github-client';
import type { RebaseWorker } from './rebase-worker';

export function buildConflictComment(baseRef: string): string {
  return (
    `This PR could not be automatically rebased onto the latest \`${baseRef}\` due to a merge conflict. ` +
    `Please resolve the conflict manually (for example, \`git rebase origin/${baseRef}\`) and push the result.`
  );
}

export async function runSchedulerTick(
  store: Store,
  client: GitHubClient,
  worker: RebaseWorker,
  baseBranch: string
): Promise<{ attempted: boolean }> {
  const currentBaseSha = await client.getBaseBranchHeadSha(baseBranch);
  const lastProcessed = store.getLastProcessedBaseSha();

  if (currentBaseSha === lastProcessed) {
    return { attempted: false };
  }

  const queue = store.listQueued();

  for (const candidate of queue) {
    store.setStatus(candidate.number, 'rebasing');
    const result = await worker.rebasePR({ headRef: candidate.headRef, baseRef: candidate.baseRef });

    if (result.outcome === 'success') {
      store.setStatus(candidate.number, 'queued');
      store.setLastProcessedBaseSha(currentBaseSha);
      return { attempted: true };
    }

    if (result.outcome === 'conflict') {
      store.setStatus(candidate.number, 'conflicted');
      await client.commentOnPR(candidate.number, buildConflictComment(candidate.baseRef));
      continue;
    }

    store.setStatus(candidate.number, 'queued');
  }

  store.setLastProcessedBaseSha(currentBaseSha);
  return { attempted: queue.length > 0 };
}
