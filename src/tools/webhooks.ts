import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  WebhookClient,
  type ChannelWebhookCreateOptions,
  type Collection,
  type Message,
  type Webhook,
  type WebhookMessageCreateOptions,
  type WebhookType,
} from 'discord.js';
import { z } from 'zod';
import {
  assertSnowflake,
  fetchChannel,
  fetchGuild,
  parseWebhookUrl,
  type ToolContext,
} from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { guardedFetch, IMAGE_TYPES } from '../lib/fetch.js';
import { formatMessageLine, fromDiscordMessage, truncate } from '../lib/format.js';
import { buildEditOptions, buildSendOptions } from '../lib/messages.js';
import { channelIdParam, createRegistrar, reasonParam, snowflakeId } from '../lib/register.js';

const AVATAR_MAX_BYTES = 256 * 1024;

/** Fetch an avatar image URL and encode it as a data URI Discord accepts. */
async function avatarDataUri(avatarUrl: string): Promise<string> {
  const fetched = await guardedFetch(avatarUrl, {
    allowedTypes: IMAGE_TYPES,
    maxBytes: AVATAR_MAX_BYTES,
  });
  return `data:${fetched.contentType};base64,${fetched.data.toString('base64')}`;
}

/** A channel that can hold webhooks (text, announcement, voice text, forum, media). */
interface WebhookCapableChannel {
  id: string;
  name: string;
  createWebhook(options: ChannelWebhookCreateOptions): Promise<Webhook<WebhookType.Incoming>>;
  fetchWebhooks(): Promise<Collection<string, Webhook>>;
}

async function webhookChannel(ctx: ToolContext, channelId: string): Promise<WebhookCapableChannel> {
  const channel = await fetchChannel<WebhookCapableChannel>(ctx, channelId);
  if (typeof channel.createWebhook !== 'function' || typeof channel.fetchWebhooks !== 'function') {
    throw new ValidationError(
      'channelId: webhooks cannot be managed in this channel type (e.g. categories hold none)',
    );
  }
  return channel;
}

/**
 * One safe line per webhook — NEVER the token or webhook URL (those are send
 * credentials; only create_webhook reveals the URL, exactly once).
 */
function webhookLine(w: Webhook): string {
  const channelName = w.channel?.name;
  const owner = w.owner as { username?: string } | null;
  return `${w.name || '(unnamed)'} (id ${w.id}, in #${channelName ?? w.channelId}, by @${owner?.username ?? 'unknown'})`;
}

/** Fetch a webhook the bot can see (Discord API errors map automatically). */
async function fetchWebhook(ctx: ToolContext, webhookId: string): Promise<Webhook> {
  const id = assertSnowflake('webhookId', webhookId);
  return (await ctx.client.fetchWebhook(id)) as Webhook;
}

/** Webhook message tools need the token, which the bot only has for webhooks it manages. */
function requireWebhookToken(webhook: Webhook): void {
  if (!webhook.token) {
    throw new ValidationError('webhookId: this webhook has no token available to the bot');
  }
}

/**
 * Webhook tools (legacy create/delete/list/send + get/edit/guild-list and
 * message get/edit/delete). Webhook URLs and tokens are send credentials:
 * list/get outputs never include them, and only create_webhook returns the URL.
 * Returns the number of tools registered.
 */
