import { createAppAuth } from '@octokit/auth-app';
import type { PRRecord, Config, CiStatus } from './types';

export interface RawPR {
  number: number;
  head: { ref: string; sha: string };
  base: { ref: string };
  draft?: boolean | null;
  auto_merge: unknown | null;
  created_at: string;
}

export interface ReviewDecisionSearchResult {
  search: {
    nodes: Array<{
      number?: number;
      reviewDecision?: string | null;
      commits?: {
        nodes: Array<{
          commit: {
            statusCheckRollup?: { state?: string | null } | null;
          };
        }>;
      };
    }>;
  };
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
  graphql: (query: string, variables?: Record<string, unknown>) => Promise<ReviewDecisionSearchResult>;
}

export interface GitHubClient {
  listOpenPRs(): Promise<PRRecord[]>;
  getBaseBranchHeadSha(branch: string): Promise<string>;
  commentOnPR(number: number, body: string): Promise<void>;
}

export function mapPullRequest(raw: RawPR, approved = false, ciStatus: CiStatus = 'pending'): PRRecord {
  return {
    number: raw.number,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
    isDraft: raw.draft === true,
    autoMergeEnabled: raw.auto_merge != null,
    approved,
    ciStatus,
    createdAt: raw.created_at,
  };
}

const REVIEW_DECISION_QUERY = `
  query($searchQuery: String!) {
    search(query: $searchQuery, type: ISSUE, first: 100) {
      nodes {
        ... on PullRequest {
          number
          reviewDecision
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

function mapRollupState(state: string | null | undefined): CiStatus {
  switch (state) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    default:
      // null (no checks reported yet), EXPECTED, or PENDING all mean "not
      // known to be broken" — give the benefit of the doubt.
      return 'pending';
  }
}

interface PRSignals {
  approved: boolean;
  ciStatus: CiStatus;
}

async function fetchPRSignals(
  octokit: OctokitLike,
  owner: string,
  repo: string
): Promise<Map<number, PRSignals>> {
  const result = await octokit.graphql(REVIEW_DECISION_QUERY, {
    searchQuery: `repo:${owner}/${repo} is:pr is:open`,
  });

  const signals = new Map<number, PRSignals>();
  for (const node of result.search.nodes) {
    if (node.number == null) continue;
    const rollupState = node.commits?.nodes[0]?.commit.statusCheckRollup?.state;
    signals.set(node.number, {
      approved: node.reviewDecision === 'APPROVED',
      ciStatus: mapRollupState(rollupState),
    });
  }
  return signals;
}

export function createGitHubClient(owner: string, repo: string, octokit: OctokitLike): GitHubClient {
  return {
    async listOpenPRs(): Promise<PRRecord[]> {
      const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: 100 });
      const signals = await fetchPRSignals(octokit, owner, repo);
      return data.map((raw) => {
        const prSignals = signals.get(raw.number);
        return mapPullRequest(raw, prSignals?.approved ?? false, prSignals?.ciStatus ?? 'pending');
      });
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
