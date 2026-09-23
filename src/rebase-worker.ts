import { existsSync, mkdirSync } from 'fs';
import simpleGit, { SimpleGit } from 'simple-git';

export type RebaseResult =
  | { outcome: 'success' }
  | { outcome: 'conflict' }
  | { outcome: 'transient-failure'; error: string };

export interface RebaseWorker {
  rebasePR(pr: { headRef: string; baseRef: string }): Promise<RebaseResult>;
}

export function createRebaseWorker(config: {
  gitWorkdir: string;
  getRemoteUrl: () => Promise<string>;
}): RebaseWorker {
  async function ensureRepo(): Promise<SimpleGit> {
    if (!existsSync(config.gitWorkdir)) {
      mkdirSync(config.gitWorkdir, { recursive: true });
      await simpleGit(config.gitWorkdir).init();
    }
    const git = simpleGit(config.gitWorkdir);
    await git.addConfig('user.name', 'auto-rebase-bot');
    await git.addConfig('user.email', 'auto-rebase-bot@users.noreply.github.com');
    const remoteUrl = await config.getRemoteUrl();
    const remotes = await git.getRemotes();
    if (remotes.some((r) => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', remoteUrl]);
    } else {
      await git.addRemote('origin', remoteUrl);
    }
    return git;
  }

  return {
    async rebasePR(pr: { headRef: string; baseRef: string }): Promise<RebaseResult> {
      const git = await ensureRepo();
      const tmpBranch = `auto-rebase/${pr.headRef}`;

      try {
        await git.fetch('origin', pr.baseRef);
        await git.fetch('origin', pr.headRef);
        await git.checkout(['-B', tmpBranch, `origin/${pr.headRef}`]);
      } catch (err) {
        return { outcome: 'transient-failure', error: String(err) };
      }

      try {
        await git.rebase([`origin/${pr.baseRef}`]);
      } catch (err) {
        const message = String(err);
        await git.rebase(['--abort']).catch(() => undefined);
        await git.checkout(['origin/' + pr.baseRef]).catch(() => undefined);
        await git.branch(['-D', tmpBranch]).catch(() => undefined);
        if (message.includes('CONFLICT')) {
          return { outcome: 'conflict' };
        }
        return { outcome: 'transient-failure', error: message };
      }

      try {
        await git.push(['origin', `${tmpBranch}:${pr.headRef}`, '--force-with-lease']);
      } catch (err) {
        return { outcome: 'transient-failure', error: String(err) };
      } finally {
        await git.checkout(['origin/' + pr.baseRef]).catch(() => undefined);
        await git.branch(['-D', tmpBranch]).catch(() => undefined);
      }

      return { outcome: 'success' };
    },
  };
}
