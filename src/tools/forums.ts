import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ChannelFlags,
  ChannelType,
  ForumLayoutType,
  SortOrderType,
  type ForumChannel,
  type GuildForumTag,
  type GuildForumTagData,
  type GuildForumTagEmoji,
  type NonThreadGuildBasedChannel,
  type ThreadChannel,
  type ThreadEditOptions,
  type ThreadOnlyChannel,
} from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchChannel, fetchGuild, parseIdList, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { formatChannelLine, jumpLine, truncate } from '../lib/format.js';
import { buildSendOptions, richSendShape } from '../lib/messages.js';
import {
  booleanParam,
  channelIdParam,
  createRegistrar,
  guildIdParam,
  optionalIdListParam,
  reasonParam,
} from '../lib/register.js';

const MAX_TAGS = 20;
const MAX_APPLIED_TAGS = 5;

const SORT_NAMES: Record<number, string> = {
  [SortOrderType.LatestActivity]: 'RECENT_ACTIVITY',
  [SortOrderType.CreationDate]: 'CREATION_TIME',
};

const LAYOUT_NAMES: Record<number, string> = {
  [ForumLayoutType.ListView]: 'LIST_VIEW',
  [ForumLayoutType.GalleryView]: 'GALLERY_VIEW',
};

function mapSortOrder(value: string): SortOrderType {
  const map: Record<string, SortOrderType> = {
    RECENT_ACTIVITY: SortOrderType.LatestActivity,
    CREATION_TIME: SortOrderType.CreationDate,
  };
  const mapped = map[value] as SortOrderType | undefined;
  if (mapped === undefined) {
    throw new ValidationError(`defaultSort: "${value}" must be RECENT_ACTIVITY or CREATION_TIME`);
  }
  return mapped;
}

function mapForumLayout(value: string): ForumLayoutType {
  const map: Record<string, ForumLayoutType> = {
    LIST_VIEW: ForumLayoutType.ListView,
    GALLERY_VIEW: ForumLayoutType.GalleryView,
  };
  const mapped = map[value] as ForumLayoutType | undefined;
  if (mapped === undefined) {
    throw new ValidationError(`defaultLayout: "${value}" must be LIST_VIEW or GALLERY_VIEW`);
  }
  return mapped;
}

/** Parse a tag emoji: a unicode emoji, "name:id", or "<:name:id>" (custom emoji send the id only). */
function parseTagEmoji(emoji: string): GuildForumTagEmoji {
  const value = emoji.trim();
  if (!value) throw new ValidationError('emoji: required');
  const full = value.match(/^<a?:(\w+):(\d{15,21})>$/);
  if (full) return { name: null, id: full[2]! };
  const short = value.match(/^(\w+):(\d{15,21})$/);
  if (short) return { name: null, id: short[2]! };
  return { name: value, id: null };
}

function formatTagLine(tag: GuildForumTag): string {
  const emoji = !tag.emoji
    ? 'no emoji'
    : tag.emoji.id
      ? `emoji <:${tag.emoji.name ?? 'emoji'}:${tag.emoji.id}>`
      : tag.emoji.name
        ? `emoji ${tag.emoji.name}`
        : 'no emoji';
  return `${tag.name} (id ${tag.id}, ${emoji}${tag.moderated ? ', moderated' : ''})`;
}

/**
 * Forum tools: forum/media channel management, posts, and tags. Returns the
 * number of tools registered.
 */
