import type { GitHubClient } from './github-client';
import type { Store } from './store';

export async function reconcile(client: GitHubClient, store: Store): Promise<void> {
  const openPRs = await client.listOpenPRs();
  for (const pr of openPRs) {
    store.upsertPR(pr);
  }
  store.deleteMissing(openPRs.map((pr) => pr.number));
}
