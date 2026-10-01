import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { InteractionLog, type ToolContext } from '../src/lib/context.js';
import { registerAllTools } from '../src/tools/index.js';

interface LegacyTool {
  name: string;
  params: { name: string; required: boolean }[];
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'legacy-tools.json',
);
const legacyTools: LegacyTool[] = JSON.parse(readFileSync(fixturePath, 'utf8'));

function stubContext(): ToolContext {
  return {
    client: { rest: {}, guilds: {}, channels: {}, users: {} } as never,
    defaultGuildId: '123456789012345678',
    membersIntent: true,
    interactions: new InteractionLog(),
  };
}

async function listTools() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const count = registerAllTools(server, stubContext());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  const tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> = [];
  let cursor: string | undefined;
  do {
    const res = (await client.listTools({ cursor })) as {
      tools: typeof tools;
      nextCursor?: string;
    };
    tools.push(...res.tools);
    cursor = res.nextCursor;
  } while (cursor);
  return { count, tools };
}

describe('legacy compatibility', () => {
  it('registers all 75 legacy tool names', async () => {
    const { tools } = await listTools();
    const names = new Set(tools.map((t) => t.name));
    const missing = legacyTools.filter((t) => !names.has(t.name)).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('keeps every legacy param, with no new required params', async () => {
    const { tools } = await listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const legacy of legacyTools) {
      const tool = byName.get(legacy.name);
      expect(tool, `tool ${legacy.name} must exist`).toBeDefined();
      const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);

      for (const param of legacy.params) {
        expect(
          properties[param.name],
          `${legacy.name}.${param.name} must exist`,
        ).toBeDefined();
      }
      const legacyRequired = new Set(legacy.params.filter((p) => p.required).map((p) => p.name));
      for (const req of required) {
        expect(
          legacyRequired.has(req),
          `${legacy.name}: param "${req}" is required but was optional (or absent) in the legacy tool`,
        ).toBe(true);
      }
    }
  });

  it('registers well over 100 tools total', async () => {
    const { count, tools } = await listTools();
    expect(tools.length).toBe(count);
    expect(tools.length).toBeGreaterThan(120);
  });

  it('types every id-like param as a string', async () => {
    const { tools } = await listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, { type?: string }> };
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        if (/(?:^|_)id$/i.test(name) || /Id$/.test(name)) {
          if (prop.type) {
            expect(prop.type, `${tool.name}.${name} should be a string`).toBe('string');
          }
        }
      }
    }
  });
});
