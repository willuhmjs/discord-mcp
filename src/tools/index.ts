import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../lib/context.js';
import { registerAutomodTools } from './automod.js';
import { registerChannelTools } from './channels.js';
import { registerDmTools } from './dms.js';
import { registerEventTools } from './events.js';
import { registerExpressionTools } from './expressions.js';
import { registerForumTools } from './forums.js';
import { registerInteractionTools, setupInteractions } from './interactions.js';
import { registerInviteTools } from './invites.js';
import { registerMemberTools } from './members.js';
import { registerMessageTools } from './messages.js';
import { registerRoleTools } from './roles.js';
import { registerServerTools } from './server.js';
import { registerThreadTools } from './threads.js';
import { registerVoiceTools } from './voice.js';
import { registerWebhookTools } from './webhooks.js';

/**
 * Register every tool area. Each area module returns its tool count;
 * this is the only file that knows all of them.
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): number {
  let count = 0;
  count += registerDmTools(server, ctx);
  count += registerMessageTools(server, ctx);
  count += registerChannelTools(server, ctx);
  count += registerVoiceTools(server, ctx);
  count += registerForumTools(server, ctx);
  count += registerThreadTools(server, ctx);
  count += registerMemberTools(server, ctx);
  count += registerRoleTools(server, ctx);
  count += registerServerTools(server, ctx);
  count += registerAutomodTools(server, ctx);
  count += registerEventTools(server, ctx);
  count += registerInviteTools(server, ctx);
  count += registerWebhookTools(server, ctx);
  count += registerExpressionTools(server, ctx);
  count += registerInteractionTools(server, ctx);
  return count;
}

/** Wire the interactionCreate handler (buttons/selects with mcp: custom ids). */
export function attachInteractionHandler(ctx: ToolContext): void {
  setupInteractions(ctx);
}
