import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChannelType, ThreadAutoArchiveDuration, type ThreadEditOptions } from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchChannel, fetchGuild, parseIdList, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { truncate } from '../lib/format.js';
import {
  booleanParam,
  channelIdParam,
  createRegistrar,
  guildIdParam,
  limitParam,
  optionalIdListParam,
  reasonParam,
  snowflakeId,
  userIdParam,
} from '../lib/register.js';

// ---------------------------------------------------------------------------
// Structural views over discord.js (same pattern as lib/context.ts
// SendableChannel). The real thread managers carry heavy conditional types
// (forum vs text); these minimal shapes are all the handlers use.
// ---------------------------------------------------------------------------

/** The slice of a created thread that handlers echo back. */
interface ThreadRef {
  id: string;
  name: string;
}

/** A message that can start a public thread attached to itself. */
interface ThreadStarterMessage {
  startThread(options: {
    name: string;
    autoArchiveDuration?: ThreadAutoArchiveDuration;
    rateLimitPerUser?: number;
    reason?: string;
  }): Promise<ThreadRef>;
}

/** A guild channel that can spawn threads (text/announcement — not forum). */
interface ThreadHostChannel {
  id: string;
  type?: number;
  threads?: {
    create(options: {
      name: string;
      type?: ChannelType.PublicThread | ChannelType.PrivateThread;
      autoArchiveDuration?: ThreadAutoArchiveDuration;
      invitable?: boolean;
      rateLimitPerUser?: number;
      reason?: string;
    }): Promise<ThreadRef>;
  };
  messages?: { fetch(id: string): Promise<ThreadStarterMessage> };
}

/** Raw REST thread object slice used by the list tools. */
interface RawThreadSummary {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  member_count?: number | null;
}

/** Raw REST thread member object (`with_member=true` adds the `member` field). */
interface RawThreadMember {
  id?: string;
  user_id?: string;
  join_timestamp?: string;
  member?: { user?: { username?: string; global_name?: string | null } };
}

const THREAD_TYPE_LABELS: Record<number, string> = {
  [ChannelType.AnnouncementThread]: 'announcement thread',
  [ChannelType.PublicThread]: 'public thread',
  [ChannelType.PrivateThread]: 'private thread',
};

/** `#name (id X, type, parent <parentId>, N members)` — one line per thread, sorted by name. */
function formatThreadLines(threads: RawThreadSummary[]): string {
  const lines = threads
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((t) => {
      const label = THREAD_TYPE_LABELS[t.type] ?? `type ${t.type}`;
      return `#${t.name} (id ${t.id}, ${label}, parent ${t.parent_id ?? 'none'}, ${t.member_count ?? '?'} members)`;
    });
  return truncate(lines.join('\n'));
}

/** Reject channels that cannot host a new thread, with a pointed message. */
function assertThreadHost(channel: ThreadHostChannel, channelId: string, withMessage: boolean): void {
  if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
    throw new ValidationError(
      `channelId: ${channelId} is a forum/media channel — create a forum post there instead`,
    );
  }
  if (!channel.threads || typeof channel.threads.create !== 'function') {
    throw new ValidationError(
      `channelId: ${channelId} cannot hold threads (use a text or announcement channel)`,
    );
  }
  if (withMessage && (!channel.messages || typeof channel.messages.fetch !== 'function')) {
    throw new ValidationError(`channelId: ${channelId} cannot hold messages`);
  }
}

/**
 * Thread tools: list active/archived threads, create and edit threads, and
 * manage thread membership. Threads are channels — address them by their
 * thread (channel) ID.
 * Returns the number of tools registered.
 */
