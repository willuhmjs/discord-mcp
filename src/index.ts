import { Client, Events, GatewayIntentBits } from 'discord.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpHttpServer, listenOnSocket, removeSocket } from './http.js';
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
  // Compatibility alias: SPRING_PROFILES_ACTIVE historically meant HTTP mode
  // when set to "http"; anything else falls back to stdio.
  const spring = env('SPRING_PROFILES_ACTIVE')?.toLowerCase();
  if (spring && spring !== 'http') return 'stdio';
  return 'http';
}

const TOKEN = process.env.DISCORD_TOKEN;
const HOST = env('HOST', 'SERVER_ADDRESS') ?? '127.0.0.1';
const PORT = Number.parseInt(env('PORT', 'SERVER_PORT') ?? '8085', 10);
// When set, HTTP mode listens on this Unix socket instead of HOST:PORT (see listenOnSocket in http.ts).
const SOCKET = env('MCP_SOCKET');
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

// stdio serves one client, so a single server is enough; HTTP builds one per session (see http.ts).
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
  const httpServer = createMcpHttpServer({
    newMcpServer: () => {
      const server = new McpServer({ name: 'discord-mcp', version: VERSION });
      registerAllTools(server, ctx);
      return server;
    },
    isReady: () => ready,
    log,
  });

  if (SOCKET) {
    try {
      await listenOnSocket(httpServer, SOCKET);
    } catch (err) {
      fatal(`could not listen on MCP_SOCKET ${SOCKET}: ${(err as Error).message}`);
    }
    log(`discord-mcp ${VERSION} listening on unix socket ${SOCKET} (${toolCount} tools)`);
  } else {
    await new Promise<void>((resolve) => {
      httpServer.listen(PORT, HOST, resolve);
    });
    log(`discord-mcp ${VERSION} listening on http://${HOST}:${PORT}/mcp (${toolCount} tools)`);
    log(`health: http://${HOST}:${PORT}/health`);
  }

  const shutdown = (): void => {
    log('shutting down');
    httpServer.close();
    if (SOCKET) removeSocket(SOCKET);
    client.destroy();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
