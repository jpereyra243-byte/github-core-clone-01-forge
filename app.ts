import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './src/store.ts';
import { GitHttpHandler } from './src/git-server.ts';
import { RestApiHandler } from './src/rest.ts';
import { GraphQLHandler } from './src/graphql.ts';
import { McpHandler } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  const store = new ForgeStore();
  const gitHandler = new GitHttpHandler(store);
  const restHandler = new RestApiHandler(store);
  const graphqlHandler = new GraphQLHandler(store);
  const mcpHandler = new McpHandler(store);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // 1. Boot check probe: GET /healthz answers 200 {"ok":true}
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // 2. Git smart HTTP surface: /{owner}/{repo}.git/...
      const gitMatch = gitHandler.match(path);
      if (gitMatch) {
        await gitHandler.handle(req, res, gitMatch.owner, gitMatch.repo, gitMatch.action);
        return;
      }

      // 3. REST v3 surface: /api/v3/...
      if (restHandler.match(path)) {
        await restHandler.handle(req, res);
        return;
      }

      // 4. GraphQL v4 surface: /api/graphql
      if (graphqlHandler.match(path)) {
        await graphqlHandler.handle(req, res);
        return;
      }

      // 5. MCP surface: /mcp
      if (mcpHandler.match(path)) {
        await mcpHandler.handle(req, res);
        return;
      }

      // Default fallback 404
      if (!res.headersSent) {
        sendJson(res, 404, { message: 'Not Found' });
      }
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: (err as Error).message });
      }
    }
  });
}
