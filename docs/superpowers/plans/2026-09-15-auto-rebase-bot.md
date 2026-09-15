# Auto-Rebase Queue Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Node.js/TypeScript service that polls a single GitHub repo and, each time a PR merges into the base branch, rebases exactly one other open PR — the highest-priority eligible one (auto-merge-enabled first, then oldest) — skipping drafts and cascading past conflicts.

**Architecture:** A poll loop (Orchestrator) calls a Reconciler to sync live GitHub PR state into a SQLite-backed queue table, then a Scheduler checks whether the base branch's HEAD moved since last time; if so it walks the priority-sorted queue, asking a Rebase Worker to `git rebase` + `push --force-with-lease` the top eligible PR, falling through to the next PR on conflict.

**Tech Stack:** TypeScript, Node.js 18+, `@octokit/rest` + `@octokit/auth-app` (GitHub App auth), `better-sqlite3`, `simple-git`, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-09-15-auto-rebase-bot-design.md`

## Global Constraints

- Single repo, single base branch — no multi-repo support.
- Draft PRs are never rebased and never enter the eligible queue.
- Exactly one rebase (one force-push) per detected base-branch-HEAD change, never one per queued PR.
- Priority order: `auto_merge_enabled DESC, created_at ASC`.
- Conflicts never block the queue: skip, comment, try the next eligible PR.
- TypeScript strict mode; Node.js 18+.
- No webhook receiver — polling only, on `POLL_INTERVAL_MS` (default 60000).

---

### Task 1: Project scaffolding, shared types, and config loading

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PRRecord`, `PRStatus`, `PRRow`, `Config` types in `src/types.ts`; `loadConfig(env?: NodeJS.ProcessEnv): Config` in `src/config.ts`. Every later task imports these.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "auto-rebase-bot",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@octokit/auth-app": "^7.1.0",
    "@octokit/rest": "^21.0.2",
    "better-sqlite3": "^11.3.0",
    "simple-git": "^3.27.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.7.4",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
*.db
.env
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 5: Create `src/types.ts`**

```typescript
export interface PRRecord {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  isDraft: boolean;
  autoMergeEnabled: boolean;
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
```

- [ ] **Step 6: Write the failing test for config loading**

Create `test/config.test.ts`:

```typescript
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
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `src/config.ts` does not exist yet.

- [ ] **Step 8: Implement `src/config.ts`**

```typescript
import type { Config } from './types';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repo = required(env, 'GITHUB_REPO');
  const [repoOwner, repoName] = repo.split('/');
  if (!repoOwner || !repoName) {
    throw new Error(`GITHUB_REPO must be in "owner/repo" format, got: ${repo}`);
  }

  return {
    appId: required(env, 'GITHUB_APP_ID'),
    privateKey: required(env, 'GITHUB_APP_PRIVATE_KEY'),
    installationId: Number(required(env, 'GITHUB_APP_INSTALLATION_ID')),
    repoOwner,
    repoName,
    baseBranch: env.BASE_BRANCH ?? 'main',
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? '60000'),
    gitWorkdir: env.GIT_WORKDIR ?? '.git-workdir',
    dbPath: env.DB_PATH ?? './pr-queue.db',
  };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json .gitignore src/types.ts src/config.ts test/config.test.ts package-lock.json
git commit -m "feat: scaffold project, shared types, and config loading"
```

---

### Task 2: SQLite-backed Store

**Files:**
- Create: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `PRRecord`, `PRRow`, `PRStatus` from `src/types.ts` (Task 1).
- Produces: `Store` interface and `createStore(dbPath: string, baseBranch: string): Store` in `src/store.ts`, with methods `upsertPR`, `deleteMissing`, `setStatus`, `listQueued`, `resetStuckRebasing`, `getLastProcessedBaseSha`, `setLastProcessedBaseSha`, `close`. Every later task that touches persistence uses this exact interface.

- [ ] **Step 1: Write the failing tests**

Create `test/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore, Store } from '../src/store';
import type { PRRecord } from '../src/types';

