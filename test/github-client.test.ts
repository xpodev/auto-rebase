import { describe, it, expect, vi } from 'vitest';
import { createGitHubClient, mapNamedChecks, mapPullRequest, OctokitLike } from '../src/github-client';

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
      approved: false,
      ciStatus: 'pending',
      createdAt: '2026-02-01T12:00:00Z',
    });
  });

  it('sets approved from the given flag', () => {
    const record = mapPullRequest(
      {
        number: 42,
        head: { ref: 'feature-x', sha: 'deadbeef' },
        base: { ref: 'main' },
        draft: false,
        auto_merge: null,
        created_at: '2026-02-01T12:00:00Z',
      },
      true
    );

    expect(record.approved).toBe(true);
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

function fakeOctokit(
  overrides: Partial<OctokitLike['rest']> = {},
  graphql: OctokitLike['graphql'] = vi.fn().mockResolvedValue({ search: { nodes: [] } })
): OctokitLike {
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
    graphql,
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

  it('listOpenPRs marks PRs approved based on the batched GraphQL review decision', async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: {
        nodes: [
          { number: 1, reviewDecision: 'APPROVED' },
          { number: 2, reviewDecision: 'REVIEW_REQUIRED' },
        ],
      },
    });
    const octokit = fakeOctokit(
      {
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
              {
                number: 2,
                head: { ref: 'b', sha: 'sha-b' },
                base: { ref: 'main' },
                draft: false,
                auto_merge: null,
                created_at: '2026-01-01T00:00:00Z',
              },
            ],
          }),
        },
      } as any,
      graphql
    );

    const client = createGitHubClient('acme', 'widgets', octokit);
    const prs = await client.listOpenPRs();

    expect(prs.find((pr) => pr.number === 1)?.approved).toBe(true);
    expect(prs.find((pr) => pr.number === 2)?.approved).toBe(false);
    expect(graphql).toHaveBeenCalledWith(expect.any(String), {
      searchQuery: 'repo:acme/widgets is:pr is:open',
    });
  });

  it('listOpenPRs maps statusCheckRollup state into ciStatus, defaulting missing/unknown to pending', async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: {
        nodes: [
          {
            number: 1,
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          },
          {
            number: 2,
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
          },
          {
            number: 3,
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
          },
          {
            number: 4,
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
        ],
      },
    });
    const octokit = fakeOctokit(
      {
        pulls: {
          list: vi.fn().mockResolvedValue({
            data: [1, 2, 3, 4].map((number) => ({
              number,
              head: { ref: `pr-${number}`, sha: `sha-${number}` },
              base: { ref: 'main' },
              draft: false,
              auto_merge: null,
              created_at: '2026-01-01T00:00:00Z',
            })),
          }),
        },
      } as any,
      graphql
    );

    const client = createGitHubClient('acme', 'widgets', octokit);
    const prs = await client.listOpenPRs();

    expect(prs.find((pr) => pr.number === 1)?.ciStatus).toBe('passing');
    expect(prs.find((pr) => pr.number === 2)?.ciStatus).toBe('failing');
    expect(prs.find((pr) => pr.number === 3)?.ciStatus).toBe('pending');
    expect(prs.find((pr) => pr.number === 4)?.ciStatus).toBe('pending');
  });

  it('listOpenPRs uses only the configured CI checks when ciChecks is set', async () => {
    const contexts = {
      nodes: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'flaky-optional', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    };
    const graphql = vi.fn().mockResolvedValue({
      search: {
        nodes: [
          {
            number: 1,
            reviewDecision: 'APPROVED',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts } } }] },
          },
        ],
      },
    });
    const octokit = fakeOctokit(
      {
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
      } as any,
      graphql
    );

    const prs = await createGitHubClient('acme', 'widgets', octokit, ['build', 'lint']).listOpenPRs();
    expect(prs[0].ciStatus).toBe('passing');

    const allChecks = await createGitHubClient('acme', 'widgets', octokit).listOpenPRs();
    expect(allChecks[0].ciStatus).toBe('failing');
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

describe('mapNamedChecks', () => {
  const run = (name: string, status: string, conclusion: string | null = null) => ({
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
  });

  it('is passing only when every named check passed (neutral/skipped count as passed)', () => {
    expect(
      mapNamedChecks([run('a', 'COMPLETED', 'SUCCESS'), run('b', 'COMPLETED', 'SKIPPED')], ['a', 'b'])
    ).toBe('passing');
  });

  it('is failing when any named check failed, even if others are still running', () => {
    expect(
      mapNamedChecks(
        [run('a', 'IN_PROGRESS'), { __typename: 'StatusContext', context: 'b', state: 'ERROR' }],
        ['a', 'b']
      )
    ).toBe('failing');
    expect(mapNamedChecks([run('a', 'COMPLETED', 'TIMED_OUT')], ['a'])).toBe('failing');
  });

  it('is pending when a named check is missing or still running', () => {
    expect(mapNamedChecks([run('a', 'COMPLETED', 'SUCCESS')], ['a', 'b'])).toBe('pending');
    expect(mapNamedChecks([run('a', 'QUEUED'), null], ['a'])).toBe('pending');
  });
});