export function registerWebhookTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('create_webhook', {
    description:
      'Create a new webhook on a specific channel. The full webhook URL (a send credential) is ' +
      'returned exactly once — save it now, it is never shown again.',
    inputSchema: {
      channelId: channelIdParam,
      name: z.string().min(1).max(80).describe('Webhook name (1-80 chars)'),
      avatarUrl: z
        .string()
        .optional()
        .describe('Optional avatar image URL (fetched server-side, max 256KB)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await webhookChannel(ctx, args.channelId);
      const avatar = args.avatarUrl ? await avatarDataUri(args.avatarUrl) : undefined;
      const webhook = await channel.createWebhook({
        name: args.name,
        ...(avatar !== undefined ? { avatar } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return (
        `Webhook created: ${webhook.name} (id ${webhook.id}). ` +
        `URL (send credential — save it now, it is never shown again): ` +
        `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`
      );
    },
  });

  reg.tool('delete_webhook', {
    description: 'Delete a webhook (the bot must manage it or hold Manage Webhooks).',
    inputSchema: {
      webhookId: snowflakeId('Discord webhook ID'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const webhook = await fetchWebhook(ctx, args.webhookId);
      await webhook.delete(args.reason);
      return `Webhook ${webhook.name} (id ${webhook.id}) deleted`;
    },
  });

  reg.tool('list_webhooks', {
    description: 'List webhooks on a specific channel (names, IDs, creators — never tokens or URLs).',
    inputSchema: {
      channelId: channelIdParam,
    },
    handler: async (args) => {
      const channel = await webhookChannel(ctx, args.channelId);
      const webhooks = await channel.fetchWebhooks();
      const lines = [...webhooks.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((w) => webhookLine(w));
      return truncate(lines.join('\n')) || '(no webhooks in this channel)';
    },
  });

  reg.tool('send_webhook_message', {
    description:
      'Send a message via webhook URL. Supports embeds, components and files (message may be "" ' +
      'when embeds/components/files are present). Webhooks cannot reply or send stickers. ' +
      'threadName creates a forum post when the webhook targets a forum channel.',
    inputSchema: {
      webhookUrl: z
        .string()
        .describe('Discord webhook link (https://discord.com/api/webhooks/<id>/<token>)'),
      message: z
        .string()
        .describe('Message content (max 2000 chars; may be "" when embedsJson/componentsJson/filesJson are given)'),
      embedsJson: z
        .string()
        .optional()
        .describe(
          'Embeds as a JSON string. Array: [{title, description, url, timestamp, color, footer:{text,icon_url}, ' +
          'image:{url}, thumbnail:{url}, author:{name,url,icon_url}, fields:[{name,value,inline}]}]. Max 10 embeds, 6000 chars total.',
        ),
      componentsJson: z
        .string()
        .optional()
        .describe(
          'Components as a JSON string. Array of raw Discord component JSON: action rows (type 1) holding ' +
          'buttons (type 2) or selects (3/5/6/7/8), or Components V2 types (9 section, 10 text display, ' +
          '11 thumbnail, 12 media gallery, 13 file, 14 separator, 17 container).',
        ),
      username: z.string().optional().describe('Override the webhook default username for this message'),
      avatarUrl: z.string().optional().describe('Override the webhook default avatar (image URL)'),
      threadId: z.string().optional().describe('Thread ID: send into this existing thread of the webhook channel'),
      threadName: z
        .string()
        .optional()
        .describe('Create a forum post with this name (only when the webhook targets a forum channel)'),
      filesJson: z
        .string()
        .optional()
        .describe(
          'Files as a JSON string. Array: [{url, filename?, description?, spoiler?} or {base64, filename, description?, spoiler?}].',
        ),
      allowedMentions: z
        .enum(['users', 'users_roles', 'all', 'none'])
        .optional()
        .describe('Who this message may ping (default "users")'),
    },
    handler: async (args) => {
      const { id, token } = parseWebhookUrl(args.webhookUrl);
      const options = await buildSendOptions(args);
      // Webhooks cannot reply; buildSendOptions only sets this for reply-capable
      // tools, but strip it defensively so the API never sees it.
      delete options.reply;
      const payload: WebhookMessageCreateOptions = {
        ...options,
        ...(args.username !== undefined ? { username: args.username } : {}),
        ...(args.avatarUrl !== undefined ? { avatarURL: args.avatarUrl } : {}),
        ...(args.threadId !== undefined ? { threadId: assertSnowflake('threadId', args.threadId) } : {}),
        ...(args.threadName !== undefined ? { threadName: args.threadName } : {}),
        flags: options.flags,
      };
      const hook = new WebhookClient({ id, token });
      try {
        const sent = (await hook.send(payload)) as {
          id: string;
          channel_id?: string;
          guild_id?: string;
          url?: string;
        };
        const url =
          sent.url ??
          (sent.channel_id
            ? `https://discord.com/channels/${sent.guild_id ?? '@me'}/${sent.channel_id}/${sent.id}`
            : '');
        return `Webhook message sent (id ${sent.id}): ${url}`;
      } finally {
        hook.destroy();
      }
    },
  });

  reg.tool('get_webhook', {
    description: 'Get a webhook\u2019s details (name, channel, creator, avatar). Never returns the token.',
    inputSchema: {
      webhookId: snowflakeId('Discord webhook ID'),
    },
    handler: async (args) => {
      const webhook = await fetchWebhook(ctx, args.webhookId);
      const owner = webhook.owner as { id?: string; username?: string } | null;
      const lines = [
        `${webhook.name || '(unnamed)'} (id ${webhook.id}, type ${webhook.type})`,
        `channel: #${webhook.channel?.name ?? 'unknown'} (id ${webhook.channelId})`,
        `creator: ${owner?.username ? `@${owner.username} (id ${owner.id ?? '?'})` : 'unknown'}`,
        `avatar: ${webhook.avatarURL() ?? '(none)'}`,
      ];
      return lines.join('\n');
    },
  });

  reg.tool('edit_webhook', {
    description: 'Edit a webhook (rename, re-avatar, or move it to another channel).',
    inputSchema: {
      webhookId: snowflakeId('Discord webhook ID'),
      name: z.string().min(1).max(80).optional().describe('New webhook name'),
      avatarUrl: z
        .string()
        .optional()
        .describe('New avatar image URL (fetched server-side, max 256KB)'),
      channelId: z
        .string()
        .optional()
        .describe('Move the webhook to this channel (Discord channel ID)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      if (args.name === undefined && args.avatarUrl === undefined && args.channelId === undefined) {
        throw new ValidationError('provide at least one of name, avatarUrl, channelId');
      }
      const webhook = await fetchWebhook(ctx, args.webhookId);
      const avatar = args.avatarUrl ? await avatarDataUri(args.avatarUrl) : undefined;
      const edited = await webhook.edit({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(avatar !== undefined ? { avatar } : {}),
        ...(args.channelId !== undefined ? { channel: assertSnowflake('channelId', args.channelId) } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return `Webhook edited: ${edited.name || '(unnamed)'} (id ${edited.id})`;
    },
  });

  reg.tool('list_guild_webhooks', {
    description: 'List all webhooks in a server (names, IDs, creators — never tokens or URLs).',
    inputSchema: {
      guildId: z
        .string()
        .optional()
        .describe('Discord server ID (optional; defaults to DISCORD_GUILD_ID)'),
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const webhooks = await guild.fetchWebhooks();
      const lines = [...webhooks.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((w) => webhookLine(w));
      return truncate(lines.join('\n')) || '(no webhooks in this server)';
    },
  });

  reg.tool('get_webhook_message', {
    description:
      'Fetch a message previously sent by a webhook the bot manages (needs the webhook token).',
    inputSchema: {
      webhookId: snowflakeId('Discord webhook ID'),
      messageId: snowflakeId('Webhook message ID'),
      threadId: z.string().optional().describe('Thread ID if the message is in a thread'),
    },
    handler: async (args) => {
      const webhook = await fetchWebhook(ctx, args.webhookId);
      requireWebhookToken(webhook);
      const messageId = assertSnowflake('messageId', args.messageId);
      const message = await webhook.fetchMessage(
        messageId,
        args.threadId ? { threadId: assertSnowflake('threadId', args.threadId) } : undefined,
      );
      return formatMessageLine(fromDiscordMessage(message as Message));
    },
  });

  reg.tool('edit_webhook_message', {
    description: 'Edit a message previously sent by a webhook the bot manages (needs the webhook token).',
    inputSchema: {
      webhookId: snowflakeId('Discord webhook ID'),
      messageId: snowflakeId('Webhook message ID'),
      newMessage: z.string().optional().describe('New message text content'),
      embedsJson: z
        .string()
        .optional()
        .describe(
          'Embeds as a JSON string. Array: [{title, description, url, timestamp, color, footer:{text,icon_url}, ' +
          'image:{url}, thumbnail:{url}, author:{name,url,icon_url}, fields:[{name,value,inline}]}]. Max 10 embeds, 6000 chars total.',
        ),
      componentsJson: z
        .string()
        .optional()
        .describe('Components as a JSON string (same format as send_webhook_message).'),
      threadId: z.string().optional().describe('Thread ID if the message is in a thread'),
    },
    handler: async (args) => {
      const webhook = await fetchWebhook(ctx, args.webhookId);
      requireWebhookToken(webhook);
      const messageId = assertSnowflake('messageId', args.messageId);
      const options = await buildEditOptions(args);
      await webhook.editMessage(messageId, {
        ...options,
        ...(args.threadId !== undefined ? { threadId: assertSnowflake('threadId', args.threadId) } : {}),
      });
      return `Webhook message ${messageId} edited`;
    },
  });

  reg.tool('delete_webhook_message', {
    description: 'Delete a message previously sent by a webhook the bot manages (needs the webhook token).',
    inputSchema: {
      webhookId: snowflakeId('Discord webhook ID'),
      messageId: snowflakeId('Webhook message ID'),
      threadId: z.string().optional().describe('Thread ID if the message is in a thread'),
    },
    handler: async (args) => {
      const webhook = await fetchWebhook(ctx, args.webhookId);
      requireWebhookToken(webhook);
      const messageId = assertSnowflake('messageId', args.messageId);
      await webhook.deleteMessage(
        messageId,
        args.threadId ? assertSnowflake('threadId', args.threadId) : undefined,
      );
      return `Webhook message ${messageId} deleted`;
    },
  });

  return reg.count;
}