function pr(overrides: Partial<PRRecord>): PRRecord {
  return {
    number: 1,
    headRef: 'feature-1',
    headSha: 'sha1',
    baseRef: 'main',
    isDraft: false,
    autoMergeEnabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
  });

  it('inserts a new PR as queued', () => {
    store.upsertPR(pr({ number: 1 }));
    const queued = store.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0].number).toBe(1);
    expect(queued[0].status).toBe('queued');
  });

  it('orders queued PRs by auto-merge first, then created_at ascending', () => {
    store.upsertPR(pr({ number: 1, createdAt: '2026-01-02T00:00:00Z', autoMergeEnabled: false }));
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-01T00:00:00Z', autoMergeEnabled: false }));
    store.upsertPR(pr({ number: 3, createdAt: '2026-01-03T00:00:00Z', autoMergeEnabled: true }));

    const order = store.listQueued().map((row) => row.number);
    expect(order).toEqual([3, 2, 1]);
  });

  it('excludes draft PRs from listQueued', () => {
    store.upsertPR(pr({ number: 1, isDraft: true }));
    expect(store.listQueued()).toHaveLength(0);
  });

  it('excludes conflicted PRs from listQueued', () => {
    store.upsertPR(pr({ number: 1 }));
    store.setStatus(1, 'conflicted');
    expect(store.listQueued()).toHaveLength(0);
  });

  it('resets conflicted status back to queued when head_sha changes on upsert', () => {
    store.upsertPR(pr({ number: 1, headSha: 'sha1' }));
    store.setStatus(1, 'conflicted');
    store.upsertPR(pr({ number: 1, headSha: 'sha2' }));
    const queued = store.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0].headSha).toBe('sha2');
  });

  it('keeps conflicted status when head_sha is unchanged on upsert', () => {
    store.upsertPR(pr({ number: 1, headSha: 'sha1' }));
    store.setStatus(1, 'conflicted');
    store.upsertPR(pr({ number: 1, headSha: 'sha1' }));
    expect(store.listQueued()).toHaveLength(0);
  });

  it('deletes rows missing from the given open-PR-number list', () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    store.deleteMissing([2]);
    const order = store.listQueued().map((row) => row.number);
    expect(order).toEqual([2]);
  });

  it('resets rows stuck in rebasing back to queued', () => {
    store.upsertPR(pr({ number: 1 }));
    store.setStatus(1, 'rebasing');
    store.resetStuckRebasing();
    expect(store.listQueued()).toHaveLength(1);
  });

  it('tracks last processed base sha, defaulting to null', () => {
    expect(store.getLastProcessedBaseSha()).toBeNull();
    store.setLastProcessedBaseSha('abc123');
    expect(store.getLastProcessedBaseSha()).toBe('abc123');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — `src/store.ts` does not exist yet.

- [ ] **Step 3: Implement `src/store.ts`**

```typescript
import Database from 'better-sqlite3';
import type { PRRecord, PRRow, PRStatus } from './types';

export interface Store {
  upsertPR(pr: PRRecord): void;
  deleteMissing(openNumbers: number[]): void;
  setStatus(number: number, status: PRStatus): void;
  listQueued(): PRRow[];
  resetStuckRebasing(): void;
  getLastProcessedBaseSha(): string | null;
  setLastProcessedBaseSha(sha: string): void;
  close(): void;
}

interface PRRowSql {
  number: number;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  is_draft: number;
  auto_merge_enabled: number;
  created_at: string;
  status: PRStatus;
  updated_at: string;
}

function toPRRow(row: PRRowSql): PRRow {
  return {
    number: row.number,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    isDraft: row.is_draft === 1,
    autoMergeEnabled: row.auto_merge_enabled === 1,
    createdAt: row.created_at,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function createStore(dbPath: string, baseBranch: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_queue (
      number              INTEGER PRIMARY KEY,
      head_ref            TEXT NOT NULL,
      head_sha            TEXT NOT NULL,
      base_ref            TEXT NOT NULL,
      is_draft            INTEGER NOT NULL,
      auto_merge_enabled  INTEGER NOT NULL,
      created_at          TEXT NOT NULL,
      status              TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      base_branch              TEXT NOT NULL,
      last_processed_base_sha  TEXT
    );
  `);

  db.prepare(
    `INSERT OR IGNORE INTO repo_state (id, base_branch, last_processed_base_sha) VALUES (1, ?, NULL)`
  ).run(baseBranch);

  const getExistingStatusAndSha = db.prepare(
    `SELECT status, head_sha FROM pr_queue WHERE number = ?`
  );
  const insertOrReplace = db.prepare(`
    INSERT INTO pr_queue (number, head_ref, head_sha, base_ref, is_draft, auto_merge_enabled, created_at, status, updated_at)
    VALUES (@number, @headRef, @headSha, @baseRef, @isDraft, @autoMergeEnabled, @createdAt, @status, @updatedAt)
    ON CONFLICT(number) DO UPDATE SET
      head_ref = excluded.head_ref,
      head_sha = excluded.head_sha,
      base_ref = excluded.base_ref,
      is_draft = excluded.is_draft,
      auto_merge_enabled = excluded.auto_merge_enabled,
      created_at = excluded.created_at,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);

  return {
    upsertPR(pr: PRRecord): void {
      const existing = getExistingStatusAndSha.get(pr.number) as
        | { status: PRStatus; head_sha: string }
        | undefined;

      let status: PRStatus = existing?.status ?? 'queued';
      if (existing?.status === 'conflicted' && existing.head_sha !== pr.headSha) {
        status = 'queued';
      }

      insertOrReplace.run({
        number: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        isDraft: pr.isDraft ? 1 : 0,
        autoMergeEnabled: pr.autoMergeEnabled ? 1 : 0,
        createdAt: pr.createdAt,
        status,
        updatedAt: new Date().toISOString(),
      });
    },

    deleteMissing(openNumbers: number[]): void {
      const placeholders = openNumbers.length > 0 ? openNumbers.map(() => '?').join(',') : 'NULL';
      db.prepare(`DELETE FROM pr_queue WHERE number NOT IN (${placeholders})`).run(...openNumbers);
    },

    setStatus(number: number, status: PRStatus): void {
      db.prepare(`UPDATE pr_queue SET status = ?, updated_at = ? WHERE number = ?`).run(
        status,
        new Date().toISOString(),
        number
      );
    },

    listQueued(): PRRow[] {
      const rows = db
        .prepare(
          `SELECT * FROM pr_queue WHERE status = 'queued' AND is_draft = 0
           ORDER BY auto_merge_enabled DESC, created_at ASC`
        )
        .all() as PRRowSql[];
      return rows.map(toPRRow);
    },

    resetStuckRebasing(): void {
      db.prepare(`UPDATE pr_queue SET status = 'queued', updated_at = ? WHERE status = 'rebasing'`).run(
        new Date().toISOString()
      );
    },

    getLastProcessedBaseSha(): string | null {
      const row = db.prepare(`SELECT last_processed_base_sha FROM repo_state WHERE id = 1`).get() as
        | { last_processed_base_sha: string | null }
        | undefined;
      return row?.last_processed_base_sha ?? null;
    },

    setLastProcessedBaseSha(sha: string): void {
      db.prepare(`UPDATE repo_state SET last_processed_base_sha = ? WHERE id = 1`).run(sha);
    },

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: add SQLite-backed PR queue store"
```

---

### Task 3: GitHub Client

**Files:**
- Create: `src/github-client.ts`
- Test: `test/github-client.test.ts`

**Interfaces:**
- Consumes: `PRRecord` from `src/types.ts` (Task 1).
- Produces: `GitHubClient` interface, `createGitHubClient(owner: string, repo: string, octokit: OctokitLike): GitHubClient`, `mapPullRequest(raw: RawPR): PRRecord`, `OctokitLike`, `createTokenProvider(config: Config): () => Promise<string>` in `src/github-client.ts`. `GitHubClient.listOpenPRs()`, `.getBaseBranchHeadSha(branch)`, `.commentOnPR(number, body)` are consumed by the Reconciler (Task 4) and Scheduler (Task 6). `createTokenProvider` is consumed by the entrypoint (Task 7) to build the git remote URL.

- [ ] **Step 1: Write the failing tests**

Create `test/github-client.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/github-client.test.ts`
Expected: FAIL — `src/github-client.ts` does not exist yet.

- [ ] **Step 3: Implement `src/github-client.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/github-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/github-client.ts test/github-client.test.ts
git commit -m "feat: add GitHub client wrapper with injectable Octokit"
```

---

### Task 4: Reconciler

**Files:**
- Create: `src/reconciler.ts`
- Test: `test/reconciler.test.ts`

**Interfaces:**
- Consumes: `GitHubClient.listOpenPRs()` (Task 3), `Store.upsertPR` / `Store.deleteMissing` (Task 2).
- Produces: `reconcile(client: GitHubClient, store: Store): Promise<void>` in `src/reconciler.ts`, consumed by the Orchestrator (Task 7).

- [ ] **Step 1: Write the failing test**

Create `test/reconciler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconcile } from '../src/reconciler';
import { createStore, Store } from '../src/store';
import type { GitHubClient } from '../src/github-client';
import type { PRRecord } from '../src/types';

function pr(overrides: Partial<PRRecord>): PRRecord {
  return {
    number: 1,
    headRef: 'feature-1',
    headSha: 'sha1',
    baseRef: 'main',
    isDraft: false,
    autoMergeEnabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function fakeClient(prs: PRRecord[]): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue(prs),
    getBaseBranchHeadSha: vi.fn(),
    commentOnPR: vi.fn(),
  };
}

describe('reconcile', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
  });

  it('adds newly seen open PRs to the store', async () => {
    const client = fakeClient([pr({ number: 1 }), pr({ number: 2 })]);
    await reconcile(client, store);
    const numbers = store.listQueued().map((row) => row.number);
    expect(numbers.sort()).toEqual([1, 2]);
  });

  it('removes PRs no longer reported as open', async () => {
    store.upsertPR(pr({ number: 1 }));
    store.upsertPR(pr({ number: 2 }));
    const client = fakeClient([pr({ number: 2 })]);
    await reconcile(client, store);
    const numbers = store.listQueued().map((row) => row.number);
    expect(numbers).toEqual([2]);
  });

  it('refreshes head_sha for an existing PR', async () => {
    store.upsertPR(pr({ number: 1, headSha: 'old-sha' }));
    const client = fakeClient([pr({ number: 1, headSha: 'new-sha' })]);
    await reconcile(client, store);
    const [row] = store.listQueued();
    expect(row.headSha).toBe('new-sha');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reconciler.test.ts`
Expected: FAIL — `src/reconciler.ts` does not exist yet.

- [ ] **Step 3: Implement `src/reconciler.ts`**

```typescript
import type { GitHubClient } from './github-client';
import type { Store } from './store';

export async function reconcile(client: GitHubClient, store: Store): Promise<void> {
  const openPRs = await client.listOpenPRs();
  for (const pr of openPRs) {
    store.upsertPR(pr);
  }
  store.deleteMissing(openPRs.map((pr) => pr.number));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reconciler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reconciler.ts test/reconciler.test.ts
git commit -m "feat: add reconciler to sync PR queue with live GitHub state"
```

---

### Task 5: Rebase Worker

**Files:**
- Create: `src/rebase-worker.ts`
- Test: `test/rebase-worker.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except plain `{ headRef: string; baseRef: string }` shape (structurally compatible with `PRRow` from Task 1).
- Produces: `RebaseResult`, `RebaseWorker`, `createRebaseWorker(config: { gitWorkdir: string; getRemoteUrl: () => Promise<string> }): RebaseWorker` in `src/rebase-worker.ts`, consumed by the Scheduler (Task 6).

- [ ] **Step 1: Write the failing tests**

These tests operate entirely on local temp git repos — no network, no GitHub.

Create `test/rebase-worker.test.ts`:

```typescript
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
  });

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
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/rebase-worker.test.ts`
Expected: FAIL — `src/rebase-worker.ts` does not exist yet.

- [ ] **Step 3: Implement `src/rebase-worker.ts`**

```typescript
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
      } catch {
        await git.rebase(['--abort']).catch(() => undefined);
        await git.checkout(['main']).catch(() => undefined);
        await git.branch(['-D', tmpBranch]).catch(() => undefined);
        return { outcome: 'conflict' };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/rebase-worker.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rebase-worker.ts test/rebase-worker.test.ts
git commit -m "feat: add rebase worker with force-with-lease push and conflict detection"
```

---

### Task 6: Scheduler

**Files:**
- Create: `src/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `Store.listQueued/setStatus/getLastProcessedBaseSha/setLastProcessedBaseSha` (Task 2), `GitHubClient.getBaseBranchHeadSha/commentOnPR` (Task 3), `RebaseWorker.rebasePR` (Task 5).
- Produces: `buildConflictComment(baseRef: string): string` and `runSchedulerTick(store: Store, client: GitHubClient, worker: RebaseWorker, baseBranch: string): Promise<{ attempted: boolean }>` in `src/scheduler.ts`, consumed by the Orchestrator (Task 7).

- [ ] **Step 1: Write the failing tests**

Create `test/scheduler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runSchedulerTick, buildConflictComment } from '../src/scheduler';
import { createStore, Store } from '../src/store';
import type { GitHubClient } from '../src/github-client';
import type { RebaseWorker, RebaseResult } from '../src/rebase-worker';
import type { PRRecord } from '../src/types';

function pr(overrides: Partial<PRRecord>): PRRecord {
  return {
    number: 1,
    headRef: 'feature-1',
    headSha: 'sha1',
    baseRef: 'main',
    isDraft: false,
    autoMergeEnabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function fakeClient(baseSha: string): GitHubClient {
  return {
    listOpenPRs: vi.fn(),
    getBaseBranchHeadSha: vi.fn().mockResolvedValue(baseSha),
    commentOnPR: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeWorker(results: RebaseResult[]): RebaseWorker {
  let call = 0;
  return {
    rebasePR: vi.fn().mockImplementation(async () => results[call++]),
  };
}

describe('runSchedulerTick', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
  });

  it('does nothing when the base branch sha has not changed', async () => {
    store.setLastProcessedBaseSha('sha-a');
    store.upsertPR(pr({ number: 1 }));
    const client = fakeClient('sha-a');
    const worker = fakeWorker([]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(false);
    expect(worker.rebasePR).not.toHaveBeenCalled();
  });

  it('rebases the single highest-priority PR when the base sha changed', async () => {
    store.setLastProcessedBaseSha('sha-a');
    store.upsertPR(pr({ number: 1, createdAt: '2026-01-02T00:00:00Z' }));
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-01T00:00:00Z' }));
    const client = fakeClient('sha-b');
    const worker = fakeWorker([{ outcome: 'success' }]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(true);
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);
    expect(worker.rebasePR).toHaveBeenCalledWith({ headRef: 'feature-1', baseRef: 'main' });
    expect(store.getLastProcessedBaseSha()).toBe('sha-b');
  });

  it('cascades to the next PR and comments when the first conflicts', async () => {
    store.setLastProcessedBaseSha('sha-a');
    store.upsertPR(pr({ number: 1, createdAt: '2026-01-01T00:00:00Z' }));
    store.upsertPR(pr({ number: 2, createdAt: '2026-01-02T00:00:00Z' }));
    const client = fakeClient('sha-b');
    const worker = fakeWorker([{ outcome: 'conflict' }, { outcome: 'success' }]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(true);
    expect(worker.rebasePR).toHaveBeenCalledTimes(2);
    expect(client.commentOnPR).toHaveBeenCalledWith(1, buildConflictComment('main'));

    const rows = store.listQueued().map((row) => row.number);
    expect(rows).toEqual([2]);
  });

  it('marks last processed sha even when the queue is empty', async () => {
    store.setLastProcessedBaseSha('sha-a');
    const client = fakeClient('sha-b');
    const worker = fakeWorker([]);

    const result = await runSchedulerTick(store, client, worker, 'main');

    expect(result.attempted).toBe(false);
    expect(store.getLastProcessedBaseSha()).toBe('sha-b');
  });
});

describe('buildConflictComment', () => {
  it('mentions the base ref and manual resolution', () => {
    const comment = buildConflictComment('main');
    expect(comment).toContain('main');
    expect(comment).toContain('conflict');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts`
Expected: FAIL — `src/scheduler.ts` does not exist yet.

- [ ] **Step 3: Implement `src/scheduler.ts`**

```typescript
import type { Store } from './store';
import type { GitHubClient } from './github-client';
import type { RebaseWorker } from './rebase-worker';

export function buildConflictComment(baseRef: string): string {
  return (
    `This PR could not be automatically rebased onto the latest \`${baseRef}\` due to a merge conflict. ` +
    `Please resolve the conflict manually (for example, \`git rebase origin/${baseRef}\`) and push the result.`
  );
}

