import { readFileSync } from 'node:fs';
import type { Config } from './types';
import { DEFAULT_PRIORITY_ORDER, parsePriorityOrder } from './priority';

const KNOWN_CONFIG_KEYS = ['priorityOrder'];

// General JSON config, from CONFIG (inline) or CONFIG_PATH (file); inline wins.
function loadJsonConfig(env: NodeJS.ProcessEnv): { priorityOrder?: unknown } {
  const inline = env.CONFIG;
  const path = env.CONFIG_PATH;
  if (!inline && !path) return {};
  const source = inline ? 'CONFIG' : `CONFIG_PATH (${path})`;
  try {
    const raw = JSON.parse(inline ?? readFileSync(path!, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('config must be a JSON object');
    }
    const unknown = Object.keys(raw).filter((key) => !KNOWN_CONFIG_KEYS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`unknown key(s): ${unknown.join(', ')} (known: ${KNOWN_CONFIG_KEYS.join(', ')})`);
    }
    return raw;
  } catch (err) {
    throw new Error(`Invalid ${source}: ${(err as Error).message}`);
  }
}

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

  const jsonConfig = loadJsonConfig(env);

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
    priorityOrder:
      jsonConfig.priorityOrder === undefined
        ? DEFAULT_PRIORITY_ORDER
        : parsePriorityOrder(jsonConfig.priorityOrder),
  };
}
