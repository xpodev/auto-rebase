import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const baseEnv = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----',
  GITHUB_APP_INSTALLATION_ID: '456',
  GITHUB_REPO: 'acme/widgets',
};

describe('loadConfig', () => {
  it('parses required vars and applies defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.appId).toBe('123');
    expect(config.installationId).toBe(456);
    expect(config.repoOwner).toBe('acme');
    expect(config.repoName).toBe('widgets');
    expect(config.baseBranch).toBe('main');
    expect(config.pollIntervalMs).toBe(60000);
    expect(config.gitWorkdir).toBe('.git-workdir');
    expect(config.dbPath).toBe('./pr-queue.db');
  });

  it('honors overrides', () => {
    const config = loadConfig({
      ...baseEnv,
      BASE_BRANCH: 'develop',
      POLL_INTERVAL_MS: '15000',
      GIT_WORKDIR: '/tmp/work',
      DB_PATH: '/tmp/queue.db',
    });
    expect(config.baseBranch).toBe('develop');
    expect(config.pollIntervalMs).toBe(15000);
    expect(config.gitWorkdir).toBe('/tmp/work');
    expect(config.dbPath).toBe('/tmp/queue.db');
  });

  it('throws when a required var is missing', () => {
    const { GITHUB_APP_ID, ...rest } = baseEnv;
    expect(() => loadConfig(rest)).toThrow(/GITHUB_APP_ID/);
  });

  it('throws when GITHUB_REPO is not owner/repo', () => {
    expect(() => loadConfig({ ...baseEnv, GITHUB_REPO: 'not-a-repo' })).toThrow(/owner\/repo/);
  });
});