export async function runSchedulerTick(
  store: Store,
  client: GitHubClient,
  worker: RebaseWorker,
  baseBranch: string
): Promise<{ attempted: boolean }> {
  const currentBaseSha = await client.getBaseBranchHeadSha(baseBranch);
  const lastProcessed = store.getLastProcessedBaseSha();

  if (currentBaseSha === lastProcessed) {
    return { attempted: false };
  }

  const queue = store.listQueued();

  for (const candidate of queue) {
    store.setStatus(candidate.number, 'rebasing');
    const result = await worker.rebasePR({ headRef: candidate.headRef, baseRef: candidate.baseRef });

    if (result.outcome === 'success') {
      store.setStatus(candidate.number, 'queued');
      store.setLastProcessedBaseSha(currentBaseSha);
      return { attempted: true };
    }

    if (result.outcome === 'conflict') {
      store.setStatus(candidate.number, 'conflicted');
      await client.commentOnPR(candidate.number, buildConflictComment(candidate.baseRef));
      continue;
    }

    store.setStatus(candidate.number, 'queued');
  }

  store.setLastProcessedBaseSha(currentBaseSha);
  return { attempted: queue.length > 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/scheduler.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/scheduler.test.ts
git commit -m "feat: add scheduler with priority queue walk and conflict cascade"
```

---

### Task 7: Orchestrator and entrypoint

**Files:**
- Create: `src/orchestrator.ts`
- Create: `src/index.ts`
- Create: `README.md`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `reconcile` (Task 4), `runSchedulerTick` (Task 6), `Store` (Task 2), `GitHubClient` + `createTokenProvider` (Task 3), `RebaseWorker` (Task 5), `loadConfig` (Task 1).
- Produces: `startOrchestrator(deps): { stop: () => void }` in `src/orchestrator.ts`; a runnable `src/index.ts` entrypoint. Nothing downstream consumes these — this is the final integration task.

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';
import { createStore, Store } from '../src/store';
import type { GitHubClient } from '../src/github-client';
import type { RebaseWorker } from '../src/rebase-worker';
import type { PRRecord } from '../src/types';

function pr(overrides: Partial<PRRecord>): PRRecord {
  return {
    number: 1,
    headRef: 'feature-1',
    headSha: 'sha1',
    baseRef: 'main',
    isDraft: false,
    autoMergeEnabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('startOrchestrator', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStore(':memory:', 'main');
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('reconciles and schedules on an immediate tick, then again each interval', async () => {
    let baseSha = 'sha-a';
    const client: GitHubClient = {
      listOpenPRs: vi.fn().mockResolvedValue([pr({ number: 1 })]),
      getBaseBranchHeadSha: vi.fn().mockImplementation(async () => baseSha),
      commentOnPR: vi.fn(),
    };
    const worker: RebaseWorker = {
      rebasePR: vi.fn().mockResolvedValue({ outcome: 'success' }),
    };

    const handle = startOrchestrator({
      store,
      client,
      worker,
      baseBranch: 'main',
      pollIntervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.listOpenPRs).toHaveBeenCalledTimes(1);
    expect(worker.rebasePR).toHaveBeenCalledTimes(0); // sha unchanged from initial null -> triggers once
    expect(store.getLastProcessedBaseSha()).toBe('sha-a');

    baseSha = 'sha-b';
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.listOpenPRs).toHaveBeenCalledTimes(2);
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);

    handle.stop();
    baseSha = 'sha-c';
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.listOpenPRs).toHaveBeenCalledTimes(2);
  });
});
```

Note: on the very first tick `lastProcessedBaseSha` is `null` and `getBaseBranchHeadSha` returns `'sha-a'`, which differ, so the scheduler *will* attempt the queue on tick one too. Adjust the test's second assertion to match actual behavior before moving on — this is expected and checked in the next step.

- [ ] **Step 2: Run test, observe actual first-tick behavior, and correct the assertion**

Run: `npx vitest run test/orchestrator.test.ts`

Expected: it fails first because `src/orchestrator.ts` doesn't exist. After implementing Step 3 below, run again and read the actual call count for `worker.rebasePR` on the first tick. Since `getLastProcessedBaseSha()` starts as `null` and the live sha is `'sha-a'`, the first tick *will* trigger one rebase attempt. Update the test's first block to:

```typescript
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listOpenPRs).toHaveBeenCalledTimes(1);
    expect(worker.rebasePR).toHaveBeenCalledTimes(1);
    expect(store.getLastProcessedBaseSha()).toBe('sha-a');
```

- [ ] **Step 3: Implement `src/orchestrator.ts`**

```typescript
import { reconcile } from './reconciler';
import { runSchedulerTick } from './scheduler';
import type { Store } from './store';
import type { GitHubClient } from './github-client';
import type { RebaseWorker } from './rebase-worker';

export function startOrchestrator(deps: {
  store: Store;
  client: GitHubClient;
  worker: RebaseWorker;
  baseBranch: string;
  pollIntervalMs: number;
}): { stop: () => void } {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await reconcile(deps.client, deps.store);
      const result = await runSchedulerTick(deps.store, deps.client, deps.worker, deps.baseBranch);
      if (result.attempted) {
        console.log('[auto-rebase] rebase cascade attempted for latest base-branch change');
      }
    } catch (err) {
      console.error('[auto-rebase] poll tick failed:', err);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.pollIntervalMs);

  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/orchestrator.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Implement `src/index.ts`**

```typescript
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { loadConfig } from './config';
import { createStore } from './store';
import { createGitHubClient, createTokenProvider } from './github-client';
import { createRebaseWorker } from './rebase-worker';
import { startOrchestrator } from './orchestrator';

function main(): void {
  const config = loadConfig();

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  });

  const client = createGitHubClient(config.repoOwner, config.repoName, octokit);
  const store = createStore(config.dbPath, config.baseBranch);
  store.resetStuckRebasing();

  const getToken = createTokenProvider(config);
  const worker = createRebaseWorker({
    gitWorkdir: config.gitWorkdir,
    getRemoteUrl: async () => {
      const token = await getToken();
      return `https://x-access-token:${token}@github.com/${config.repoOwner}/${config.repoName}.git`;
    },
  });

  const handle = startOrchestrator({
    store,
    client,
    worker,
    baseBranch: config.baseBranch,
    pollIntervalMs: config.pollIntervalMs,
  });

  const shutdown = (): void => {
    handle.stop();
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `[auto-rebase] watching ${config.repoOwner}/${config.repoName}@${config.baseBranch}, polling every ${config.pollIntervalMs}ms`
  );
}

