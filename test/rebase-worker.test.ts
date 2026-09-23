import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import simpleGit from 'simple-git';
import { createRebaseWorker } from '../src/rebase-worker';

async function makeBareRemote(dir: string): Promise<string> {
  const remoteDir = join(dir, 'remote.git');
  mkdirSync(remoteDir);
  await simpleGit(remoteDir).init(true);
  return remoteDir;
}

async function seedRemote(remoteDir: string, seedDir: string): Promise<void> {
  mkdirSync(seedDir);
  const git = simpleGit(seedDir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  writeFileSync(join(seedDir, 'base.txt'), 'base line 1\n');
  await git.add('.');
  await git.commit('base commit 1');
  await git.branch(['-M', 'main']);
  await git.addRemote('origin', remoteDir);
  await git.push(['origin', 'main']);

  await git.checkoutBranch('pr-branch', 'main');
  writeFileSync(join(seedDir, 'feature.txt'), 'feature line\n');
  await git.add('.');
  await git.commit('pr commit');
  await git.push(['origin', 'pr-branch']);

  await git.checkout('main');
  writeFileSync(join(seedDir, 'base.txt'), 'base line 1\nbase line 2\n');
  await git.add('.');
  await git.commit('base commit 2');
  await git.push(['origin', 'main']);
}

describe('RebaseWorker', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rebase-worker-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rebases a clean PR branch onto the updated base and pushes it', async () => {
    const remoteDir = await makeBareRemote(tmp);
    await seedRemote(remoteDir, join(tmp, 'seed'));

    const worker = createRebaseWorker({
      gitWorkdir: join(tmp, 'work'),
      getRemoteUrl: async () => remoteDir,
    });

    const result = await worker.rebasePR({ headRef: 'pr-branch', baseRef: 'main' });
    expect(result.outcome).toBe('success');

    const check = simpleGit(join(tmp, 'work'));
    const log = await check.log(['origin/pr-branch']);
    const baseLog = await check.log(['origin/main']);
    expect(log.all.some((entry) => entry.message === 'base commit 2')).toBe(true);
    expect(log.total).toBe(baseLog.total + 1);
  }, 15000);

  it('reports a conflict and leaves the remote branch untouched', async () => {
    const remoteDir = await makeBareRemote(tmp);
    const seedDir = join(tmp, 'seed');
    mkdirSync(seedDir);
    const git = simpleGit(seedDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    writeFileSync(join(seedDir, 'shared.txt'), 'line 1\n');
    await git.add('.');
    await git.commit('base commit 1');
    await git.branch(['-M', 'main']);
    await git.addRemote('origin', remoteDir);
    await git.push(['origin', 'main']);

    await git.checkoutBranch('pr-branch', 'main');
    writeFileSync(join(seedDir, 'shared.txt'), 'line 1\npr change\n');
    await git.add('.');
    await git.commit('pr commit');
    await git.push(['origin', 'pr-branch']);

    await git.checkout('main');
    writeFileSync(join(seedDir, 'shared.txt'), 'line 1\nconflicting base change\n');
    await git.add('.');
    await git.commit('base commit 2');
    await git.push(['origin', 'main']);

    const worker = createRebaseWorker({
      gitWorkdir: join(tmp, 'work'),
      getRemoteUrl: async () => remoteDir,
    });

    const result = await worker.rebasePR({ headRef: 'pr-branch', baseRef: 'main' });
    expect(result.outcome).toBe('conflict');

    const check = simpleGit(join(tmp, 'work'));
    const log = await check.log(['origin/pr-branch']);
    expect(log.all.some((entry) => entry.message === 'pr commit')).toBe(true);
    expect(log.all.some((entry) => entry.message === 'base commit 2')).toBe(false);
  }, 15000);
});
