import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';

export class McpHandler {
  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
  }

  match(path: string): boolean {
    return path === '/mcp' || path === '/mcp/';
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method Not Allowed' }, id: null }));
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');

    let rpc: any;
    try {
      rpc = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    const id = rpc.id !== undefined ? rpc.id : null;
    const method = rpc.method;
    const params = rpc.params ?? {};

    const sendResponse = (result?: any, error?: { code: number; message: string; data?: any }, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      if (error) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      }
    };

    // Modern 2026-07-28 RPC: server/discover
    if (method === 'server/discover') {
      sendResponse({
        serverInfo: { name: 'github-core-clone-01-mcp', version: '1.0.0' },
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
      });
      return;
    }

    // Legacy initialize
    if (method === 'initialize') {
      sendResponse({
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'github-core-clone-01-mcp', version: '1.0.0' },
        capabilities: { tools: {} },
      });
      return;
    }

    if (method === 'notifications/initialized') {
      sendResponse({});
      return;
    }

    // tools/list
    if (method === 'tools/list') {
      sendResponse({
        tools: this.getToolsList(),
      });
      return;
    }

    // tools/call
    if (method === 'tools/call') {
      this.handleToolCall(params, sendResponse);
      return;
    }

    sendResponse(undefined, { code: -32601, message: 'Method not found' });
  }

  private getToolsList(): any[] {
    return [
      {
        name: 'create_repo',
        description: 'Create a new repository for the authenticated user',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository name' },
            description: { type: 'string', description: 'Repository description' },
            private: { type: 'boolean', description: 'Whether repo is private' },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_repo',
        description: 'Get a repository by owner and name',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_issue',
        description: 'Create an issue in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body' },
          },
          required: ['owner', 'repo', 'title'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', description: 'State open or closed' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'create_pull_request',
        description: 'Create a pull request in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Pull request title' },
            head: { type: 'string', description: 'Head branch' },
            base: { type: 'string', description: 'Base branch' },
          },
          required: ['owner', 'repo', 'title', 'head', 'base'],
        },
      },
      {
        name: 'merge_pull_request',
        description: 'Merge a pull request in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pull_number: { type: 'number', description: 'Pull request number' },
          },
          required: ['owner', 'repo', 'pull_number'],
        },
      },
    ];
  }

  private handleToolCall(params: any, sendResponse: (result?: any, error?: any) => void): void {
    const name = String(params.name ?? '');
    const args = params.arguments ?? {};

    // Match suffix or direct name
    const matches = (tool: string) => name.toLowerCase().endsWith(tool);

    if (matches('create_repo')) {
      if (!args.name) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Missing argument: name' }] });
        return;
      }
      const owner = args.owner ?? this.store.viewerLogin;
      const repo = this.store.createRepo(owner, String(args.name), args.description ?? '', Boolean(args.private));
      sendResponse({
        content: [{ type: 'text', text: JSON.stringify({ name: repo.name, owner: repo.owner, id: repo.id }) }],
      });
      return;
    }

    if (matches('get_repo')) {
      if (!args.owner || !args.repo) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Missing owner or repo' }] });
        return;
      }
      const repo = this.store.getRepo(String(args.owner), String(args.repo));
      if (!repo) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Repository not found' }] });
        return;
      }
      sendResponse({
        content: [{ type: 'text', text: JSON.stringify({ name: repo.name, owner: repo.owner, id: repo.id }) }],
      });
      return;
    }

    if (matches('create_issue')) {
      if (!args.owner || !args.repo || !args.title) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Missing required arguments' }] });
        return;
      }
      const issue = this.store.createIssue(String(args.owner), String(args.repo), String(args.title), String(args.body ?? ''));
      sendResponse({
        content: [{ type: 'text', text: JSON.stringify({ number: issue.number, title: issue.title, id: issue.id }) }],
      });
      return;
    }

    if (matches('list_issues')) {
      if (!args.owner || !args.repo) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Missing owner or repo' }] });
        return;
      }
      let issues = this.store.getIssues(String(args.owner), String(args.repo));
      if (args.state) {
        issues = issues.filter((i) => i.state === args.state);
      }
      sendResponse({
        content: [{ type: 'text', text: JSON.stringify(issues.map((i) => ({ number: i.number, title: i.title, id: i.id }))) }],
      });
      return;
    }

    if (matches('create_pull_request')) {
      if (!args.owner || !args.repo || !args.title || !args.head || !args.base) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Missing required PR arguments' }] });
        return;
      }
      const pr = this.store.createPull(
        String(args.owner),
        String(args.repo),
        String(args.title),
        String(args.body ?? ''),
        String(args.head),
        String(args.base)
      );
      sendResponse({
        content: [{ type: 'text', text: JSON.stringify({ number: pr.number, title: pr.title, id: pr.id }) }],
      });
      return;
    }

    if (matches('merge_pull_request')) {
      if (!args.owner || !args.repo || args.pull_number === undefined) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Missing required arguments' }] });
        return;
      }
      const pr = this.store.getPull(String(args.owner), String(args.repo), Number(args.pull_number));
      if (!pr) {
        sendResponse({ isError: true, content: [{ type: 'text', text: 'Pull request not found' }] });
        return;
      }
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = '2026-11-14T06:30:00Z';
      sendResponse({
        content: [{ type: 'text', text: JSON.stringify({ number: pr.number, merged: true }) }],
      });
      return;
    }

    sendResponse(undefined, { code: -32601, message: `Unknown tool: ${name}` });
  }
}