main();
```

- [ ] **Step 6: Build and smoke-test the entrypoint**

Run: `npm run build`
Expected: compiles with no errors, produces `dist/index.js`.

Run (with placeholder env vars, expect it to start and then fail cleanly on the first real API call — this just verifies wiring, not live GitHub behavior):

```bash
GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY="$(printf '%s' 'placeholder')" GITHUB_APP_INSTALLATION_ID=1 GITHUB_REPO=acme/widgets node dist/index.js
```

Expected: prints the `watching acme/widgets@main` log line, then logs a poll-tick failure (invalid credentials) rather than crashing the process — press Ctrl+C to stop it.

- [ ] **Step 7: Write `README.md`**

```markdown
# auto-rebase-bot

Polls a single GitHub repo and, each time a PR merges into the base branch,
rebases exactly one other open PR — the highest-priority eligible one — onto
the new base. Priority: PRs with auto-merge enabled first, then oldest first.
Draft PRs are never touched. Conflicts are skipped (with a PR comment) rather
than blocking the rest of the queue.

See `docs/superpowers/specs/2026-09-15-auto-rebase-bot-design.md` for the full
design.

## Setup

1. Create a GitHub App on the target repo with permissions: `Pull requests:
   Read & write`, `Contents: Read & write`, `Commit statuses: Read` (if
   branch protection requires status checks to re-run, no extra permission is
   needed — pushes trigger CI normally).
