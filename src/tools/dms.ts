import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DMChannel, Message } from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchGuild, isoTime, type ToolContext } from '../lib/context.js';
import { formatMessageLine, formatUserLine, fromDiscordMessage, truncate } from '../lib/format.js';
import { buildEditOptions, buildSendOptions, richEditShape, richSendShape } from '../lib/messages.js';
import { createRegistrar, limitParam, snowflakeId, userIdParam } from '../lib/register.js';

/**
 * DM tools (legacy send/edit/delete/read + get_user_id_by_name) plus get_user.
 * DM channels are addressed by user ID; message tools accept them unchanged.
 * Returns the number of tools registered.
 */
export function registerDmTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  async function dmChannel(userId: string): Promise<DMChannel> {
    const id = assertSnowflake('userId', userId);
    try {
      return await ctx.client.users.createDM(id);
    } catch {
      throw new Error(`userId: cannot open a DM with ${id} (user blocked the bot or closed DMs)`);
    }
  }

  async function dmMessage(userId: string, messageId: string): Promise<Message> {
    const channel = await dmChannel(userId);
    const id = assertSnowflake('messageId', messageId);
    try {
      return (await channel.messages.fetch(id)) as Message;
    } catch {
      throw new Error(`messageId: message ${id} not found in DMs with ${userId}`);
    }
  }

  async function readHistory(userId: string, args: {
    count?: number;
    before?: string;
    after?: string;
    around?: string;
  }): Promise<string> {
    const channel = await dmChannel(userId);
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

  reg.tool('send_private_message', {
    description:
      'Send a private message (DM) to a user from the bot. Supports embeds, components, polls and files.',
    inputSchema: {
      userId: userIdParam,
      ...richSendShape,
    },
    handler: async (args) => {
      const options = await buildSendOptions(args);
      const channel = await dmChannel(args.userId);
      const sent = (await channel.send(options)) as Message;
      return `DM sent to user ${args.userId}: message id ${sent.id}`;
    },
  });

  reg.tool('edit_private_message', {
    description: 'Edit a private message the bot previously sent to a user.',
    inputSchema: {
      userId: userIdParam,
      messageId: snowflakeId('Message ID'),
      ...richEditShape,
    },
    handler: async (args) => {
      const message = await dmMessage(args.userId, args.messageId);
      const options = await buildEditOptions(args, [...message.attachments.values()].map((a) => ({
        id: a.id,
        filename: a.name,
        description: a.description,
      })));
      await message.edit(options);
      return `DM message ${args.messageId} edited`;
    },
  });

  reg.tool('delete_private_message', {
    description: 'Delete a private message the bot previously sent to a user.',
    inputSchema: {
      userId: userIdParam,
      messageId: snowflakeId('Message ID'),
    },
    handler: async (args) => {
      const message = await dmMessage(args.userId, args.messageId);
      await message.delete();
      return `DM message ${args.messageId} deleted`;
    },
  });

  reg.tool('read_private_messages', {
    description: 'Read the bot\u2019s private message history with a user, newest last.',
    inputSchema: {
      userId: userIdParam,
      count: limitParam(10, 100).describe('Number of messages to retrieve (default 10)'),
      before: z.string().optional().describe('Message ID: fetch messages before this one'),
      after: z.string().optional().describe('Message ID: fetch messages after this one'),
      around: z.string().optional().describe('Message ID: fetch messages around this one'),
    },
    handler: async (args) => readHistory(args.userId, args),
  });

  reg.tool('get_user_id_by_name', {
    description: 'Find a member\u2019s user ID by username or display name, for ping usage <@id>.',
    inputSchema: {
      username: z.string().describe('Discord username, display name, or username#discriminator'),
      guildId: z.string().optional().describe('Discord server ID (optional; defaults to DISCORD_GUILD_ID)'),
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      let name = args.username.trim();
      let discriminator: string | null = null;
      if (name.includes('#')) {
        const idx = name.lastIndexOf('#');
        discriminator = name.slice(idx + 1);
        name = name.slice(0, idx);
      }
      const needle = name.toLowerCase();
      const matches = new Map<string, { username: string; displayName: string }>();
      for (const member of guild.members.cache.values()) {
        if (
          member.user.username.toLowerCase() === needle ||
          (member.displayName ?? '').toLowerCase() === needle ||
          (member.user.globalName ?? '').toLowerCase() === needle
        ) {
          matches.set(member.id, {
            username: member.user.username,
            displayName: member.displayName,
          });
        }
      }
      if (!matches.size) {
        // REST member search (works without the members intent, needs no cache).
        const found = (await guild.members.search({ query: name, limit: 25 })) as unknown as Array<{
          id: string;
          user: { username: string; globalName?: string | null };
          displayName?: string;
        }>;
        for (const m of found) {
          if (
            m.user.username.toLowerCase() === needle ||
            (m.displayName ?? m.user.globalName ?? '').toLowerCase() === needle
          ) {
            matches.set(m.id, {
              username: m.user.username,
              displayName: m.displayName ?? m.user.globalName ?? m.user.username,
            });
          }
        }
      }
      if (discriminator && discriminator !== '0') {
        // Legacy username#discrim is gone; exact-name matches already suffice.
      }
      if (!matches.size) {
        throw new Error(`No user found with username "${args.username}" in this server`);
      }
      const lines = [...matches.entries()].slice(0, 10).map(([id, m]) =>
        m.displayName && m.displayName !== m.username
          ? `${m.username} aka ${m.displayName}: <@${id}> (id ${id})`
          : `${m.username}: <@${id}> (id ${id})`,
      );
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('get_user', {
    description: 'Get a Discord user\u2019s profile basics (works for users outside this server).',
    inputSchema: {
      userId: userIdParam,
    },
    handler: async (args) => {
      const id = assertSnowflake('userId', args.userId);
      const user = await ctx.client.users.fetch(id);
      const line = formatUserLine({
        id: user.id,
        username: user.username,
        displayName: user.globalName ?? undefined,
        bot: user.bot,
      });
      return `${line}, created ${isoTime(user.createdTimestamp)}`;
    },
  });

  return reg.count;
}