export function registerThreadTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('list_active_threads', {
    description:
      'List all active (unarchived) threads in the server with type, parent channel and member count, sorted by name.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const body = (await ctx.client.rest.get(`/guilds/${guild.id}/threads/active`)) as {
        threads?: RawThreadSummary[];
      };
      return formatThreadLines(body.threads ?? []) || '(no active threads)';
    },
  });

  reg.tool('create_thread', {
    description:
      'Create a thread in a text channel. With messageId it starts a public thread attached to that message; ' +
      'otherwise it creates a standalone public or private thread.',
    inputSchema: {
      channelId: channelIdParam,
      name: z.string().min(1).max(100).describe('Thread name (1-100 chars)'),
      messageId: snowflakeId('Message ID to start the thread from (always a public thread; ignores private/invitable)')
        .optional(),
      private: booleanParam('Create a private thread (ignored when messageId is given)'),
      autoArchiveMinutes: z
        .nativeEnum(ThreadAutoArchiveDuration)
        .optional()
        .describe('Auto-archive after this many minutes of inactivity (60, 1440, 4320 or 10080)'),
      invitable: booleanParam('Whether non-moderators can invite others (private threads only)'),
      slowmodeSeconds: z.number().int().min(0).max(21600).optional().describe('Initial slowmode in seconds (0-21600)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const channel = await fetchChannel<ThreadHostChannel>(ctx, args.channelId);
      assertThreadHost(channel, args.channelId, Boolean(args.messageId));
      const archive = args.autoArchiveMinutes as ThreadAutoArchiveDuration | undefined;
      const common = {
        name: args.name as string,
        ...(archive !== undefined ? { autoArchiveDuration: archive } : {}),
        ...(args.slowmodeSeconds !== undefined ? { rateLimitPerUser: args.slowmodeSeconds as number } : {}),
        ...(args.reason ? { reason: args.reason as string } : {}),
      };
      if (args.messageId) {
        const messageId = assertSnowflake('messageId', args.messageId);
        let message: ThreadStarterMessage;
        try {
          message = await channel.messages!.fetch(messageId);
        } catch {
          throw new ValidationError(`messageId: message ${messageId} not found in channel ${args.channelId}`);
        }
        const thread = await message.startThread(common);
        return `Started public thread "${thread.name}" (id ${thread.id}) from message ${messageId}`;
      }
      if (args.invitable !== undefined && !args.private) {
        throw new ValidationError('invitable: only private threads can set invitable');
      }
      const thread = await channel.threads!.create({
        ...common,
        type: args.private ? ChannelType.PrivateThread : ChannelType.PublicThread,
        ...(args.invitable !== undefined ? { invitable: args.invitable as boolean } : {}),
      });
      return `Created ${args.private ? 'private' : 'public'} thread "${thread.name}" (id ${thread.id}) in channel ${args.channelId}`;
    },
  });

  reg.tool('edit_thread', {
    description:
      'Edit a thread: rename, archive/unarchive, lock/unlock, change auto-archive duration, slowmode, ' +
      'or (forum posts only) applied tags. Provide only the fields to change.',
    inputSchema: {
      threadId: snowflakeId('Thread (channel) ID'),
      name: z.string().min(1).max(100).optional().describe('New thread name'),
      archived: booleanParam('Archive (true) or unarchive (false) the thread'),
      locked: booleanParam('Lock (true) or unlock (false) the thread'),
      autoArchiveMinutes: z
        .nativeEnum(ThreadAutoArchiveDuration)
        .optional()
        .describe('Auto-archive after this many minutes of inactivity (60, 1440, 4320 or 10080)'),
      slowmodeSeconds: z.number().int().min(0).max(21600).optional().describe('New slowmode in seconds (0-21600)'),
      appliedTagIds: optionalIdListParam('forum tag IDs to apply (forum posts only; empty string clears tags)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const threadId = assertSnowflake('threadId', args.threadId);
      const channel = await fetchChannel(ctx, threadId);
      if (!channel.isThread()) {
        throw new ValidationError(`threadId: ${threadId} is not a thread channel`);
      }
      const options: ThreadEditOptions = {};
      if (args.name !== undefined) options.name = args.name;
      if (args.archived !== undefined) options.archived = args.archived;
      if (args.locked !== undefined) options.locked = args.locked;
      if (args.autoArchiveMinutes !== undefined) options.autoArchiveDuration = args.autoArchiveMinutes;
      if (args.slowmodeSeconds !== undefined) options.rateLimitPerUser = args.slowmodeSeconds;
      if (args.appliedTagIds !== undefined) options.appliedTags = parseIdList('appliedTagIds', args.appliedTagIds);
      const changed = Object.keys(options);
      if (!changed.length) {
        throw new ValidationError(
          'edit_thread: provide at least one of name, archived, locked, autoArchiveMinutes, slowmodeSeconds, appliedTagIds',
        );
      }
      if (args.reason !== undefined) options.reason = args.reason;
      const updated = await channel.edit(options);
      return `Thread "${updated.name}" (id ${updated.id}) updated (${changed.join(', ')})`;
    },
  });

  reg.tool('add_thread_member', {
    description: 'Add a user to a thread (also grants visibility into a private thread).',
    inputSchema: {
      threadId: snowflakeId('Thread (channel) ID'),
      userId: userIdParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const threadId = assertSnowflake('threadId', args.threadId);
      const userId = assertSnowflake('userId', args.userId);
      await ctx.client.rest.put(`/channels/${threadId}/thread-members/${userId}`);
      return `Added user ${userId} to thread ${threadId}`;
    },
  });

  reg.tool('remove_thread_member', {
    description: 'Remove a user from a thread.',
    inputSchema: {
      threadId: snowflakeId('Thread (channel) ID'),
      userId: userIdParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const threadId = assertSnowflake('threadId', args.threadId);
      const userId = assertSnowflake('userId', args.userId);
      await ctx.client.rest.delete(`/channels/${threadId}/thread-members/${userId}`);
      return `Removed user ${userId} from thread ${threadId}`;
    },
  });

  reg.tool('list_thread_members', {
    description: 'List the members of a thread with join timestamps.',
    inputSchema: {
      threadId: snowflakeId('Thread (channel) ID'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const threadId = assertSnowflake('threadId', args.threadId);
      const raw = (await ctx.client.rest.get(`/channels/${threadId}/thread-members`, {
        query: new URLSearchParams({ with_member: 'true' }),
      })) as RawThreadMember[];
      const members = Array.isArray(raw) ? raw : [];
      const lines = members.map((m) => {
        const id = String(m.id ?? m.user_id ?? '?');
        const username =
          m.member?.user?.global_name ?? m.member?.user?.username ?? m.user_id ?? id;
        return `${username} (id ${id}, joined ${m.join_timestamp ?? 'unknown'})`;
      });
      return truncate(lines.join('\n')) || '(no members)';
    },
  });

  reg.tool('join_thread', {
    description: 'Make the bot join a thread (keeps it unarchived and lets the bot post in it).',
    inputSchema: {
      threadId: snowflakeId('Thread (channel) ID'),
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const threadId = assertSnowflake('threadId', args.threadId);
      await ctx.client.rest.put(`/channels/${threadId}/thread-members/@me`);
      return `Joined thread ${threadId}`;
    },
  });

  reg.tool('leave_thread', {
    description: 'Make the bot leave a thread.',
    inputSchema: {
      threadId: snowflakeId('Thread (channel) ID'),
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const threadId = assertSnowflake('threadId', args.threadId);
      await ctx.client.rest.delete(`/channels/${threadId}/thread-members/@me`);
      return `Left thread ${threadId}`;
    },
  });

  reg.tool('list_archived_threads', {
    description:
      'List archived public (or private) threads of a channel with member counts, sorted by name. ' +
      'Private archived threads additionally require the Manage Threads permission.',
    inputSchema: {
      channelId: channelIdParam,
      private: booleanParam('List private archived threads instead of public'),
      before: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp: only list threads archived before this time (for paging)'),
      limit: limitParam(50, 100),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      const query = new URLSearchParams();
      if (args.before) {
        if (Number.isNaN(Date.parse(args.before))) {
          throw new ValidationError(`before: "${args.before}" is not an ISO 8601 timestamp`);
        }
        query.set('before', args.before);
      }
      if (args.limit !== undefined) query.set('limit', String(args.limit));
      const body = (await ctx.client.rest.get(
        `/channels/${channelId}/threads/archived/${args.private ? 'private' : 'public'}`,
        { query },
      )) as { threads?: RawThreadSummary[] };
      return formatThreadLines(body.threads ?? []) || '(no archived threads)';
    },
  });

  return reg.count;
}
