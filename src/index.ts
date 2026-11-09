import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { loadConfig } from './config';
import { createStore } from './store';
import { createGitHubClient, createTokenProvider } from './github-client';
import { createRebaseWorker } from './rebase-worker';
import { startOrchestrator } from './orchestrator';

function main(): void {
  const config = loadConfig();

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  });

  const client = createGitHubClient(config.repoOwner, config.repoName, octokit, config.ciChecks);
  const store = createStore(config.dbPath, config.baseBranch);
  store.resetStuckRebasing();

  const getToken = createTokenProvider(config);
  const worker = createRebaseWorker({
    gitWorkdir: config.gitWorkdir,
    getRemoteUrl: async () => {
      const token = await getToken();
      return `https://x-access-token:${token}@github.com/${config.repoOwner}/${config.repoName}.git`;
    },
  });

  const handle = startOrchestrator({
    store,
    client,
    worker,
    baseBranch: config.baseBranch,
    pollIntervalMs: config.pollIntervalMs,
    priorityOrder: config.priorityOrder,
    staleAfterMs: config.staleAfterMs,
  });

  const shutdown = (): void => {
    handle.stop();
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `[auto-rebase] watching ${config.repoOwner}/${config.repoName}@${config.baseBranch}, polling every ${config.pollIntervalMs}ms, ` +
      `stale timeout ${config.staleAfterMs === null ? 'disabled' : `${config.staleAfterMs}ms`}, ` +
      `CI checks ${config.ciChecks.length > 0 ? config.ciChecks.join(', ') : '(all, via rollup)'}`
  );
}

main();
