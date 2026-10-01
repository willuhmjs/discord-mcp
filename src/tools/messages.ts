import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Message } from 'discord.js';
import { z } from 'zod';
import {
  assertSnowflake,
  fetchSendableChannel,
  isoTime,
  resolveGuildId,
  type SendableChannel,
  type ToolContext,
} from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import {
  formatMessageLine,
  fromDiscordMessage,
  normalizeApiMessage,
  truncate,
} from '../lib/format.js';
import { buildEditOptions, buildSendOptions, richEditShape, richSendShape } from '../lib/messages.js';
import {
  channelIdParam,
  createRegistrar,
  guildIdParam,
  limitParam,
  reasonParam,
  snowflakeId,
  userIdParam,
} from '../lib/register.js';

const SEARCH_HAS_FILTERS = new Set(['link', 'embed', 'file', 'image', 'video', 'sound', 'poll', 'sticker']);
const SEARCH_INDEX_BUDGET_MS = 10_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function humanSize(bytes: number | null | undefined): string {
  const b = bytes ?? 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function requireEmoji(value: string | undefined): string {
  const emoji = value?.trim();
  if (!emoji) {
    throw new ValidationError('emoji: required \u2014 unicode emoji ("\u{1F44D}") or custom "name:id"');
  }
  return emoji;
}

function requireAnswerId(value: string): number {
  const id = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(id) || id < 1) {
    throw new ValidationError('answerId: must be a positive integer (poll answers are numbered from 1)');
  }
  return id;
}

function isoTimestamp(name: string, value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new ValidationError(`${name}: "${value}" is not a valid ISO 8601 timestamp`);
  }
  return new Date(time).toISOString();
}

function describeComponents(components: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  const walk = (nodes: Array<Record<string, unknown>>): void => {
    for (const node of nodes) {
      const type = node.type as number | undefined;
      if (type === 1) parts.push('action row');
      else if (type === 2) {
        const label = typeof node.label === 'string' && node.label ? ` "${node.label}"` : '';
        parts.push(`button${label} (custom_id ${JSON.stringify(node.custom_id ?? null)})`);
      } else if (type === 3) parts.push('string select');
      else if (type === 5) parts.push('user select');
      else if (type === 6) parts.push('role select');
      else if (type === 7) parts.push('mentionable select');
      else if (type === 8) parts.push('channel select');
      else if (type === 17) parts.push('container');
      const children = node.components;
      if (Array.isArray(children)) walk(children as Array<Record<string, unknown>>);
    }
  };
  walk(components);
  return parts.join(', ') || '(empty)';
}

interface SearchBody {
  messages?: unknown[][];
  total_results?: number;
  retry_after?: number;
}

/**
 * Channel message tools: the 7 legacy MessageService tools (send, edit, delete,
 * read, reactions, attachment metadata) plus forwarding, message detail,
 * server-wide search, pins, bulk delete, crossposting, reaction listing and
 * polls. Channels are addressed by channel ID (text, threads, announcement,
 * voice-text and forum posts all work). Returns the number of tools registered.
 */
