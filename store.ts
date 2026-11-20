// CoreForge's data store. Everything the forge serves — repositories, their git
// objects and refs, issues, pull requests, labels and comments — lives in memory
// in this one module. There is no database and no filesystem state: a trial is a
// single process, and the conformance suite only ever talks to the process it
// booted.
//
// Time is a logical clock. Timestamps must be non-empty strings and lists must
// order the way GitHub orders them, but nothing may depend on the wall clock
// (two runs of the suite must see the same shapes), so every stamp comes from a
// counter that starts at MAKEFUN_TRIAL_NOW when the env provides one and ticks
// forward one second per stamp. Ordering never relies on the stamps themselves:
// every record also carries a monotonically increasing sequence number.

import type { GitObject } from './gitobj.ts';

/** The one authenticated user: the token's owner, and every repo's owner. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The identity forge-created commits (contents API, merges) are authored by. */
export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  /** Record id (stable, unique across the forge). */
  id: number;
  /** Per-repository number, shared with pull requests as GitHub shares them. */
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head_ref: string;
  base_ref: string;
  head_sha: string;
  base_sha: string;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  /** Every git object the repository holds, by object id. */
  objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main) to the object id it points at. */
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  /** The next issue/pull number: one counter for both, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  seq: number;
  created_at: string;
  updated_at: string;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private repoSeq = 0;
  private recordSeq = 0;
  private orderSeq = 0;
  private clockSec: number;

  constructor() {
    const provided = Number(process.env.MAKEFUN_TRIAL_NOW);
    this.clockSec = Number.isFinite(provided) && provided > 0 ? Math.floor(provided) : 1_760_000_000;
  }

  /** The next logical timestamp as an ISO string. */
  tick(): string {
    this.clockSec += 1;
    return new Date(this.clockSec * 1000).toISOString();
  }

  /** The next logical timestamp as unix seconds (for git author lines). */
  tickSeconds(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  /** A global ordering sequence: bigger means created later. */
  nextSeq(): number {
    this.orderSeq += 1;
    return this.orderSeq;
  }

  /** A forge-wide unique record id. */
  nextRecordId(): number {
    this.recordSeq += 1;
    return this.recordSeq;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = this.tick();
    const repo: Repo = {
      id: (this.repoSeq += 1),
      owner,
      name,
      description,
      private: isPrivate,
      default_branch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextSeq(),
      created_at: now,
      updated_at: now,
    };
    this.repos.set(this.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER.login)
      .sort((a, b) => a.seq - b.seq);
  }
}

/** The single store instance the whole app shares. */
export const store = new Store();
