import { createAppAuth } from '@octokit/auth-app';
import type { PRRecord, Config } from './types';

export interface RawPR {
  number: number;
  head: { ref: string; sha: string };
  base: { ref: string };
  draft: boolean | null;
  auto_merge: unknown | null;
  created_at: string;
}

export interface OctokitLike {
  rest: {
    pulls: {
      list: (params: {
        owner: string;
        repo: string;
        state: 'open';
        per_page: number;
      }) => Promise<{ data: RawPR[] }>;
    };
    repos: {
      getBranch: (params: {
        owner: string;
        repo: string;
        branch: string;
      }) => Promise<{ data: { commit: { sha: string } } }>;
    };
    issues: {
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
}

export interface GitHubClient {
  listOpenPRs(): Promise<PRRecord[]>;
  getBaseBranchHeadSha(branch: string): Promise<string>;
  commentOnPR(number: number, body: string): Promise<void>;
}

export function mapPullRequest(raw: RawPR): PRRecord {
  return {
    number: raw.number,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
    isDraft: raw.draft === true,
    autoMergeEnabled: raw.auto_merge != null,
    createdAt: raw.created_at,
  };
}

export function createGitHubClient(owner: string, repo: string, octokit: OctokitLike): GitHubClient {
  return {
    async listOpenPRs(): Promise<PRRecord[]> {
      const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: 100 });
      return data.map(mapPullRequest);
    },

    async getBaseBranchHeadSha(branch: string): Promise<string> {
      const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
      return data.commit.sha;
    },

    async commentOnPR(number: number, body: string): Promise<void> {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
    },
  };
}

export function createTokenProvider(config: Config): () => Promise<string> {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: config.installationId,
  });

  return async () => {
    const { token } = await auth({ type: 'installation' });
    return token;
  };
}
