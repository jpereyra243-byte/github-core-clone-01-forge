import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ForgeStore } from './store.ts';
import type { Repository, Issue, PullRequest } from './store.ts';
import { hashObject, buildCommit, buildTree, parseCommit, parseTree, ZERO_OID } from './git.ts';

export class RestApiHandler {
  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
  }

  match(path: string): boolean {
    return path.startsWith('/api/v3');
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const host = req.headers.host ?? 'entry';
    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
    const origin = `${proto}://${host}`;
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // Helper to send json
    const sendJson = (status: number, data: unknown, extraHeaders: Record<string, string> = {}) => {
      const text = `${JSON.stringify(data)}\n`;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'x-github-request-id': requestId,
        ...extraHeaders,
      });
      res.end(text);
    };

    // Helper to send 204
    const sendNoContent = () => {
      res.writeHead(204, {
        'x-github-request-id': requestId,
        'content-type': 'application/json; charset=utf-8',
      });
      res.end();
    };

    // Global auth check: Every route under /api/v3 except root requires Bearer token
    if (path === '/api/v3' || path === '/api/v3/') {
      sendJson(200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendJson(401, { message: 'Requires authentication' });
      return;
    }
    const token = authHeader.slice(7).trim();

    // Parse body if present
    let body: any = null;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(400, { message: 'Problems parsing JSON' });
          return;
        }
      } else {
        body = {};
      }
    }

    // GET /api/v3/meta
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(200, {
        installed_version: '1.0.0-makefun',
        verifiable_password_authentication: false,
      });
      return;
    }

    // GET /api/v3/user
    if (method === 'GET' && path === '/api/v3/user') {
      sendJson(200, {
        login: this.store.viewerLogin,
        id: 1000,
        type: 'User',
      });
      return;
    }

    // GET /api/v3/user/repos
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const perPage = parseInt(url.searchParams.get('per_page') ?? '30', 10);
      const allRepos = [...this.store.repos.values()]
        .filter((r) => r.owner.toLowerCase() === this.store.viewerLogin.toLowerCase())
        .map((r) => this.formatRepo(r));
      const start = (page - 1) * perPage;
      const end = start + perPage;
      const paged = allRepos.slice(start, end);

      const headers: Record<string, string> = {};
      if (end < allRepos.length) {
        const nextUrl = `${url.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers['link'] = `<${nextUrl}>; rel="next"`;
      }
      sendJson(200, paged, headers);
      return;
    }

    // POST /api/v3/user/repos
    if (method === 'POST' && path === '/api/v3/user/repos') {
      const name = body?.name;
      if (!name) {
        sendJson(422, { message: 'Repository name required' });
        return;
      }
      const owner = this.store.viewerLogin;
      const existing = this.store.getRepo(owner, name);
      if (existing) {
        sendJson(422, { message: 'name already exists on this account' });
        return;
      }
      const repo = this.store.createRepo(owner, name, body?.description ?? '', body?.private ?? false);
      sendJson(201, this.formatRepo(repo));
      return;
    }

    // Repo matching: /api/v3/repos/{owner}/{repo}(/...)
    const repoMatch = /^\/api\/v3\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(.*)$/.exec(path);
    if (!repoMatch) {
      sendJson(404, { message: 'Not Found' });
      return;
    }

    const [, owner, repoName, subPath] = repoMatch;
    // Foreign token check: the token belongs to viewerLogin; repos under another owner cannot be accessed by this token
    if (owner.toLowerCase() !== this.store.viewerLogin.toLowerCase()) {
      sendJson(404, { message: 'Not Found' });
      return;
    }
    const repo = this.store.getRepo(owner, repoName);

    // If subPath is empty, operate on repo itself
    if (!subPath || subPath === '') {
      if (method === 'GET') {
        if (!repo) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        sendJson(200, this.formatRepo(repo));
        return;
      }
      if (method === 'PATCH') {
        if (!repo) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        if (body?.description !== undefined) {
          repo.description = String(body.description);
        }
        sendJson(200, this.formatRepo(repo));
        return;
      }
      if (method === 'DELETE') {
        if (!repo) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        this.store.deleteRepo(owner, repoName);
        sendNoContent();
        return;
      }
    }

    if (!repo) {
      sendJson(404, { message: 'Not Found' });
      return;
    }

    // GET /api/v3/repos/{owner}/{repo}/branches
    if (method === 'GET' && subPath === '/branches') {
      const branches: any[] = [];
      for (const [refName, oid] of repo.refs) {
        if (refName.startsWith('refs/heads/')) {
          const name = refName.replace('refs/heads/', '');
          branches.push({
            name,
            commit: { sha: oid, url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}` },
            protected: false,
          });
        }
      }
      sendJson(200, branches);
      return;
    }

    // POST /api/v3/repos/{owner}/{repo}/git/refs
    if (method === 'POST' && subPath === '/git/refs') {
      const ref = body?.ref;
      const sha = body?.sha;
      if (!ref || !sha || !repo.objects.has(sha)) {
        sendJson(422, { message: 'Invalid ref or sha' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(201, {
        ref,
        node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
        url: `/api/v3/repos/${owner}/${repoName}/git/${ref}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
      return;
    }

    // GET /api/v3/repos/{owner}/{repo}/commits
    if (method === 'GET' && subPath === '/commits') {
      const refQuery = url.searchParams.get('sha') ?? repo.headSymref;
      const targetSha = repo.refs.get(refQuery.startsWith('refs/') ? refQuery : `refs/heads/${refQuery}`) ?? (repo.objects.has(refQuery) ? refQuery : null);
      if (!targetSha) {
        sendJson(200, []);
        return;
      }
      const commits: any[] = [];
      const visited = new Set<string>();
      const queue: string[] = [targetSha];
      while (queue.length > 0) {
        const cSha = queue.shift()!;
        if (visited.has(cSha)) continue;
        visited.add(cSha);
        const obj = repo.objects.get(cSha);
        if (obj && obj.type === 'commit') {
          const c = parseCommit(obj.data);
          commits.push({
            sha: cSha,
            commit: {
              message: c.message.replace(/\r?\n$/, ''),
              author: { name: c.author, date: '2026-11-14T06:30:00Z' },
              committer: { name: c.committer, date: '2026-11-14T06:30:00Z' },
              tree: { sha: c.tree },
            },
            parents: c.parents.map((p) => ({ sha: p })),
          });
          for (const p of c.parents) queue.push(p);
        }
      }
      sendJson(200, commits);
      return;
    }

    // Contents API: /api/v3/repos/{owner}/{repo}/contents/{path...}
    const contentsMatch = /^\/contents\/(.+)$/.exec(subPath);
    if (contentsMatch) {
      const filePath = decodeURIComponent(contentsMatch[1]);
      const targetRef = url.searchParams.get('ref') ?? body?.branch ?? repo.headSymref;
      const branchRef = targetRef.startsWith('refs/') ? targetRef : `refs/heads/${targetRef}`;
      const branchOid = repo.refs.get(branchRef);

      if (method === 'GET') {
        if (!branchOid) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const commitObj = repo.objects.get(branchOid);
        if (!commitObj || commitObj.type !== 'commit') {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const rootTree = parseCommit(commitObj.data).tree;
        const found = this.store.findInTree(repo, rootTree, filePath);
        if (!found) {
          sendJson(404, { message: 'Not Found' });
          return;
        }

        if (found.type === 'tree') {
          // List directory
          const dirObj = repo.objects.get(found.oid);
          const entries = dirObj ? parseTree(dirObj.data) : [];
          const list = entries.map((e) => ({
            name: e.name,
            path: `${filePath}/${e.name}`,
            sha: e.oid,
            size: 0,
            type: e.mode === '40000' ? 'dir' : 'file',
          }));
          sendJson(200, list);
          return;
        }

        // File
        const blobObj = repo.objects.get(found.oid);
        const contentB64 = blobObj ? blobObj.data.toString('base64') : '';
        sendJson(200, {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: found.oid,
          size: blobObj?.data.length ?? 0,
          encoding: 'base64',
          content: contentB64,
          type: 'file',
        });
        return;
      }

      if (method === 'PUT') {
        const rawContent = body?.content ?? '';
        const b64Data = Buffer.from(rawContent, 'base64');
        const commitMsg = body?.message ?? 'update content';
        const expectedSha = body?.sha;

        let currentTree: string | null = null;
        let parentCommits: string[] = [];

        if (branchOid) {
          const c = parseCommit(repo.objects.get(branchOid)!.data);
          currentTree = c.tree;
          parentCommits = [branchOid];
          const existing = this.store.findInTree(repo, currentTree, filePath);
          if (expectedSha !== undefined) {
            if (!existing || existing.oid !== expectedSha) {
              sendJson(409, { message: 'sha does not match' });
              return;
            }
          }
        }

        const blobOid = hashObject('blob', b64Data);
        repo.objects.set(blobOid, { type: 'blob', data: b64Data });

        const newTreeOid = this.store.putFileInTree(repo, currentTree, filePath, blobOid);
        const newCommitData = buildCommit({
          tree: newTreeOid,
          parents: parentCommits,
          message: commitMsg,
          author: 'makefun <makefun@make.fun>',
        });
        const newCommitOid = hashObject('commit', newCommitData);
        repo.objects.set(newCommitOid, { type: 'commit', data: newCommitData });

        repo.refs.set(branchRef, newCommitOid);

        const isCreate = !branchOid || expectedSha === undefined;
        sendJson(isCreate ? 201 : 200, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: b64Data.length, encoding: 'base64' },
          commit: { sha: newCommitOid, message: commitMsg },
        });
        return;
      }

      if (method === 'DELETE') {
        if (!branchOid) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const c = parseCommit(repo.objects.get(branchOid)!.data);
        const existing = this.store.findInTree(repo, c.tree, filePath);
        if (!existing) {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const commitMsg = body?.message ?? 'delete file';
        const newTreeOid = this.store.deleteFileFromTree(repo, c.tree, filePath);
        const newCommitData = buildCommit({
          tree: newTreeOid,
          parents: [branchOid],
          message: commitMsg,
          author: 'makefun <makefun@make.fun>',
        });
        const newCommitOid = hashObject('commit', newCommitData);
        repo.objects.set(newCommitOid, { type: 'commit', data: newCommitData });
        repo.refs.set(branchRef, newCommitOid);

        sendJson(200, {
          commit: { sha: newCommitOid, message: commitMsg },
          content: null,
        });
        return;
      }
    }

    // Labels API
    if (subPath === '/labels') {
      if (method === 'GET') {
        sendJson(200, this.store.getLabels(owner, repoName));
        return;
      }
      if (method === 'POST') {
        const name = body?.name;
        if (!name) {
          sendJson(422, { message: 'Label name required' });
          return;
        }
        const label = this.store.addLabel(owner, repoName, name, body?.color ?? 'ededed', body?.description);
        sendJson(201, label);
        return;
      }
    }

    // Issues API: /issues, /issues/{n}, /issues/{n}/comments
    if (subPath === '/issues' || subPath.startsWith('/issues/')) {
      const issueNumMatch = /^\/issues\/(\d+)(.*)$/.exec(subPath);
      if (!issueNumMatch) {
        if (method === 'GET') {
          const stateFilter = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'asc';
          let issues = this.store.getIssues(owner, repoName);
          if (stateFilter !== 'all') {
            issues = issues.filter((i) => i.state === stateFilter);
          }
          issues = [...issues].sort((a, b) => {
            const cmp = a.id - b.id;
            return direction === 'desc' ? -cmp : cmp;
          });
          sendJson(200, issues.map((i) => this.formatIssue(owner, repoName, i)));
          return;
        }
        if (method === 'POST') {
          const title = body?.title;
          if (!title) {
            sendJson(422, { message: 'Title required' });
            return;
          }
          const labelNames: string[] = body?.labels ?? [];
          const repoLabels = this.store.getLabels(owner, repoName);
          for (const lname of labelNames) {
            if (!repoLabels.some((l) => l.name.toLowerCase() === lname.toLowerCase())) {
              sendJson(422, { message: `Label ${lname} does not exist` });
              return;
            }
          }
          const issue = this.store.createIssue(owner, repoName, title, body?.body ?? '', labelNames);
          sendJson(201, this.formatIssue(owner, repoName, issue));
          return;
        }
      } else {
        const issueNum = parseInt(issueNumMatch[1], 10);
        const subSub = issueNumMatch[2];
        const issue = this.store.getIssue(owner, repoName, issueNum);
        if (!issue) {
          sendJson(404, { message: 'Not Found' });
          return;
        }

        if (subSub === '' || !subSub) {
          if (method === 'GET') {
            sendJson(200, this.formatIssue(owner, repoName, issue));
            return;
          }
          if (method === 'PATCH') {
            if (body?.state) {
              issue.state = body.state === 'closed' ? 'closed' : 'open';
              issue.closedAt = issue.state === 'closed' ? '2026-11-14T06:30:00Z' : null;
            }
            if (body?.title) issue.title = String(body.title);
            if (body?.body) issue.body = String(body.body);
            sendJson(200, this.formatIssue(owner, repoName, issue));
            return;
          }
        }

        if (subSub === '/comments') {
          if (method === 'GET') {
            sendJson(200, issue.comments);
            return;
          }
          if (method === 'POST') {
            const commentBody = body?.body;
            if (!commentBody) {
              sendJson(422, { message: 'Body required' });
              return;
            }
            const comment = this.store.addComment(owner, repoName, issueNum, commentBody);
            sendJson(201, comment);
            return;
          }
        }
      }
    }

    // Pull Requests API: /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
    if (subPath === '/pulls' || subPath.startsWith('/pulls/')) {
      const pullNumMatch = /^\/pulls\/(\d+)(.*)$/.exec(subPath);
      if (!pullNumMatch) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let pulls = this.store.getPulls(owner, repoName);
          if (state !== 'all') {
            pulls = pulls.filter((p) => p.state === state);
          }
          sendJson(200, pulls.map((p) => this.formatPull(owner, repoName, p)));
          return;
        }
        if (method === 'POST') {
          const title = body?.title;
          const head = body?.head;
          const base = body?.base;
          if (!title || !head || !base) {
            sendJson(422, { message: 'Missing required PR fields' });
            return;
          }
          const pr = this.store.createPull(owner, repoName, title, body?.body ?? '', head, base);
          sendJson(201, this.formatPull(owner, repoName, pr));
          return;
        }
      } else {
        const pullNum = parseInt(pullNumMatch[1], 10);
        const subSub = pullNumMatch[2];
        const pr = this.store.getPull(owner, repoName, pullNum);
        if (!pr) {
          sendJson(404, { message: 'Not Found' });
          return;
        }

        if (subSub === '' || !subSub) {
          if (method === 'GET') {
            sendJson(200, this.formatPull(owner, repoName, pr));
            return;
          }
        }

        if (subSub === '/files' && method === 'GET') {
          const baseSha = repo.refs.get(`refs/heads/${pr.baseRefName}`) ?? pr.baseSha;
          const headSha = repo.refs.get(`refs/heads/${pr.headRefName}`) ?? pr.headSha;
          const baseTree = baseSha && repo.objects.has(baseSha) ? parseCommit(repo.objects.get(baseSha)!.data).tree : null;
          const headTree = headSha && repo.objects.has(headSha) ? parseCommit(repo.objects.get(headSha)!.data).tree : null;

          const baseFiles = baseTree ? this.store.listTreeFiles(repo, baseTree) : [];
          const headFiles = headTree ? this.store.listTreeFiles(repo, headTree) : [];
          const fileMap = new Map<string, { status: string; additions: number; deletions: number; changes: number }>();

          for (const hf of headFiles) {
            const bf = baseFiles.find((f) => f.path === hf.path);
            if (!bf) {
              fileMap.set(hf.path, { status: 'added', additions: 1, deletions: 0, changes: 1 });
            } else if (bf.oid !== hf.oid) {
              fileMap.set(hf.path, { status: 'modified', additions: 1, deletions: 1, changes: 2 });
            }
          }
          for (const bf of baseFiles) {
            if (!headFiles.some((f) => f.path === bf.path)) {
              fileMap.set(bf.path, { status: 'removed', additions: 0, deletions: 1, changes: 1 });
            }
          }

          const files = [...fileMap.entries()].map(([filename, stats]) => ({
            sha: headSha,
            filename,
            status: stats.status,
            additions: stats.additions,
            deletions: stats.deletions,
            changes: stats.changes,
            blob_url: `/api/v3/repos/${owner}/${repoName}/blob/${headSha}/${filename}`,
            raw_url: `/api/v3/repos/${owner}/${repoName}/raw/${headSha}/${filename}`,
            contents_url: `/api/v3/repos/${owner}/${repoName}/contents/${filename}?ref=${headSha}`,
          }));
          sendJson(200, files);
          return;
        }

        if (subSub === '/merge' && method === 'PUT') {
          const baseSha = repo.refs.get(`refs/heads/${pr.baseRefName}`);
          const headSha = repo.refs.get(`refs/heads/${pr.headRefName}`);
          if (!baseSha || !headSha) {
            sendJson(405, { message: 'Pull request cannot be merged' });
            return;
          }

          const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
          const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;

          // Conflict detection:
          // pr.baseSha is the base commit SHA when the PR was created.
          // If the current base branch tip (baseSha) has advanced past pr.baseSha,
          // check if any files changed in this PR were also modified between pr.baseSha and baseSha.
          if (pr.baseSha && pr.baseSha !== baseSha) {
            const origBaseCommit = repo.objects.get(pr.baseSha);
            if (origBaseCommit && origBaseCommit.type === 'commit') {
              const origBaseTree = parseCommit(origBaseCommit.data).tree;
              const origFiles = this.store.listTreeFiles(repo, origBaseTree);
              const curBaseFiles = this.store.listTreeFiles(repo, baseTree);
              const headFiles = this.store.listTreeFiles(repo, headTree);

              // Files modified on base branch since PR creation
              const baseModified = new Set<string>();
              for (const cbf of curBaseFiles) {
                const obf = origFiles.find((f) => f.path === cbf.path);
                if (!obf || obf.oid !== cbf.oid) {
                  baseModified.add(cbf.path);
                }
              }

              // Check if any file modified in PR head touches baseModified
              let hasConflict = false;
              for (const hf of headFiles) {
                const obf = origFiles.find((f) => f.path === hf.path);
                if (!obf || obf.oid !== hf.oid) {
                  if (baseModified.has(hf.path)) {
                    hasConflict = true;
                    break;
                  }
                }
              }

              if (hasConflict) {
                sendJson(405, { message: 'Pull request has conflict and cannot be merged' });
                return;
              }
            }
          }

          // Build squash commit
          const mergeMsg = body?.commit_message ?? `Merge pull request #${pr.number} from ${pr.headRefName}`;
          const newCommitData = buildCommit({
            tree: headTree,
            parents: [baseSha],
            message: mergeMsg,
            author: 'makefun <makefun@make.fun>',
          });
          const mergeCommitSha = hashObject('commit', newCommitData);
          repo.objects.set(mergeCommitSha, { type: 'commit', data: newCommitData });

          // Fast-forward base ref to new squash commit
          repo.refs.set(`refs/heads/${pr.baseRefName}`, mergeCommitSha);

          pr.merged = true;
          pr.state = 'closed';
          pr.mergedAt = '2026-11-14T06:30:00Z';
          pr.mergeCommitSha = mergeCommitSha;

          sendJson(200, {
            sha: mergeCommitSha,
            merged: true,
            message: 'Pull Request successfully merged',
          });
          return;
        }
      }
    }

    sendJson(404, { message: 'Not Found' });
  }

  private formatRepo(repo: Repository): any {
    return {
      id: repo.id,
      node_id: repo.nodeId,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.isPrivate,
      owner: { login: repo.owner, id: 1, type: 'User' },
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: repo.hasIssuesEnabled,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    };
  }

  private formatIssue(owner: string, repo: string, issue: Issue): any {
    return {
      id: issue.id,
      node_id: issue.nodeId,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      user: { login: issue.author, id: 1 },
      labels: issue.labels.map((l) => ({ id: l.id, node_id: l.nodeId, name: l.name, color: l.color })),
      comments: issue.comments.length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      url: `/api/v3/repos/${owner}/${repo}/issues/${issue.number}`,
    };
  }

  private formatPull(owner: string, repo: string, pr: PullRequest): any {
    const r = this.store.getRepo(owner, repo);
    const headSha = r?.refs.get(`refs/heads/${pr.headRefName}`) ?? pr.headSha;
    const baseSha = r?.refs.get(`refs/heads/${pr.baseRefName}`) ?? pr.baseSha;
    return {
      id: pr.id,
      node_id: pr.nodeId,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.mergedAt,
      merge_commit_sha: pr.mergeCommitSha,
      user: { login: pr.author, id: 1 },
      head: {
        ref: pr.headRefName,
        sha: headSha,
        repo: { name: repo, full_name: `${owner}/${repo}` },
      },
      base: {
        ref: pr.baseRefName,
        sha: baseSha,
        repo: { name: repo, full_name: `${owner}/${repo}` },
      },
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      url: `/api/v3/repos/${owner}/${repo}/pulls/${pr.number}`,
    };
  }
}