2. Install the app on the repo and note the installation ID.
3. Set environment variables:

   | Variable                     | Required | Default          |
   |-------------------------------|----------|------------------|
   | `GITHUB_APP_ID`               | yes      | —                |
   | `GITHUB_APP_PRIVATE_KEY`      | yes      | —                |
   | `GITHUB_APP_INSTALLATION_ID`  | yes      | —                |
   | `GITHUB_REPO`                 | yes      | — (`owner/repo`) |
   | `BASE_BRANCH`                 | no       | `main`           |
   | `POLL_INTERVAL_MS`            | no       | `60000`          |
   | `GIT_WORKDIR`                 | no       | `.git-workdir`   |
   | `DB_PATH`                     | no       | `./pr-queue.db`  |

4. `npm install && npm run build && npm start`

## Development

- `npm test` — unit + local-git integration tests (no network required).
- Manual end-to-end verification against a real repo/App installation is a
  separate manual runbook, not part of automated CI (see spec's Testing
  Strategy section).
```

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts src/index.ts test/orchestrator.test.ts README.md
git commit -m "feat: add orchestrator, entrypoint, and setup docs"
```

---

## Post-plan self-review notes

- Spec coverage: architecture/components → Tasks 1-7; data model → Task 2;
  state machine + crash recovery → Task 2 (`resetStuckRebasing`) + Task 6;
  error handling (API errors, git failures, conflicts, force-with-lease
  rejection) → Tasks 5-7; testing strategy (unit/integration/manual E2E) →
  every task's test step + README note. All spec sections are covered.
- No placeholders: every step has runnable code; no "TBD"/"similar to Task N".
- Type consistency checked: `PRRecord`/`PRRow`/`PRStatus`/`Config` (Task 1) are
  used with identical shapes in Store (Task 2), GitHubClient (Task 3),
  Reconciler (Task 4), RebaseWorker (Task 5), Scheduler (Task 6), and
  Orchestrator/index (Task 7).
