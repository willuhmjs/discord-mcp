import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { InteractionLog, type ToolContext } from '../src/lib/context.js';
import { registerAllTools } from '../src/tools/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function stubContext(): ToolContext {
  return {
    client: { rest: {}, guilds: {}, channels: {}, users: {} } as never,
    defaultGuildId: '123456789012345678',
    membersIntent: true,
    interactions: new InteractionLog(),
  };
}

async function registeredToolNames(): Promise<string[]> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerAllTools(server, stubContext());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.listTools({ cursor });
    names.push(...res.tools.map((t) => t.name));
    cursor = res.nextCursor;
  } while (cursor);
  return names;
}

/** Tool names that head a row of a markdown table: `| name |` or `| \`name\` |`. */
function documentedToolNames(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|/gm)].map((m) => m[1]));
}

describe('documentation', () => {
  it('lists every registered tool in the README tables', async () => {
    const documented = documentedToolNames(readFileSync(join(root, 'README.md'), 'utf8'));
    const undocumented = (await registeredToolNames()).filter((name) => !documented.has(name));
    expect(undocumented, 'add these tools to docs/tables/*.md and the README').toEqual([]);
  });
});
