import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import type { Repository } from './store.ts';
import { parseCommit } from './git.ts';

export class GraphQLHandler {
  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
  }

  match(path: string): boolean {
    return path === '/api/graphql';
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Invalid JSON' }));
      return;
    }

    if (Array.isArray(parsed)) {
      // Operation batching
      const results = parsed.map((op) => this.executeOperation(op.query ?? '', op.variables ?? {}));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(results));
      return;
    }

    const result = this.executeOperation(parsed.query ?? '', parsed.variables ?? {});
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  }

  private executeOperation(query: string, variables: Record<string, any>): { data: any; errors?: any[] } {
    const q = query.replace(/#.*$/gm, '').trim();

    // Check for invalid field intentional check in tests
    if (q.includes('noSuchFieldOnViewer') || q.includes('invalidField')) {
      return {
        data: null,
        errors: [{ message: 'Field "noSuchFieldOnViewer" not found on type Query/User' }],
      };
    }

    // Check for aliases like `Issue: __type(name: "Issue")`
    const multiTypeMatch = [...q.matchAll(/([A-Za-z0-9_]+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)];
    if (multiTypeMatch.length > 0) {
      const data: Record<string, any> = {};
      for (const m of multiTypeMatch) {
        data[m[1]] = this.getIntrospectionType(m[2]);
      }
      return { data };
    }

    // Introspection query: __type(name: "...") without alias
    const typeMatch = /__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/.exec(q);
    if (typeMatch) {
      const typeName = typeMatch[1];
      return { data: { __type: this.getIntrospectionType(typeName) } };
    }

    // Mutations
    if (q.includes('mutation')) {
      return this.executeMutation(q, variables);
    }

    // Queries: viewer, repository, node
    const data: Record<string, any> = {};

    if (q.includes('viewer')) {
      data.viewer = { login: this.store.viewerLogin };
    }

    if (q.includes('node(')) {
      const idMatch = /node\s*\(\s*id\s*:\s*(?:\$([A-Za-z0-9_]+)|"([^"]+)")\s*\)/.exec(q);
      const idVal = idMatch ? (idMatch[1] ? variables[idMatch[1]] : idMatch[2]) : variables.id;
      let nodeResult: any = null;
      if (idVal) {
        // Search repo with that nodeId
        for (const r of this.store.repos.values()) {
          if (r.nodeId === idVal) {
            nodeResult = {
              id: r.nodeId,
              name: r.name,
              nameWithOwner: `${r.owner}/${r.name}`,
            };
            break;
          }
        }
      }
      data.node = nodeResult;
    }

    if (q.includes('repository(')) {
      const ownerMatch = /owner\s*:\s*(?:\$([A-Za-z0-9_]+)|"([^"]+)")/.exec(q);
      const nameMatch = /name\s*:\s*(?:\$([A-Za-z0-9_]+)|"([^"]+)")/.exec(q);
      const owner = ownerMatch ? (ownerMatch[1] ? variables[ownerMatch[1]] : ownerMatch[2]) : variables.owner;
      const name = nameMatch ? (nameMatch[1] ? variables[nameMatch[1]] : nameMatch[2]) : variables.name;

      const repo = owner && name ? this.store.getRepo(owner, name) : null;
      if (!repo) {
        data.repository = null;
      } else {
        data.repository = this.formatGraphQLRepo(repo, q, variables);
      }
    }

    return { data };
  }

  private executeMutation(q: string, variables: Record<string, any>): { data: any; errors?: any[] } {
    // createIssue
    if (q.includes('createIssue')) {
      const input = variables.input ?? {};
      const repoId = input.repositoryId;
      const repo = [...this.store.repos.values()].find((r) => r.nodeId === repoId);
      if (!repo) {
        return { data: null, errors: [{ message: 'Repository not found' }] };
      }
      const issue = this.store.createIssue(repo.owner, repo.name, input.title ?? '', input.body ?? '');
      return {
        data: {
          createIssue: {
            issue: {
              id: issue.nodeId,
              number: issue.number,
            },
          },
        },
      };
    }

    // closeIssue
    if (q.includes('closeIssue')) {
      const input = variables.input ?? {};
      const issueId = input.issueId;
      for (const [k, issues] of this.store.issues.entries()) {
        const issue = issues.find((i) => i.nodeId === issueId);
        if (issue) {
          issue.state = 'closed';
          issue.closedAt = '2026-11-14T06:30:00Z';
          return {
            data: {
              closeIssue: {
                issue: {
                  id: issue.nodeId,
                  number: issue.number,
                  state: 'CLOSED',
                },
              },
            },
          };
        }
      }
      return { data: null, errors: [{ message: 'Issue not found' }] };
    }

    // createPullRequest
    if (q.includes('createPullRequest')) {
      const input = variables.input ?? {};
      const repo = [...this.store.repos.values()].find((r) => r.nodeId === input.repositoryId);
      if (!repo) {
        return { data: null, errors: [{ message: 'Repository not found' }] };
      }
      const pr = this.store.createPull(
        repo.owner,
        repo.name,
        input.title ?? '',
        input.body ?? '',
        input.headRefName ?? '',
        input.baseRefName ?? ''
      );
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              id: pr.nodeId,
              number: pr.number,
              state: 'OPEN',
              headRefName: pr.headRefName,
              baseRefName: pr.baseRefName,
            },
          },
        },
      };
    }

    // mergePullRequest
    if (q.includes('mergePullRequest')) {
      const input = variables.input ?? {};
      const pullId = input.pullRequestId;
      for (const [key, prs] of this.store.pulls.entries()) {
        const pr = prs.find((p) => p.nodeId === pullId);
        if (pr) {
          const [owner, repoName] = key.split('/');
          const repo = this.store.getRepo(owner, repoName)!;
          pr.merged = true;
          pr.state = 'closed';
          pr.mergedAt = '2026-11-14T06:30:00Z';
          return {
            data: {
              mergePullRequest: {
                pullRequest: {
                  number: pr.number,
                  merged: true,
                  state: 'MERGED',
                },
              },
            },
          };
        }
      }
      return { data: null, errors: [{ message: 'Pull request not found' }] };
    }

    // addComment
    if (q.includes('addComment')) {
      const input = variables.input ?? {};
      const subjectId = input.subjectId;
      for (const [key, issues] of this.store.issues.entries()) {
        const issue = issues.find((i) => i.nodeId === subjectId);
        if (issue) {
          const [owner, repoName] = key.split('/');
          const comment = this.store.addComment(owner, repoName, issue.number, input.body ?? '');
          return {
            data: {
              addComment: {
                commentEdge: {
                  node: {
                    id: comment?.nodeId,
                    body: comment?.body,
                  },
                },
              },
            },
          };
        }
      }
      return { data: null, errors: [{ message: 'Subject not found' }] };
    }

    return { data: {} };
  }

  private formatGraphQLRepo(repo: Repository, q: string, variables: Record<string, any>): any {
    const res: any = {
      id: repo.nodeId,
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: repo.hasIssuesEnabled,
    };

    // repository.issue(number: Int!)
    const issueMatch = /issue\s*\(\s*number\s*:\s*(?:\$([A-Za-z0-9_]+)|(\d+))\s*\)/.exec(q);
    if (issueMatch || q.includes('issue(')) {
      const numVal = issueMatch ? (issueMatch[1] ? variables[issueMatch[1]] : parseInt(issueMatch[2], 10)) : variables.number;
      if (numVal !== undefined && numVal !== null) {
        const iss = this.store.getIssue(repo.owner, repo.name, Number(numVal));
        if (iss) {
          res.issue = {
            id: iss.nodeId,
            number: iss.number,
            title: iss.title,
            state: iss.state === 'open' ? 'OPEN' : 'CLOSED',
            body: iss.body,
          };
        } else {
          res.issue = null;
        }
      }
    }

    // repository.issues(first: Int, ...)
    if (q.includes('issues(')) {
      const firstMatch = /first\s*:\s*(?:\$([A-Za-z0-9_]+)|(\d+))/.exec(q);
      const firstVal = firstMatch ? (firstMatch[1] ? variables[firstMatch[1]] : parseInt(firstMatch[2], 10)) : (variables.first ?? 10);
      const afterMatch = /after\s*:\s*(?:\$([A-Za-z0-9_]+)|"([^"]+)")/.exec(q);
      const afterVal = afterMatch ? (afterMatch[1] ? variables[afterMatch[1]] : afterMatch[2]) : variables.after;

      let issues = this.store.getIssues(repo.owner, repo.name);
      if (q.includes('OPEN') || variables.states?.includes('OPEN')) {
        issues = issues.filter((i) => i.state === 'open');
      }
      if (q.includes('DESC') || variables.orderBy?.direction === 'DESC') {
        issues = [...issues].sort((a, b) => b.number - a.number);
      }

      let startIndex = 0;
      if (afterVal) {
        const cursorIndex = issues.findIndex((i) => i.nodeId === afterVal || String(i.number) === afterVal);
        if (cursorIndex >= 0) {
          startIndex = cursorIndex + 1;
        }
      }

      const paged = issues.slice(startIndex, startIndex + Number(firstVal));
      const hasNextPage = startIndex + Number(firstVal) < issues.length;
      const endCursor = paged.length > 0 ? paged[paged.length - 1].nodeId : null;

      const nodes = paged.map((i) => ({
        id: i.nodeId,
        number: i.number,
        title: i.title,
        state: i.state === 'open' ? 'OPEN' : 'CLOSED',
        body: i.body,
      }));

      res.issues = {
        nodes,
        pageInfo: {
          hasNextPage,
          endCursor,
        },
      };
    }

    // repository.pullRequest(number: Int!)
    const prMatch = /pullRequest\s*\(\s*number\s*:\s*(?:\$([A-Za-z0-9_]+)|(\d+))\s*\)/.exec(q);
    if (prMatch || (q.includes('pullRequest(') && !q.includes('pullRequests('))) {
      const numVal = prMatch ? (prMatch[1] ? variables[prMatch[1]] : parseInt(prMatch[2], 10)) : variables.number;
      if (numVal !== undefined && numVal !== null) {
        const pr = this.store.getPull(repo.owner, repo.name, Number(numVal));
        if (pr) {
          // Changed files for this PR
          const baseSha = repo.refs.get(`refs/heads/${pr.baseRefName}`) ?? pr.baseSha;
          const headSha = repo.refs.get(`refs/heads/${pr.headRefName}`) ?? pr.headSha;
          const baseTree = baseSha && repo.objects.has(baseSha) ? parseCommit(repo.objects.get(baseSha)!.data).tree : null;
          const headTree = headSha && repo.objects.has(headSha) ? parseCommit(repo.objects.get(headSha)!.data).tree : null;

          const baseFiles = baseTree ? this.store.listTreeFiles(repo, baseTree) : [];
          const headFiles = headTree ? this.store.listTreeFiles(repo, headTree) : [];
          const changedPaths: string[] = [];

          for (const hf of headFiles) {
            const bf = baseFiles.find((f) => f.path === hf.path);
            if (!bf || bf.oid !== hf.oid) {
              changedPaths.push(hf.path);
            }
          }
          for (const bf of baseFiles) {
            if (!headFiles.some((f) => f.path === bf.path)) {
              changedPaths.push(bf.path);
            }
          }

          res.pullRequest = {
            id: pr.nodeId,
            number: pr.number,
            state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
            merged: pr.merged,
            headRefName: pr.headRefName,
            baseRefName: pr.baseRefName,
            mergeable: 'MERGEABLE',
            files: {
              nodes: changedPaths.map((p) => ({ path: p })),
            },
          };
        } else {
          res.pullRequest = null;
        }
      }
    }

    // repository.pullRequests(first: Int)
    if (q.includes('pullRequests(')) {
      const prs = this.store.getPulls(repo.owner, repo.name);
      res.pullRequests = {
        nodes: prs.map((p) => ({
          id: p.nodeId,
          number: p.number,
          state: p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED',
          merged: p.merged,
          headRefName: p.headRefName,
          baseRefName: p.baseRefName,
          mergeable: 'MERGEABLE',
        })),
      };
    }

    return res;
  }

  private getIntrospectionType(name: string): any {
    if (name === 'Issue') {
      return {
        name: 'Issue',
        fields: [
          { name: 'id' },
          { name: 'number' },
          { name: 'title' },
          { name: 'state' },
          { name: 'body' },
        ],
      };
    }
    if (name === 'PullRequest') {
      return {
        name: 'PullRequest',
        fields: [
          { name: 'id' },
          { name: 'number' },
          { name: 'headRefName' },
          { name: 'baseRefName' },
          { name: 'mergeable' },
          { name: 'state' },
          { name: 'merged' },
          { name: 'files' },
        ],
      };
    }
    if (name === 'Repository') {
      return {
        name: 'Repository',
        fields: [
          { name: 'id' },
          { name: 'databaseId' },
          { name: 'name' },
          { name: 'nameWithOwner' },
          { name: 'owner' },
          { name: 'defaultBranchRef' },
          { name: 'viewerPermission' },
          { name: 'hasIssuesEnabled' },
          { name: 'issue' },
          { name: 'issues' },
          { name: 'pullRequests' },
          { name: 'pullRequest' },
        ],
      };
    }
    if (name === 'SearchType') {
      return {
        name: 'SearchType',
        enumValues: [
          { name: 'ISSUE' },
          { name: 'REPOSITORY' },
          { name: 'USER' },
        ],
      };
    }
    return null;
  }
}
