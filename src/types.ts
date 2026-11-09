import type { PriorityTier } from './priority';

export type CiStatus = 'passing' | 'pending' | 'failing';

export interface PRRecord {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  isDraft: boolean;
  autoMergeEnabled: boolean;
  approved: boolean;
  ciStatus: CiStatus;
  createdAt: string; // ISO 8601
}

// 'conflicted' and 'stale' are both cleared when the author pushes a new commit.
export type PRStatus = 'queued' | 'rebasing' | 'conflicted' | 'stale';

export interface PRRow extends PRRecord {
  status: PRStatus;
  updatedAt: string;
}

// The single PR the bot is currently shepherding toward merge.
export interface Tracking {
  number: number;
  since: string; // ISO 8601 — when tracking started; drives the stale timeout
  baseSha: string; // base-branch sha the PR was last rebased onto
  ciPassed: boolean; // CI was seen passing while tracked (survives the re-run our rebase triggers)
}

export interface Config {
  appId: string;
  privateKey: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  pollIntervalMs: number;
  gitWorkdir: string;
  dbPath: string;
  priorityOrder: PriorityTier[];
  ciChecks: string[];
  staleAfterMs: number | null;
}
