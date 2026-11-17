import type {
  GitObject,
  GitObjectType,
  TreeEntry,
} from './git.ts';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  buildCommit,
  buildTree,
} from './git.ts';

export interface Repository {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  hasIssuesEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // ref -> oid, e.g. "refs/heads/main" -> oid
  headSymref: string; // e.g. "refs/heads/main"
}

export interface Label {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description?: string;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: string;
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  baseSha: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export class ForgeStore {
  readonly repos = new Map<string, Repository>(); // "owner/repo" -> Repository
  readonly issues = new Map<string, Issue[]>(); // "owner/repo" -> Issue[]
  readonly labels = new Map<string, Label[]>(); // "owner/repo" -> Label[]
  readonly pulls = new Map<string, PullRequest[]>(); // "owner/repo" -> PullRequest[]
  
  // The scenario viewer user is 'adaiversen'
  viewerLogin = 'adaiversen';

  private nextRepoId = 1000;
  private nextIssueId = 2000;
  private nextLabelId = 3000;
  private nextCommentId = 4000;
  private nextPullId = 5000;

  getRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  createRepo(owner: string, name: string, description = '', isPrivate = false): Repository {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const id = this.nextRepoId++;
    const repo: Repository = {
      id,
      nodeId: Buffer.from(`Repository:${id}`).toString('base64'),
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      hasIssuesEnabled: true,
      createdAt: '2026-11-14T06:30:00Z',
      updatedAt: '2026-11-14T06:30:00Z',
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      headSymref: 'refs/heads/main',
    };
    this.repos.set(key, repo);
    this.issues.set(key, []);
    this.labels.set(key, []);
    this.pulls.set(key, []);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const existed = this.repos.delete(key);
    this.issues.delete(key);
    this.labels.delete(key);
    this.pulls.delete(key);
    return existed;
  }

  // Reachable objects collector from roots
  collectReachable(repo: Repository, roots: Iterable<string>, allowMissing = false): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const r of roots) {
      if (r && r !== ZERO_OID) queue.push(r);
    }
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) {
        if (allowMissing) continue;
        throw new Error(`missing object ${oid}`);
      }
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        queue.push(commit.tree);
        for (const p of commit.parents) queue.push(p);
      } else if (obj.type === 'tree') {
        const entries = parseTree(obj.data);
        for (const e of entries) {
          if (e.mode !== '160000') queue.push(e.oid);
        }
      } else if (obj.type === 'tag') {
        const lines = obj.data.toString('utf8').split('\n');
        for (const line of lines) {
          if (line.startsWith('object ')) {
            queue.push(line.slice(7).trim());
            break;
          }
        }
      }
    }
    return seen;
  }

  // Check if ancestor is an ancestor of commit
  isAncestor(repo: Repository, ancestorOid: string, commitOid: string): boolean {
    if (ancestorOid === ZERO_OID) return true;
    if (ancestorOid === commitOid) return true;
    const visited = new Set<string>();
    const queue: string[] = [commitOid];
    while (queue.length > 0) {
      const curr = queue.pop()!;
      if (curr === ancestorOid) return true;
      if (visited.has(curr)) continue;
      visited.add(curr);
      const obj = repo.objects.get(curr);
      if (obj && obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        for (const p of commit.parents) {
          queue.push(p);
        }
      }
    }
    return false;
  }

  // Get tree entries for a specific path in tree
  findInTree(repo: Repository, treeOid: string, targetPath: string): { oid: string; mode: string; type: GitObjectType } | null {
    const segments = targetPath.split('/').filter(Boolean);
    let currOid = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const obj = repo.objects.get(currOid);
      if (!obj || obj.type !== 'tree') return null;
      const entries = parseTree(obj.data);
      const match = entries.find((e) => e.name === seg);
      if (!match) return null;
      if (isLast) {
        const matchObj = repo.objects.get(match.oid);
        return { oid: match.oid, mode: match.mode, type: matchObj?.type ?? (match.mode === '40000' ? 'tree' : 'blob') };
      }
      currOid = match.oid;
    }
    return null;
  }

  // Update or insert file in tree, returning new root tree oid
  putFileInTree(repo: Repository, rootTreeOid: string | null, filePath: string, blobOid: string, mode = '100644'): string {
    const segments = filePath.split('/').filter(Boolean);
    const updateSubtree = (currentTreeOid: string | null, depth: number): string => {
      const name = segments[depth];
      const isLast = depth === segments.length - 1;
      let entries: TreeEntry[] = [];
      if (currentTreeOid) {
        const treeObj = repo.objects.get(currentTreeOid);
        if (treeObj && treeObj.type === 'tree') {
          entries = parseTree(treeObj.data);
        }
      }
      if (isLast) {
        entries = entries.filter((e) => e.name !== name);
        entries.push({ mode, name, oid: blobOid });
      } else {
        const existing = entries.find((e) => e.name === name);
        const subOid = updateSubtree(existing?.oid ?? null, depth + 1);
        entries = entries.filter((e) => e.name !== name);
        entries.push({ mode: '40000', name, oid: subOid });
      }
      const newTreeData = buildTree(entries);
      const newTreeOid = hashObject('tree', newTreeData);
      repo.objects.set(newTreeOid, { type: 'tree', data: newTreeData });
      return newTreeOid;
    };
    return updateSubtree(rootTreeOid, 0);
  }

  // Delete file from tree, returning new root tree oid
  deleteFileFromTree(repo: Repository, rootTreeOid: string, filePath: string): string {
    const segments = filePath.split('/').filter(Boolean);
    const removeSubtree = (currentTreeOid: string, depth: number): string | null => {
      const name = segments[depth];
      const isLast = depth === segments.length - 1;
      const treeObj = repo.objects.get(currentTreeOid);
      if (!treeObj || treeObj.type !== 'tree') return currentTreeOid;
      let entries = parseTree(treeObj.data);
      if (isLast) {
        entries = entries.filter((e) => e.name !== name);
      } else {
        const existing = entries.find((e) => e.name === name);
        if (existing) {
          const subOid = removeSubtree(existing.oid, depth + 1);
          entries = entries.filter((e) => e.name !== name);
          if (subOid !== null) {
            entries.push({ mode: '40000', name, oid: subOid });
          }
        }
      }
      const newTreeData = buildTree(entries);
      const newTreeOid = hashObject('tree', newTreeData);
      repo.objects.set(newTreeOid, { type: 'tree', data: newTreeData });
      return newTreeOid;
    };
    return removeSubtree(rootTreeOid, 0) ?? rootTreeOid;
  }

  // Get flat list of all files in tree { path, oid, mode }
  listTreeFiles(repo: Repository, treeOid: string, prefix = ''): Array<{ path: string; oid: string; mode: string }> {
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return [];
    const entries = parseTree(treeObj.data);
    const result: Array<{ path: string; oid: string; mode: string }> = [];
    for (const e of entries) {
      const fullPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        result.push(...this.listTreeFiles(repo, e.oid, fullPath));
      } else {
        result.push({ path: fullPath, oid: e.oid, mode: e.mode });
      }
    }
    return result;
  }

  // Labels
  getLabels(owner: string, name: string): Label[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    return this.labels.get(key) ?? [];
  }

  addLabel(owner: string, name: string, labelName: string, color = 'ededed', description?: string): Label {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.labels.get(key);
    if (!list) {
      list = [];
      this.labels.set(key, list);
    }
    const id = this.nextLabelId++;
    const label: Label = {
      id,
      nodeId: Buffer.from(`Label:${id}`).toString('base64'),
      name: labelName,
      color,
      description,
    };
    list.push(label);
    return label;
  }

  // Issues
  getIssues(owner: string, name: string): Issue[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    return this.issues.get(key) ?? [];
  }

  getIssue(owner: string, name: string, number: number): Issue | undefined {
    const list = this.getIssues(owner, name);
    return list.find((i) => i.number === number);
  }

  createIssue(owner: string, name: string, title: string, body: string, labelNames: string[] = [], author = 'makefun'): Issue {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.issues.get(key);
    if (!list) {
      list = [];
      this.issues.set(key, list);
    }
    const repoLabels = this.getLabels(owner, name);
    const attachedLabels: Label[] = [];
    for (const lname of labelNames) {
      const l = repoLabels.find((candidate) => candidate.name.toLowerCase() === lname.toLowerCase());
      if (l) attachedLabels.push(l);
    }
    const number = list.length + 1;
    const id = this.nextIssueId++;
    const issue: Issue = {
      id,
      nodeId: Buffer.from(`Issue:${id}`).toString('base64'),
      number,
      title,
      body,
      state: 'open',
      labels: attachedLabels,
      comments: [],
      createdAt: '2026-11-14T06:30:00Z',
      updatedAt: '2026-11-14T06:30:00Z',
      closedAt: null,
      author,
    };
    list.push(issue);
    return issue;
  }

  addComment(owner: string, name: string, issueNumber: number, body: string, author = 'makefun'): Comment | null {
    const issue = this.getIssue(owner, name, issueNumber);
    if (!issue) return null;
    const id = this.nextCommentId++;
    const comment: Comment = {
      id,
      nodeId: Buffer.from(`Comment:${id}`).toString('base64'),
      body,
      author,
      createdAt: '2026-11-14T06:30:00Z',
      updatedAt: '2026-11-14T06:30:00Z',
    };
    issue.comments.push(comment);
    return comment;
  }

  // Pull Requests
  getPulls(owner: string, name: string): PullRequest[] {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    return this.pulls.get(key) ?? [];
  }

  getPull(owner: string, name: string, number: number): PullRequest | undefined {
    const list = this.getPulls(owner, name);
    return list.find((p) => p.number === number);
  }

  createPull(
    owner: string,
    name: string,
    title: string,
    body: string,
    head: string,
    base: string,
    author = 'makefun'
  ): PullRequest {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    let list = this.pulls.get(key);
    if (!list) {
      list = [];
      this.pulls.set(key, list);
    }
    const repo = this.getRepo(owner, name);
    const headRef = head.startsWith('refs/') ? head : `refs/heads/${head}`;
    const baseRef = base.startsWith('refs/') ? base : `refs/heads/${base}`;
    const headSha = repo?.refs.get(headRef) ?? ZERO_OID;
    const baseSha = repo?.refs.get(baseRef) ?? ZERO_OID;

    const number = list.length + 1;
    const id = this.nextPullId++;
    const pr: PullRequest = {
      id,
      nodeId: Buffer.from(`PullRequest:${id}`).toString('base64'),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRefName: head.replace(/^refs\/heads\//, ''),
      baseRefName: base.replace(/^refs\/heads\//, ''),
      headSha,
      baseSha,
      author,
      createdAt: '2026-11-14T06:30:00Z',
      updatedAt: '2026-11-14T06:30:00Z',
    };
    list.push(pr);
    return pr;
  }
}
