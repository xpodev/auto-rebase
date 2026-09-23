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

export type PRStatus = 'queued' | 'rebasing' | 'conflicted';

export interface PRRow extends PRRecord {
  status: PRStatus;
  updatedAt: string;
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
}
