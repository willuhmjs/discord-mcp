import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHttpServer } from '../src/http.js';
import { InteractionLog, type ToolContext } from '../src/lib/context.js';
import { registerAllTools } from '../src/tools/index.js';

const ctx: ToolContext = {
  client: { rest: {}, guilds: {}, channels: {}, users: {} } as never,
  defaultGuildId: '123456789012345678',
  membersIntent: true,
  interactions: new InteractionLog(),
};

let ready = false;
const server = createMcpHttpServer({
  newMcpServer: () => {
    const mcp = new McpServer({ name: 'test', version: '0.0.0' });
    registerAllTools(mcp, ctx);
    return mcp;
  },
  isReady: () => ready,
  log: () => {},
});
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return client;
}

describe('streamable HTTP endpoint', () => {
  it('serves several sessions at once (one McpServer per session)', async () => {
    const [a, b] = await Promise.all([connect(), connect()]);
    const [toolsA, toolsB] = await Promise.all([a.listTools(), b.listTools()]);
    expect(toolsA.tools.length).toBeGreaterThan(100);
    expect(toolsB.tools.length).toBe(toolsA.tools.length);
    await Promise.all([a.close(), b.close()]);
  });

  it('lets a client reconnect after its session ended', async () => {
    const first = await connect();
    await first.listTools();
    await first.close();
    const second = await connect();
    expect((await second.listTools()).tools.length).toBeGreaterThan(100);
    await second.close();
  });

  it('reports readiness on /health', async () => {
    ready = false;
    expect((await fetch(`${baseUrl}/health`)).status).toBe(503);
    ready = true;
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('rejects requests without a session', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });
});
