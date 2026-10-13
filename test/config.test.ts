import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('loads priorityOrder from CONFIG_PATH', () => {
    const file = path.join(os.tmpdir(), `priority-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ priorityOrder: [['AUTO_MERGE_ON']] }));
    try {
      expect(loadConfig({ ...baseEnv, CONFIG_PATH: file }).priorityOrder).toEqual([['AUTO_MERGE_ON']]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('loads priorityOrder from inline CONFIG, taking precedence over the path', () => {
    const config = loadConfig({
      ...baseEnv,
      CONFIG: '{"priorityOrder":[["PR_APPROVED"]]}',
      CONFIG_PATH: '/does/not/exist.json',
    });
    expect(config.priorityOrder).toEqual([['PR_APPROVED']]);
  });

  it('rejects unknown keys and falls back to the default order when priorityOrder is absent', () => {
    expect(() => loadConfig({ ...baseEnv, CONFIG: '{"priorityOrdr":[]}' })).toThrow(/unknown key/);
    expect(loadConfig({ ...baseEnv, CONFIG: '{}' }).priorityOrder.length).toBeGreaterThan(0);
  });

  it('throws on invalid inline CONFIG', () => {
    expect(() => loadConfig({ ...baseEnv, CONFIG: 'not json' })).toThrow(/CONFIG/);
  });

  it('throws on an invalid priority config file', () => {
    expect(() => loadConfig({ ...baseEnv, CONFIG_PATH: '/does/not/exist.json' })).toThrow(
      /CONFIG_PATH/
    );
  });

  it('throws when a required var is missing', () => {
    const { GITHUB_APP_ID, ...rest } = baseEnv;
    expect(() => loadConfig(rest)).toThrow(/GITHUB_APP_ID/);
  });

  it('throws when GITHUB_REPO is not owner/repo', () => {
    expect(() => loadConfig({ ...baseEnv, GITHUB_REPO: 'not-a-repo' })).toThrow(/owner\/repo/);
  });
});
