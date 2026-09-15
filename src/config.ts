import type { Config } from './types';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repo = required(env, 'GITHUB_REPO');
  const [repoOwner, repoName] = repo.split('/');
  if (!repoOwner || !repoName) {
    throw new Error(`GITHUB_REPO must be in "owner/repo" format, got: ${repo}`);
  }

  return {
    appId: required(env, 'GITHUB_APP_ID'),
    privateKey: required(env, 'GITHUB_APP_PRIVATE_KEY'),
    installationId: Number(required(env, 'GITHUB_APP_INSTALLATION_ID')),
    repoOwner,
    repoName,
    baseBranch: env.BASE_BRANCH ?? 'main',
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? '60000'),
    gitWorkdir: env.GIT_WORKDIR ?? '.git-workdir',
    dbPath: env.DB_PATH ?? './pr-queue.db',
  };
}