export function registerForumTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  async function fetchForumChannel(channelId: string): Promise<ThreadOnlyChannel> {
    const channel = await fetchChannel<ThreadOnlyChannel>(ctx, channelId);
    if (channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia) {
      throw new ValidationError(`channelId: ${channelId} is not a forum or media channel`);
    }
    return channel;
  }

  /** When a guildId is in play, make sure the channel actually lives in that server. */
  function assertChannelInGuild(channel: { guildId?: string | null }, guildId?: string): void {
    const expected = guildId?.trim() || ctx.defaultGuildId;
    if (expected && channel.guildId && channel.guildId !== expected) {
      throw new ValidationError(
        `channelId: this channel belongs to server ${channel.guildId}, not ${expected}`,
      );
    }
  }

  const slowmodeParam = z
    .number()
    .int()
    .min(0)
    .max(21600)
    .optional()
    .describe('Default slowmode for new posts in seconds (0-21600)');

  const positionParam = z.number().int().min(0).optional().describe('Position in channel list');

  reg.tool('create_forum_channel', {
    description: 'Create a new forum channel',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).max(100).describe('Channel name'),
      categoryId: z.string().optional().describe('Category ID'),
      topic: z.string().max(4096).optional().describe('Default post guidelines / topic'),
      nsfw: booleanParam('Whether channel is NSFW'),
      slowmode: slowmodeParam,
      position: positionParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const channel = await guild.channels.create({
        name: args.name,
        type: ChannelType.GuildForum,
        ...(args.categoryId ? { parent: assertSnowflake('categoryId', args.categoryId) } : {}),
        ...(args.topic !== undefined ? { topic: args.topic } : {}),
        ...(args.nsfw !== undefined ? { nsfw: args.nsfw } : {}),
        ...(args.slowmode !== undefined ? { defaultThreadRateLimitPerUser: args.slowmode } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Forum channel "${channel.name}" created (id ${channel.id})`;
    },
  });

  reg.tool('edit_forum_channel', {
    description:
      'Edit settings of a forum channel (name, topic, nsfw, slowmode, category, position, default sort, default layout)',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      name: z.string().min(1).max(100).optional().describe('New channel name'),
      topic: z.string().max(4096).optional().describe('New channel topic / post guidelines'),
      nsfw: booleanParam('Whether channel is NSFW'),
      slowmode: slowmodeParam,
      categoryId: z.string().optional().describe('Category ID (empty to remove from category)'),
      position: positionParam,
      defaultSort: z
        .enum(['RECENT_ACTIVITY', 'CREATION_TIME'])
        .optional()
        .describe('Default sort order: RECENT_ACTIVITY or CREATION_TIME'),
      defaultLayout: z
        .enum(['LIST_VIEW', 'GALLERY_VIEW'])
        .optional()
        .describe('Default layout: LIST_VIEW or GALLERY_VIEW (forum channels only)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchForumChannel(args.channelId);
      assertChannelInGuild(channel, args.guildId);
      const provided =
        args.name !== undefined ||
        args.topic !== undefined ||
        args.nsfw !== undefined ||
        args.slowmode !== undefined ||
        args.categoryId !== undefined ||
        args.position !== undefined ||
        args.defaultSort !== undefined ||
        args.defaultLayout !== undefined;
      if (!provided) {
        throw new ValidationError(
          'provide at least one of name, topic, nsfw, slowmode, categoryId, position, defaultSort, defaultLayout',
        );
      }
      const defaultSortOrder =
        args.defaultSort !== undefined ? mapSortOrder(args.defaultSort) : undefined;
      const defaultForumLayout =
        args.defaultLayout !== undefined ? mapForumLayout(args.defaultLayout) : undefined;
      if (defaultForumLayout !== undefined && channel.type === ChannelType.GuildMedia) {
        throw new ValidationError('defaultLayout: media channels do not support a default layout');
      }
      await channel.edit({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.topic !== undefined ? { topic: args.topic } : {}),
        ...(args.nsfw !== undefined ? { nsfw: args.nsfw } : {}),
        ...(args.slowmode !== undefined ? { defaultThreadRateLimitPerUser: args.slowmode } : {}),
        ...(args.categoryId !== undefined
          ? { parent: args.categoryId === '' ? null : assertSnowflake('categoryId', args.categoryId) }
          : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(defaultSortOrder !== undefined ? { defaultSortOrder } : {}),
        ...(defaultForumLayout !== undefined ? { defaultForumLayout } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Forum channel "${channel.name}" (id ${channel.id}) updated`;
    },
  });

  reg.tool('list_forum_channels', {
    description: 'List all forum (and media) channels in the server',
    inputSchema: {
      guildId: guildIdParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const channels = await guild.channels.fetch();
      const lines = [...channels.values()]
        .filter((c): c is NonThreadGuildBasedChannel => c !== null)
        .filter((c) => c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia)
        .sort((a, b) => a.rawPosition - b.rawPosition || a.id.localeCompare(b.id))
        .map((c) => {
          const forum = c as ThreadOnlyChannel;
          return formatChannelLine({
            id: forum.id,
            name: forum.name,
            type: forum.type,
            topic: forum.topic ?? null,
            parentId: forum.parentId,
          });
        });
      return truncate(lines.join('\n')) || '(no forum channels)';
    },
  });

  reg.tool('get_forum_channel_info', {
    description: 'Get detailed information about a forum channel including tags and settings',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
    },
    handler: async (args) => {
      const channel = await fetchForumChannel(args.channelId);
      assertChannelInGuild(channel, args.guildId);
      // Required-tags is newer than discord.js' parser — read it from the raw channel object.
      let requiredTags: string[] | undefined;
      try {
        const raw = (await ctx.client.rest.get(`/channels/${channel.id}`)) as {
          required_tags?: unknown;
        };
        if (Array.isArray(raw?.required_tags)) {
          requiredTags = raw.required_tags.map((id) => String(id));
        }
      } catch {
        // best effort — the field simply may not exist
      }
      const lines: string[] = [
        `#${channel.name} (id ${channel.id}, ${
          channel.type === ChannelType.GuildForum ? 'forum' : 'media'
        } channel)`,
        channel.topic ? `topic/guidelines: ${channel.topic}` : 'topic/guidelines: (none)',
        `default slowmode: ${channel.defaultThreadRateLimitPerUser ?? 0}s`,
        `default sort order: ${
          channel.defaultSortOrder === null
            ? 'not set'
            : (SORT_NAMES[channel.defaultSortOrder] ?? String(channel.defaultSortOrder))
        }`,
      ];
      if (channel.type === ChannelType.GuildForum) {
        const layout = (channel as ForumChannel).defaultForumLayout;
        lines.push(`default layout: ${LAYOUT_NAMES[layout] ?? String(layout)}`);
      }
      lines.push(
        `requires a tag on new posts: ${channel.flags.has(ChannelFlags.RequireTag) ? 'yes' : 'no'}`,
      );
      if (channel.availableTags.length) {
        lines.push('tags:');
        for (const tag of channel.availableTags) lines.push(`- ${formatTagLine(tag)}`);
      } else {
        lines.push('tags: (none)');
      }
      if (requiredTags?.length) lines.push(`requiredTags: ${requiredTags.join(', ')}`);
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('list_forum_tags', {
    description: 'List all available tags in a forum channel',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
    },
    handler: async (args) => {
      const channel = await fetchForumChannel(args.channelId);
      assertChannelInGuild(channel, args.guildId);
      const lines = channel.availableTags.map((tag) => formatTagLine(tag));
      return truncate(lines.join('\n')) || '(no tags configured)';
    },
  });

  reg.tool('create_forum_post', {
    description:
      'Create a new forum post (thread) with an initial message in a forum or media channel. ' +
      'Supports embeds, components, polls and files.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      title: z.string().min(1).max(100).describe('Post title'),
      ...richSendShape,
      // richSendShape declares this one as required-shaped; a forum post's
      // opener cannot be a reply, so keep it optional here.
      replyToMessageId: richSendShape.replyToMessageId.optional(),
      tagIds: optionalIdListParam('tag IDs to apply'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const messageOptions = await buildSendOptions(args);
      const forum = await fetchForumChannel(args.channelId);
      assertChannelInGuild(forum, args.guildId);
      const tagIds = parseIdList('tagIds', args.tagIds);
      if (tagIds.length > MAX_APPLIED_TAGS) {
        throw new ValidationError(`tagIds: at most ${MAX_APPLIED_TAGS} tags can be applied to a post`);
      }
      const thread = await forum.threads.create({
        name: args.title,
        message: messageOptions,
        ...(tagIds.length ? { appliedTags: tagIds } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      const firstMessageId = thread.lastMessageId;
      const url = firstMessageId
        ? jumpLine('Post:', firstMessageId, thread.id, thread.guildId)
        : `Post: https://discord.com/channels/${thread.guildId}/${thread.id}`;
      return (
        `Forum post "${thread.name}" created in #${forum.name} (post id ${thread.id}` +
        `${firstMessageId ? `, first message id ${firstMessageId}` : ''})\n${url}`
      );
    },
  });

  reg.tool('list_forum_posts', {
    description: 'List active posts (threads) in a forum channel',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
    },
    handler: async (args) => {
      const forum = await fetchForumChannel(args.channelId);
      assertChannelInGuild(forum, args.guildId);
      const { threads } = await forum.threads.fetchActive();
      const tagNames = new Map(forum.availableTags.map((tag) => [tag.id, tag.name]));
      const lines = [...threads.values()]
        .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))
        .map((thread) => {
          const tags = (thread.appliedTags ?? [])
            .map((id) => tagNames.get(id) ?? id)
            .join(', ');
          return `${thread.name} (id ${thread.id}, ${thread.messageCount ?? 0} messages${
            tags ? `, tags: ${tags}` : ''
          })`;
        });
      return truncate(lines.join('\n')) || '(no active posts)';
    },
  });

  reg.tool('modify_forum_post', {
    description:
      'Modify a forum post: lock/unlock, archive/unarchive, pin/unpin, or change applied tags',
    inputSchema: {
      guildId: guildIdParam,
      postId: z.string().describe('Forum post (thread) ID'),
      locked: booleanParam('Lock state'),
      archived: booleanParam('Archive state'),
      pinned: booleanParam('Pin state'),
      tagIds: z
        .string()
        .optional()
        .describe('Comma-separated tag IDs to set (empty string to clear)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchChannel<ThreadChannel>(ctx, args.postId);
      if (
        channel.type !== ChannelType.PublicThread &&
        channel.type !== ChannelType.AnnouncementThread &&
        channel.type !== ChannelType.PrivateThread
      ) {
        throw new ValidationError(`postId: ${args.postId} is not a forum post (thread)`);
      }
      const thread = channel as ThreadChannel<true>;
      assertChannelInGuild(thread, args.guildId);
      const editOptions: ThreadEditOptions = {};
      const editChanged: string[] = [];
      if (args.archived !== undefined) {
        editOptions.archived = args.archived;
        editChanged.push(args.archived ? 'archived' : 'unarchived');
      }
      if (args.locked !== undefined) {
        editOptions.locked = args.locked;
        editChanged.push(args.locked ? 'locked' : 'unlocked');
      }
      if (args.tagIds !== undefined) {
        editOptions.appliedTags = parseIdList('tagIds', args.tagIds);
        editChanged.push(
          editOptions.appliedTags.length
            ? `tags set to ${editOptions.appliedTags.join(', ')}`
            : 'tags cleared',
        );
      }
      if (!editChanged.length && args.pinned === undefined) {
        throw new ValidationError('provide at least one of locked, archived, pinned, tagIds');
      }
      if (editChanged.length) {
        await thread.edit({ ...editOptions, ...(args.reason ? { reason: args.reason } : {}) });
      }
      const changed = [...editChanged];
      if (args.pinned !== undefined) {
        if (args.pinned) {
          await thread.pin(args.reason);
        } else {
          await thread.unpin(args.reason);
        }
        changed.push(args.pinned ? 'pinned' : 'unpinned');
      }
      return `Forum post "${thread.name}" (id ${thread.id}) ${changed.join(', ')}`;
    },
  });

  reg.tool('create_forum_tag', {
    description: 'Add a new tag to a forum (or media) channel',
    inputSchema: {
      channelId: channelIdParam,
      name: z.string().min(1).max(20).describe('Tag name (max 20 chars)'),
      emoji: z
        .string()
        .max(128)
        .optional()
        .describe('Tag emoji: a unicode emoji, or a custom emoji as "name:id"'),
      moderated: booleanParam('Only members with Manage Threads can apply/remove this tag'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchForumChannel(args.channelId);
      const name = args.name.trim();
      if (!name) throw new ValidationError('name: required');
      if (channel.availableTags.length >= MAX_TAGS) {
        throw new ValidationError(
          `name: #${channel.name} already has the maximum of ${MAX_TAGS} tags — remove one first`,
        );
      }
      const tag: GuildForumTagData = {
        name,
        ...(args.emoji !== undefined ? { emoji: parseTagEmoji(args.emoji) } : {}),
        ...(args.moderated !== undefined ? { moderated: args.moderated } : {}),
      };
      await channel.edit({
        availableTags: [...channel.availableTags, tag],
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Tag "${name}" added to #${channel.name}`;
    },
  });

  reg.tool('edit_forum_tag', {
    description: 'Edit an existing tag (name, emoji, moderated) on a forum or media channel',
    inputSchema: {
      channelId: channelIdParam,
      tagId: z.string().describe('Forum tag ID'),
      name: z.string().min(1).max(20).optional().describe('New tag name'),
      emoji: z
        .string()
        .max(128)
        .optional()
        .describe('New tag emoji: a unicode emoji, or a custom emoji as "name:id"'),
      moderated: booleanParam('Only members with Manage Threads can apply/remove this tag'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchForumChannel(args.channelId);
      const tagId = assertSnowflake('tagId', args.tagId);
      const existing = channel.availableTags.find((tag) => tag.id === tagId);
      if (!existing) {
        throw new ValidationError(`tagId: no tag with id ${tagId} on #${channel.name}`);
      }
      const name = args.name !== undefined ? args.name.trim() : existing.name;
      if (!name) throw new ValidationError('name: required');
      const updated: GuildForumTagData = {
        id: existing.id,
        name,
        moderated: args.moderated !== undefined ? args.moderated : existing.moderated,
        emoji: args.emoji !== undefined ? parseTagEmoji(args.emoji) : existing.emoji,
      };
      await channel.edit({
        availableTags: channel.availableTags.map((tag) => (tag.id === tagId ? updated : tag)),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Tag "${name}" (id ${tagId}) updated on #${channel.name}`;
    },
  });

  reg.tool('delete_forum_tag', {
    description: 'Remove a tag from a forum (or media) channel',
    inputSchema: {
      channelId: channelIdParam,
      tagId: z.string().describe('Forum tag ID'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchForumChannel(args.channelId);
      const tagId = assertSnowflake('tagId', args.tagId);
      const existing = channel.availableTags.find((tag) => tag.id === tagId);
      if (!existing) {
        throw new ValidationError(`tagId: no tag with id ${tagId} on #${channel.name}`);
      }
      await channel.edit({
        availableTags: channel.availableTags.filter((tag) => tag.id !== tagId),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Tag "${existing.name}" (id ${tagId}) removed from #${channel.name}`;
    },
  });

  return reg.count;
}