export function registerMessageTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  async function channelOf(channelId: string): Promise<SendableChannel> {
    return fetchSendableChannel(ctx, channelId);
  }

  async function messageOf(channelId: string, messageId: string): Promise<Message> {
    const channel = await channelOf(channelId);
    const id = assertSnowflake('messageId', messageId);
    try {
      return (await channel.messages.fetch(id)) as Message;
    } catch {
      throw new ValidationError(`messageId: message ${id} not found in channel ${channelId}`);
    }
  }

  async function readHistory(channelId: string, args: {
    count?: number;
    before?: string;
    after?: string;
    around?: string;
  }): Promise<string> {
    const channel = await channelOf(channelId);
    const limit = args.count ?? 10;
    const messages = (await channel.messages.fetch({
      limit,
      ...(args.before ? { before: args.before } : {}),
      ...(args.after ? { after: args.after } : {}),
      ...(args.around ? { around: args.around } : {}),
    })) as unknown as Map<string, Message>;
    const lines = [...messages.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => formatMessageLine(fromDiscordMessage(m)));
    return truncate(lines.join('\n')) || '(no messages)';
  }

  // --- Legacy MessageService tools ---------------------------------------

  reg.tool('send_message', {
    description:
      'Send a message to a channel. Supports embeds, components, polls, stickers, files, replies and flags.',
    inputSchema: {
      channelId: channelIdParam,
      ...richSendShape,
      // richSendShape.replyToMessageId is a plain snowflakeId (required in the
      // shape); a reply is optional, so relax it — legacy callers must not be
      // forced to pass it.
      replyToMessageId: richSendShape.replyToMessageId.optional(),
    },
    handler: async (args) => {
      const options = await buildSendOptions(args);
      const channel = await channelOf(args.channelId);
      const sent = (await channel.send(options)) as Message;
      return `Message sent: ${sent.url} (id ${sent.id})`;
    },
  });

  reg.tool('edit_message', {
    description:
      'Edit a message the bot previously sent in a channel. Supports embeds, components and keeping existing attachments.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      ...richEditShape,
    },
    handler: async (args) => {
      const message = await messageOf(args.channelId, args.messageId);
      const options = await buildEditOptions(args, [...message.attachments.values()].map((a) => ({
        id: a.id,
        filename: a.name,
        description: a.description,
      })));
      await message.edit(options);
      return `Message ${args.messageId} edited: ${message.url}`;
    },
  });

  reg.tool('delete_message', {
    description: 'Delete a message from a channel.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const message = await messageOf(args.channelId, args.messageId);
      await message.delete();
      return `Message ${args.messageId} deleted from channel ${args.channelId}`;
    },
  });

  reg.tool('read_messages', {
    description: 'Read message history from a channel, newest last (paginated with before/after/around).',
    inputSchema: {
      channelId: channelIdParam,
      count: limitParam(10, 100).describe('Number of messages to retrieve (default 10, max 100)'),
      before: z.string().optional().describe('Message ID: fetch messages before this one'),
      after: z.string().optional().describe('Message ID: fetch messages after this one'),
      around: z.string().optional().describe('Message ID: fetch messages around this one'),
    },
    handler: async (args) => readHistory(args.channelId, args),
  });

  reg.tool('add_reaction', {
    description: 'Add a reaction to a message.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      emoji: z.string().describe('Emoji (unicode like "\u{1F44D}", or custom "name:id")'),
    },
    handler: async (args) => {
      const message = await messageOf(args.channelId, args.messageId);
      await message.react(requireEmoji(args.emoji));
      return `Reaction ${args.emoji} added to message ${args.messageId}`;
    },
  });

  reg.tool('remove_reaction', {
    description: 'Remove the bot\u2019s own reaction from a message.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      emoji: z.string().describe('Emoji (unicode like "\u{1F44D}", or custom "name:id")'),
    },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      const emoji = requireEmoji(args.emoji);
      await ctx.client.rest.delete(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      );
      return `Reaction ${emoji} removed from message ${messageId}`;
    },
  });

  reg.tool('get_attachment', {
    description:
      'Get attachment metadata (filename, size, content type, URLs) from a specific message. Returns info only, does not download files.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      attachmentId: snowflakeId('Specific attachment ID (omit to list all attachments on the message)').optional(),
    },
    handler: async (args) => {
      const message = await messageOf(args.channelId, args.messageId);
      const attachments = [...message.attachments.values()];
      if (!attachments.length) return `Message ${args.messageId} has no attachments`;
      const chosen = args.attachmentId
        ? attachments.filter((a) => a.id === args.attachmentId)
        : attachments;
      if (!chosen.length) {
        throw new ValidationError(
          `attachmentId: message ${args.messageId} has no attachment ${args.attachmentId}`,
        );
      }
      const lines = chosen.map((a) => {
        const meta = [`attachment ${a.id}: ${a.name}`, `  size: ${humanSize(a.size)}`];
        if (a.contentType) meta.push(`  content type: ${a.contentType}`);
        meta.push(`  url: ${a.url}`);
        return meta.join('\n');
      });
      return truncate(lines.join('\n'));
    },
  });

  // --- New tools ----------------------------------------------------------

  reg.tool('forward_message', {
    description: 'Forward a message to another channel, preserving the original author and content.',
    inputSchema: {
      channelId: channelIdParam.describe('Channel containing the message to forward'),
      messageId: snowflakeId('Message ID to forward'),
      targetChannelId: channelIdParam.describe('Channel to forward the message to'),
    },
    handler: async (args) => {
      const message = await messageOf(args.channelId, args.messageId);
      const target = await channelOf(args.targetChannelId);
      const sent = (await target.send({ forward: { message } })) as Message;
      return `Message ${args.messageId} forwarded to channel ${args.targetChannelId}: ${sent.url} (id ${sent.id})`;
    },
  });

  reg.tool('get_message', {
    description:
      'Get one message\u2019s full details: content, embeds (compact JSON), component summary, attachments, reactions, poll and reference.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const message = await messageOf(args.channelId, args.messageId);
      const lines: string[] = [formatMessageLine(fromDiscordMessage(message))];
      if (message.embeds.length) {
        lines.push(`embeds: ${message.embeds.length}`);
        message.embeds.forEach((embed, i) => {
          const json = JSON.stringify(embed);
          lines.push(`  [${i + 1}] ${json.length > 300 ? `${json.slice(0, 300)}\u2026` : json}`);
        });
      }
      const components = (message.components as unknown as Array<Record<string, unknown>>) ?? [];
      if (components.length) {
        lines.push(`components: ${describeComponents(components)}`);
      }
      if (message.attachments.size) {
        lines.push(`attachments: ${message.attachments.size}`);
        for (const a of message.attachments.values()) {
          lines.push(
            `  ${a.id}: ${a.name} (${humanSize(a.size)}${a.contentType ? `, ${a.contentType}` : ''}) ${a.url}`,
          );
        }
      }
      if (message.reactions.cache.size) {
        const reactions = [...message.reactions.cache.values()]
          .map((r) => `${r.emoji.toString()}: ${r.count}`)
          .join(', ');
        lines.push(`reactions: ${reactions}`);
      }
      if (message.poll) {
        const poll = message.poll;
        lines.push(
          `poll: ${poll.question.text ?? '(no question)'} (multiselect ${poll.allowMultiselect ? 'on' : 'off'})`,
        );
        for (const answer of poll.answers.values()) {
          const label = answer.text ?? answer.emoji?.toString() ?? '(no label)';
          lines.push(`  answer ${answer.id}: ${label} \u2014 ${answer.voteCount} vote(s)`);
        }
        if (poll.expiresTimestamp) {
          lines.push(`  ${poll.resultsFinalized ? 'finalized' : 'ends'}: ${isoTime(poll.expiresTimestamp)}`);
        }
      }
      if (message.reference?.messageId) {
        const ref = message.reference;
        const kind =
          ref.type === 0 ? 'reply to' : ref.type === 1 ? 'forward of' : `reference type ${ref.type} to`;
        lines.push(`${kind} message ${ref.messageId} in channel ${ref.channelId}`);
      }
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('search_messages', {
    description:
      'Search messages in a server by content, author, channel, mentions, attachment type or time range (Discord message search).',
    inputSchema: {
      guildId: guildIdParam,
      content: z.string().optional().describe('Text to search for'),
      authorId: snowflakeId('Only messages from this user ID').optional(),
      channelId: snowflakeId('Only search in this channel ID').optional(),
      mentionsUserId: snowflakeId('Only messages mentioning this user ID').optional(),
      has: z
        .string()
        .optional()
        .describe('Comma-separated filters: link, embed, file, image, video, sound, poll, sticker'),
      before: z.string().optional().describe('ISO 8601 timestamp: only messages sent before'),
      after: z.string().optional().describe('ISO 8601 timestamp: only messages sent after'),
      limit: limitParam(25, 100),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guildId = resolveGuildId(ctx, args.guildId);
      const params = new URLSearchParams();
      if (args.content?.trim()) params.set('content', args.content.trim());
      if (args.authorId) params.set('author_id', assertSnowflake('authorId', args.authorId));
      if (args.channelId) params.set('channel_id', assertSnowflake('channelId', args.channelId));
      if (args.mentionsUserId) {
        params.set('mentions_user_id', assertSnowflake('mentionsUserId', args.mentionsUserId));
      }
      if (args.has?.trim()) {
        for (const filter of args.has.split(',').map((s: string) => s.trim()).filter(Boolean)) {
          if (!SEARCH_HAS_FILTERS.has(filter)) {
            throw new ValidationError(`has: "${filter}" must be one of ${[...SEARCH_HAS_FILTERS].join(', ')}`);
          }
          params.append('has', filter);
        }
      }
      if (args.before) params.set('before', isoTimestamp('before', args.before));
      if (args.after) params.set('after', isoTimestamp('after', args.after));
      params.set('limit', String(args.limit ?? 25));

      const startedAt = Date.now();
      for (;;) {
        const body = (await ctx.client.rest.get(`/guilds/${guildId}/messages/search`, {
          query: params,
        })) as SearchBody;
        if (Array.isArray(body?.messages)) {
          const groups = body.messages;
          const total = Number(body.total_results ?? 0);
          if (!groups.length) return `No results (total ${total})`;
          const lines = groups.map((group) =>
            formatMessageLine(normalizeApiMessage((group?.[0] ?? {}) as Record<string, unknown>)),
          );
          return truncate(`Found ${total} result(s), showing the newest ${groups.length}:\n${lines.join('\n')}`);
        }
        if (typeof body?.retry_after !== 'number') {
          throw new Error(`Unexpected search response: ${JSON.stringify(body).slice(0, 300)}`);
        }
        const remaining = SEARCH_INDEX_BUDGET_MS - (Date.now() - startedAt);
        if (remaining <= 0) {
          return 'search is still indexing, try again in a minute';
        }
        await wait(Math.min(Math.max(body.retry_after, 1) * 1000, remaining));
      }
    },
  });

  reg.tool('pin_message', {
    description: 'Pin a message in a channel.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      await ctx.client.rest.put(`/channels/${channelId}/messages/pins/${messageId}`, {
        body: {},
        reason: args.reason,
      });
      return `Message ${messageId} pinned in channel ${channelId}`;
    },
  });

  reg.tool('unpin_message', {
    description: 'Unpin a message from a channel.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      await ctx.client.rest.delete(`/channels/${channelId}/messages/pins/${messageId}`, {
        reason: args.reason,
      });
      return `Message ${messageId} unpinned from channel ${channelId}`;
    },
  });

  reg.tool('list_pins', {
    description: 'List a channel\u2019s pinned messages.',
    inputSchema: {
      channelId: channelIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const pins = (await ctx.client.rest.get(`/channels/${channelId}/messages/pins`)) as unknown;
      const list = Array.isArray(pins) ? (pins as Array<Record<string, unknown>>) : [];
      if (!list.length) return `Channel ${channelId} has no pinned messages`;
      const lines = list.map((m) => formatMessageLine(normalizeApiMessage(m)));
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('bulk_delete_messages', {
    description:
      'Bulk-delete 2\u2013100 messages from a channel \u2014 either explicit message IDs or the newest N messages.',
    inputSchema: {
      channelId: channelIdParam,
      messageIds: z.array(z.string()).optional().describe('Message IDs to delete (2\u2013100 snowflakes)'),
      count: z
        .number()
        .int()
        .min(2)
        .max(100)
        .optional()
        .describe('Delete this many newest messages instead (2\u2013100)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      let ids: string[];
      if (args.messageIds?.length) {
        ids = [
          ...new Set<string>(args.messageIds.map((id: string) => assertSnowflake('messageIds', id))),
        ];
      } else if (args.count) {
        const channel = await channelOf(channelId);
        const messages = (await channel.messages.fetch({
          limit: args.count,
        })) as unknown as Map<string, Message>;
        ids = [...messages.keys()];
      } else {
        throw new ValidationError(
          'bulk_delete_messages: provide either messageIds (2\u2013100 IDs) or count (2\u2013100)',
        );
      }
      if (ids.length < 2 || ids.length > 100) {
        const via = args.messageIds?.length ? 'messageIds' : 'count';
        throw new ValidationError(`${via}: bulk delete requires 2\u2013100 messages, got ${ids.length}`);
      }
      await ctx.client.rest.post(`/channels/${channelId}/messages/bulk-delete`, {
        body: { messages: ids },
        reason: args.reason,
      });
      return `Deleted ${ids.length} messages from channel ${channelId}`;
    },
  });

  reg.tool('crosspost_message', {
    description: 'Publish (crosspost) a message from an announcement channel to the servers following it.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
    },
    handler: async (args) => {
      const message = await messageOf(args.channelId, args.messageId);
      const published = await message.crosspost();
      return `Message crossposted: ${published.url}`;
    },
  });

  reg.tool('list_reactions', {
    description: 'List the users who reacted to a message with a given emoji.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      emoji: z.string().describe('Emoji to list (unicode like "\u{1F44D}", or custom "name:id")'),
      limit: limitParam(50, 100),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      const emoji = requireEmoji(args.emoji);
      const limit = args.limit ?? 50;
      const users = (await ctx.client.rest.get(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=${limit}`,
      )) as unknown;
      const list = Array.isArray(users) ? (users as Array<{ id: string; username: string }>) : [];
      if (!list.length) return `No ${emoji} reactions on message ${messageId}`;
      const lines = list.map((u) => `${u.username} (id ${u.id})`);
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('clear_reactions', {
    description: 'Clear reactions from a message \u2014 all of them, or just one emoji\u2019s.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      emoji: z.string().optional().describe('Only clear this emoji (unicode or "name:id"); omit to clear all'),
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      if (args.emoji && args.emoji.trim()) {
        const emoji = requireEmoji(args.emoji);
        await ctx.client.rest.delete(
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        );
        return `Cleared ${emoji} reactions from message ${messageId}`;
      }
      await ctx.client.rest.delete(`/channels/${channelId}/messages/${messageId}/reactions`);
      return `Cleared all reactions from message ${messageId}`;
    },
  });

  reg.tool('remove_user_reaction', {
    description: 'Remove a specific user\u2019s reaction from a message.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      emoji: z.string().describe('Emoji to remove (unicode like "\u{1F44D}", or custom "name:id")'),
      userId: userIdParam,
    },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      const userId = assertSnowflake('userId', args.userId);
      const emoji = requireEmoji(args.emoji);
      await ctx.client.rest.delete(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/${userId}`,
      );
      return `Removed ${emoji} reaction by user ${userId} from message ${messageId}`;
    },
  });

  reg.tool('end_poll', {
    description: 'End (expire) a poll on a message early, finalizing its results.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
    },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      await ctx.client.rest.post(`/channels/${channelId}/polls/${messageId}/expire`, { body: {} });
      return `Poll on message ${messageId} ended`;
    },
  });

  reg.tool('get_poll_voters', {
    description: 'List the users who voted for one answer of a poll.',
    inputSchema: {
      channelId: channelIdParam,
      messageId: snowflakeId('Message ID'),
      answerId: snowflakeId('Poll answer ID (1-based, as shown by get_message)'),
      limit: limitParam(25, 100),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const messageId = assertSnowflake('messageId', args.messageId);
      const answerId = requireAnswerId(args.answerId);
      const limit = args.limit ?? 25;
      const voters = (await ctx.client.rest.get(
        `/channels/${channelId}/polls/${messageId}/answers/${answerId}?limit=${limit}`,
      )) as unknown;
      const list = Array.isArray(voters) ? (voters as Array<{ id: string; username: string }>) : [];
      if (!list.length) return `No voters for answer ${answerId} on message ${messageId}`;
      const lines = list.map((u) => `${u.username} (id ${u.id})`);
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('send_typing', {
    description: 'Show the bot\u2019s typing indicator in a channel for ~10 seconds.',
    inputSchema: {
      channelId: channelIdParam,
    },
    handler: async (args) => {
      const channel = await channelOf(args.channelId);
      const withTyping = channel as SendableChannel & { sendTyping?: () => Promise<void> };
      if (typeof withTyping.sendTyping === 'function') {
        await withTyping.sendTyping();
      } else {
        await ctx.client.rest.post(`/channels/${channel.id}/typing`, { body: {} });
      }
      return `Typing indicator sent in channel ${channel.id}`;
    },
  });

  return reg.count;
}
