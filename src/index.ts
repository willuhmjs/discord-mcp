import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InteractionLog, type ToolContext } from './lib/context.js';
import { attachInteractionHandler, registerAllTools } from './tools/index.js';

const VERSION = '1.0.0';

/** Read the first defined env var among names. */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

// Status logging goes to stderr so stdio transport mode keeps stdout clean.
const log = (...args: unknown[]): void => console.error(...args);

function fatal(message: string): never {
  log(`FATAL: ${message}`);
  process.exit(1);
}

function transportMode(): 'http' | 'stdio' {
  const explicit = env('MCP_TRANSPORT')?.toLowerCase();
  if (explicit === 'stdio') return 'stdio';
  if (explicit === 'http') return 'http';
  // Java-compat: the old server only served HTTP under the "http" profile.
  const spring = env('SPRING_PROFILES_ACTIVE')?.toLowerCase();
  if (spring && spring !== 'http') return 'stdio';
  return 'http';
}

const TOKEN = process.env.DISCORD_TOKEN;
const HOST = env('HOST', 'SERVER_ADDRESS') ?? '127.0.0.1';
const PORT = Number.parseInt(env('PORT', 'SERVER_PORT') ?? '8085', 10);
const DEFAULT_GUILD_ID = process.env.DISCORD_GUILD_ID;
const MEMBERS_INTENT = /^(1|true|yes|on)$/i.test(process.env.ENABLE_MEMBERS_INTENT ?? '');

if (!TOKEN) {
  fatal(
    'DISCORD_TOKEN is required. Create a bot application at ' +
      'https://discord.com/developers/applications, enable the listed intents, and set DISCORD_TOKEN to its token.',
  );
}
if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
  fatal(`PORT is not a valid port number (got ${env('PORT', 'SERVER_PORT')})`);
}

const baseIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildMessagePolls,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildWebhooks,
];
const intents = new Set(baseIntents);
if (MEMBERS_INTENT) intents.add(GatewayIntentBits.GuildMembers);

const client = new Client({ intents: [...intents] });

const ctx: ToolContext = {
  client,
  defaultGuildId: DEFAULT_GUILD_ID,
  membersIntent: MEMBERS_INTENT,
  interactions: new InteractionLog(),
};

// Register tools up front so they are all listed on the first tools/list.
const mcpServer = new McpServer({ name: 'discord-mcp', version: VERSION });
const toolCount = registerAllTools(mcpServer, ctx);

const INTENTS_HELP =
  'Open https://discord.com/developers/applications -> your app -> Bot and enable ' +
  '"Message Content Intent"' +
  (MEMBERS_INTENT ? ' and "Server Members Intent"' : '') +
  ', then restart.';

let ready = false;

client.on(Events.ShardDisconnect, (closeEvent) => {
  if (closeEvent?.code === 4014) {
    fatal(`Discord rejected the connection: disallowed intents (gateway close code 4014). ${INTENTS_HELP}`);
  }
});

try {
  await client.login(TOKEN);
} catch (err) {
  const code = (err as { code?: string | number })?.code;
  if (code === 'TokenInvalid' || code === 401) {
    fatal('Discord rejected the bot token (401 TokenInvalid). Check DISCORD_TOKEN.');
  }
  if (code === 'DisallowedIntents' || code === 4014) {
    fatal(`Discord rejected the connection: disallowed intents. ${INTENTS_HELP}`);
  }
  fatal(`Could not log in to Discord: ${(err as Error).message}`);
}

client.on(Events.ClientReady, (c) => {
  ready = true;
  log(`ready as ${c.user.tag}, ${toolCount} tools`);
  if (DEFAULT_GUILD_ID) log(`default guild: ${DEFAULT_GUILD_ID}`);
  if (!MEMBERS_INTENT) {
    log('ENABLE_MEMBERS_INTENT is off: member-list tools are degraded; set ENABLE_MEMBERS_INTENT=1 to enable.');
  }
});

attachInteractionHandler(ctx);

process.on('unhandledRejection', (err) => {
  log('unhandled rejection:', err);
});

const mode = transportMode();

if (mode === 'stdio') {
  log(`discord-mcp ${VERSION} starting in stdio mode (pid ${process.pid})`);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
} else {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

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

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/health') {
        if (ready) {
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
            const fresh = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableJsonResponse: true,
            });
            fresh.onclose = () => {
              if (fresh.sessionId) sessions.delete(fresh.sessionId);
            };
            await mcpServer.connect(fresh);
            sessions.set(fresh.sessionId!, fresh);
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
      log(`error handling ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) jsonError(res, 500, 'internal server error');
      else res.end();
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, HOST, resolve);
  });
  log(`discord-mcp ${VERSION} listening on http://${HOST}:${PORT}/mcp (${toolCount} tools)`);
  log(`health: http://${HOST}:${PORT}/health`);

  const shutdown = (): void => {
    log('shutting down');
    httpServer.close();
    client.destroy();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
