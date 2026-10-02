import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface McpHttpOptions {
  /**
   * Build a fresh MCP server (with every tool registered). An McpServer can only serve one
   * transport at a time, so each client session gets its own; they all share the Discord client.
   */
  newMcpServer: () => McpServer;
  /** True once the Discord client is ready; backs GET /health. */
  isReady: () => boolean;
  log: (...args: unknown[]) => void;
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function sessionHeader(req: IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > 32 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The streamable-HTTP MCP endpoint (POST /mcp, stateful sessions) plus GET /health. */
export function createMcpHttpServer(options: McpHttpOptions): Server {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/health') {
        if (options.isReady()) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
        } else {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('discord client not ready');
        }
        return;
      }
      if (url.pathname !== '/mcp') {
        jsonError(res, 404, `not found: ${url.pathname} (MCP endpoint is POST /mcp, health is GET /health)`);
        return;
      }
      const sessionId = sessionHeader(req);

      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          jsonError(res, 400, 'invalid JSON body');
          return;
        }
        let transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          if (!sessionId && isInitializeRequest(body)) {
            const fresh: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableJsonResponse: true,
              // The id only exists once the initialize request has been handled, so register it here.
              onsessioninitialized: (id) => {
                sessions.set(id, fresh);
              },
            });
            fresh.onclose = () => {
              if (fresh.sessionId) sessions.delete(fresh.sessionId);
            };
            await options.newMcpServer().connect(fresh);
            transport = fresh;
          } else {
            jsonError(
              res,
              400,
              'Bad Request: no valid session. POST an initialize request without an Mcp-Session-Id header first.',
            );
            return;
          }
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'DELETE' || req.method === 'GET') {
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          jsonError(res, 400, 'Bad Request: unknown or missing Mcp-Session-Id header');
          return;
        }
        // DELETE terminates the session; GET gets 405 from the transport in JSON mode.
        await transport.handleRequest(req, res);
        return;
      }

      jsonError(res, 405, `method ${req.method} not allowed`);
    } catch (err) {
      options.log(`error handling ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) jsonError(res, 500, 'internal server error');
      else res.end();
    }
  });
}
