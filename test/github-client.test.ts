import { describe, it, expect, vi } from 'vitest';
import { createGitHubClient, mapPullRequest, OctokitLike } from '../src/github-client';

describe('mapPullRequest', () => {
  it('maps a raw Octokit PR into a PRRecord', () => {
    const record = mapPullRequest({
      number: 42,
      head: { ref: 'feature-x', sha: 'deadbeef' },
      base: { ref: 'main' },
      draft: false,
      auto_merge: null,
      created_at: '2026-02-01T12:00:00Z',
    });

    expect(record).toEqual({
      number: 42,
      headRef: 'feature-x',
      headSha: 'deadbeef',
      baseRef: 'main',
      isDraft: false,
      autoMergeEnabled: false,
      createdAt: '2026-02-01T12:00:00Z',
    });
  });

  it('treats a non-null auto_merge as enabled, and null draft as false', () => {
    const record = mapPullRequest({
      number: 7,
      head: { ref: 'x', sha: 'y' },
      base: { ref: 'main' },
      draft: null,
      auto_merge: { enabled_by: { login: 'someone' } },
      created_at: '2026-02-01T12:00:00Z',
    });

    expect(record.isDraft).toBe(false);
    expect(record.autoMergeEnabled).toBe(true);
  });
});

function fakeOctokit(overrides: Partial<OctokitLike['rest']> = {}): OctokitLike {
  return {
    rest: {
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        getBranch: vi.fn().mockResolvedValue({ data: { commit: { sha: 'base-sha' } } }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
      ...overrides,
    },
  } as unknown as OctokitLike;
}

describe('GitHubClient', () => {
  it('listOpenPRs maps and returns all open PRs', async () => {
    const octokit = fakeOctokit({
      pulls: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              number: 1,
              head: { ref: 'a', sha: 'sha-a' },
              base: { ref: 'main' },
              draft: false,
              auto_merge: null,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
    } as any);

    const client = createGitHubClient('acme', 'widgets', octokit);
    const prs = await client.listOpenPRs();

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(1);
    expect(octokit.rest.pulls.list).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      state: 'open',
      per_page: 100,
    });
  });

  it('getBaseBranchHeadSha returns the branch commit sha', async () => {
    const octokit = fakeOctokit();
    const client = createGitHubClient('acme', 'widgets', octokit);
    const sha = await client.getBaseBranchHeadSha('main');
    expect(sha).toBe('base-sha');
    expect(octokit.rest.repos.getBranch).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
    });
  });

  it('commentOnPR posts an issue comment', async () => {
    const octokit = fakeOctokit();
    const client = createGitHubClient('acme', 'widgets', octokit);
    await client.commentOnPR(5, 'hello');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 5,
      body: 'hello',
    });
  });
});
