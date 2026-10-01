import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ChannelType,
  ForumLayoutType,
  OverwriteType,
  SortOrderType,
  VideoQualityMode,
  type DefaultReactionEmoji,
  type GuildChannelCreateOptions,
  type GuildChannelEditOptions,
  type GuildForumTagData,
  type GuildForumTagEmoji,
  type Invite,
  type NonThreadGuildBasedChannel,
  type ThreadAutoArchiveDuration,
} from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchChannel, fetchGuild, isoTime, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { formatChannelLine, truncate } from '../lib/format.js';
import { parsePermissionBits, parsePermissionNames, permissionNames } from '../lib/permissions.js';
import {
  channelIdParam,
  createRegistrar,
  guildIdParam,
  jsonParam,
  reasonParam,
  roleIdParam,
  snowflakeId,
  userIdParam,
} from '../lib/register.js';
import { parseJsonParam } from '../lib/validation.js';

/**
 * Channel/category tools: the 16 legacy channel, category and channel-permission
 * tools (exact legacy param names) plus generic create_channel / edit_channel,
 * follow_announcement_channel and list_channel_invites.
 * Returns the number of tools registered.
 */
export function registerChannelTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  // -------------------------------------------------------------------------
  // Local input helpers. Legacy tools declared every param as a String, so
  // boolean/number params accept both native JSON values and their string
  // spellings ("true", "60").
  // -------------------------------------------------------------------------

  /** Parse a boolean-ish param; "" counts as false (legacy Boolean.parseBoolean parity). */
  function parseBoolParam(name: string, value: boolean | string | undefined): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === '' || v === 'false' || v === '0' || v === 'no') return false;
    throw new ValidationError(`${name}: "${value}" is not a boolean (use true or false)`);
  }

  /** Parse an integer param; "" counts as "not provided". */
  function parseIntParam(
    name: string,
    value: number | string | undefined,
    min?: number,
    max?: number,
  ): number | undefined {
    if (value === undefined || value === null) return undefined;
    let n: number;
    if (typeof value === 'number') {
      n = value;
    } else {
      const v = value.trim();
      if (v === '') return undefined;
      if (!/^-?\d+$/.test(v)) throw new ValidationError(`${name}: "${value}" is not a whole number`);
      n = Number.parseInt(v, 10);
    }
    if (!Number.isInteger(n)) throw new ValidationError(`${name}: "${value}" must be a whole number`);
    if (min !== undefined && n < min) throw new ValidationError(`${name}: ${n} is below the minimum ${min}`);
    if (max !== undefined && n > max) throw new ValidationError(`${name}: ${n} is above the maximum ${max}`);
    return n;
  }

  function checkedName(name: string | undefined): string {
    const n = (name ?? '').trim();
    if (!n) throw new ValidationError('name: required');
    if (n.length > 100) throw new ValidationError(`name: ${n.length} chars > 100`);
    return n;
  }

  /** Resolve one permission value: numeric bitfield string or CSV of names. "" → skip. */
  function permBits(value: string | undefined, param: string): bigint | undefined {
    const v = value?.trim();
    if (!v) return undefined;
    return /^\d+$/.test(v) ? parsePermissionBits(v, param) : parsePermissionNames(v, param);
  }

  /** OR two optional bitfields together; undefined only when both are undefined. */
  function combineBits(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
    if (a === undefined && b === undefined) return undefined;
    return (a ?? 0n) | (b ?? 0n);
  }

  function firstString(...values: unknown[]): string | undefined {
    for (const v of values) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return undefined;
  }

  const THREAD_TYPES = new Set<number>([
    ChannelType.PublicThread,
    ChannelType.AnnouncementThread,
    ChannelType.PrivateThread,
  ]);

  const byPosition = (a: { rawPosition?: number; id: string }, b: { rawPosition?: number; id: string }): number =>
    (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function channelTypeName(type: number): string {
    return (ChannelType as unknown as Record<number, string>)[type] ?? `type ${type}`;
  }

  /** Fetch a channel and insist it is a non-thread guild channel (has overwrites, position, ...). */
  async function requireGuildChannel(ctxArg: ToolContext, channelId: string): Promise<NonThreadGuildBasedChannel> {
    const channel = await fetchChannel(ctxArg, channelId);
    if ((channel as unknown as { permissionOverwrites?: unknown }).permissionOverwrites === undefined) {
      throw new ValidationError(
        `channelId: #${channel.name} (id ${channel.id}, ${channelTypeName(channel.type)}) is not a guild channel — ` +
          'threads are managed as posts and DMs are addressed by user ID',
      );
    }
    return channel as NonThreadGuildBasedChannel;
  }

  /** Find non-thread channels by exact (case-insensitive) name; refetches the roster on a miss. */
  async function findChannelsByName(
    guildId: string | undefined,
    name: string,
    categoriesOnly: boolean,
  ): Promise<NonThreadGuildBasedChannel[]> {
    const needle = name.trim().toLowerCase();
    if (!needle) {
      throw new ValidationError(categoriesOnly ? 'categoryName: required' : 'channelName: required');
    }
    const guild = await fetchGuild(ctx, guildId);
    const match = (): NonThreadGuildBasedChannel[] =>
      [...guild.channels.cache.values()]
        .filter((c): c is NonThreadGuildBasedChannel => !THREAD_TYPES.has(c.type))
        .filter((c) => c.name.toLowerCase() === needle && (!categoriesOnly || c.type === ChannelType.GuildCategory))
        .sort(byPosition);
    let found = match();
    if (!found.length) {
      await guild.channels.fetch();
      found = match();
    }
    return found;
  }

  /** All non-thread channels of a guild, freshly fetched and sorted by position. */
  async function allGuildChannels(guildId: string | undefined): Promise<NonThreadGuildBasedChannel[]> {
    const guild = await fetchGuild(ctx, guildId);
    const fetched = await guild.channels.fetch();
    return [...fetched.values()]
      .filter((c): c is NonThreadGuildBasedChannel => c !== null)
      .sort(byPosition);
  }

  // -------------------------------------------------------------------------
  // JSON payload parsing (generic create/edit channel tools)
  // -------------------------------------------------------------------------

  /** overwritesJson: [{id, type: "role"|"member", allow?: "CSV names | bitfield", deny?: "..."}] */
  function parseOverwritesJson(
    raw: string,
  ): Array<{ id: string; type: number; allow: string; deny: string }> {
    const parsed = parseJsonParam<unknown>('overwritesJson', raw);
    if (!Array.isArray(parsed)) {
      throw new ValidationError('overwritesJson: must be a JSON array of {id, type, allow?, deny?}');
    }
    if (!parsed.length) throw new ValidationError('overwritesJson: at least one overwrite required');
    return parsed.map((entry, i) => {
      const here = `overwritesJson[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ValidationError(`${here}: must be an object`);
      }
      const obj = entry as Record<string, unknown>;
      const id = assertSnowflake(`${here}.id`, String(obj.id ?? ''));
      const rawType = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : obj.type;
      let type: number;
      if (rawType === 'role' || rawType === 0 || rawType === '0') type = OverwriteType.Role;
      else if (rawType === 'member' || rawType === 1 || rawType === '1') type = OverwriteType.Member;
      else throw new ValidationError(`${here}.type: must be "role" or "member"`);
      const toPermString = (v: unknown): string | undefined => {
        if (v === undefined || v === null) return undefined;
        if (Array.isArray(v)) return v.length ? v.map(String).join(',') : undefined;
        return String(v);
      };
      const allow = permBits(toPermString(obj.allow), `${here}.allow`) ?? 0n;
      const deny = permBits(toPermString(obj.deny), `${here}.deny`) ?? 0n;
      return { id, type, allow: String(allow), deny: String(deny) };
    });
  }

  /** Tag emoji: "🔥", "123456789012345678", or {emojiId, emojiName} in any spelling. */
  function parseTagEmoji(emoji: unknown, path: string): GuildForumTagEmoji {
    if (typeof emoji === 'string') {
      const v = emoji.trim();
      if (!v) throw new ValidationError(`${path}: empty emoji`);
      if (/^\d{15,21}$/.test(v)) return { id: v, name: null };
      return { id: null, name: v };
    }
    if (emoji && typeof emoji === 'object') {
      const obj = emoji as Record<string, unknown>;
      const id = firstString(obj.emojiId, obj.id, obj.emoji_id);
      const name = firstString(obj.emojiName, obj.name, obj.emoji_name);
      if (id === undefined && name === undefined) {
        throw new ValidationError(`${path}: provide emojiId or emojiName`);
      }
      return { id: id ?? null, name: name ?? null };
    }
    throw new ValidationError(`${path}: must be an emoji string or {emojiId, emojiName}`);
  }

  /** availableTagsJson: [{name, emoji?, moderated?}] */
  function parseAvailableTags(value: unknown): GuildForumTagData[] {
    if (!Array.isArray(value)) {
      throw new ValidationError('availableTagsJson: must be a JSON array of {name, emoji?, moderated?}');
    }
    if (!value.length) throw new ValidationError('availableTagsJson: at least one tag required');
    return value.map((t, i) => {
      const here = `availableTagsJson[${i}]`;
      if (!t || typeof t !== 'object' || Array.isArray(t)) throw new ValidationError(`${here}: must be an object`);
      const obj = t as Record<string, unknown>;
      const name = String(obj.name ?? '').trim();
      if (!name) throw new ValidationError(`${here}.name: required`);
      if (name.length > 20) throw new ValidationError(`${here}.name: ${name.length} chars > 20`);
      const tag: GuildForumTagData = { name };
      const id = firstString(obj.id);
      if (id) tag.id = id;
      if (obj.moderated !== undefined) tag.moderated = Boolean(obj.moderated);
      if (obj.emoji !== undefined && obj.emoji !== null && obj.emoji !== '') {
        tag.emoji = parseTagEmoji(obj.emoji, `${here}.emoji`);
      }
      return tag;
    });
  }

  /** defaultReactionEmoji: {"emojiName":"🔥"} | {"emojiId":"123..."} | "🔥" | "123...". */
  function parseDefaultReaction(value: string): DefaultReactionEmoji {
    const v = value.trim();
    if (!v) throw new ValidationError('defaultReactionEmoji: empty');
    if (/^\d{15,21}$/.test(v)) return { id: v, name: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      parsed = v; // a bare (non-JSON) emoji string
    }
    if (typeof parsed === 'string') {
      const s = parsed.trim();
      if (!s) throw new ValidationError('defaultReactionEmoji: empty');
      if (/^\d{15,21}$/.test(s)) return { id: s, name: null };
      return { id: null, name: s };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const id = firstString(obj.emojiId, obj.id, obj.emoji_id);
      const name = firstString(obj.emojiName, obj.name, obj.emoji_name);
      if (id === undefined && name === undefined) {
        throw new ValidationError('defaultReactionEmoji: provide emojiName or emojiId');
      }
      return { id: id ?? null, name: name ?? null };
    }
    throw new ValidationError(
      'defaultReactionEmoji: must be {"emojiName": "🔥"}, {"emojiId": "123..."} or a plain emoji',
    );
  }

  // -------------------------------------------------------------------------
  // Generic create/edit option building, gated by channel kind so irrelevant
  // fields never reach Discord.
  // -------------------------------------------------------------------------

  type ChannelKind = 'text' | 'voice' | 'category' | 'announcement' | 'stage' | 'forum' | 'media';

  const CHANNEL_TYPE_MAP: Record<ChannelKind, ChannelType> = {
    text: ChannelType.GuildText,
    voice: ChannelType.GuildVoice,
    category: ChannelType.GuildCategory,
    announcement: ChannelType.GuildAnnouncement,
    stage: ChannelType.GuildStageVoice,
    forum: ChannelType.GuildForum,
    media: ChannelType.GuildMedia,
  };

  const TYPE_TO_KIND: Readonly<Record<number, ChannelKind>> = {
    [ChannelType.GuildText]: 'text',
    [ChannelType.GuildAnnouncement]: 'announcement',
    [ChannelType.GuildVoice]: 'voice',
    [ChannelType.GuildStageVoice]: 'stage',
    [ChannelType.GuildCategory]: 'category',
    [ChannelType.GuildForum]: 'forum',
    [ChannelType.GuildMedia]: 'media',
  };

  /** Which settings each channel kind accepts (others are dropped with a note). */
  const KIND_FIELDS: Record<ChannelKind, readonly string[]> = {
    category: ['position', 'overwrites'],
    text: ['topic', 'nsfw', 'slowmode', 'position', 'parent', 'overwrites', 'autoArchive', 'threadSlowmode'],
    announcement: ['topic', 'nsfw', 'slowmode', 'position', 'parent', 'overwrites', 'autoArchive', 'threadSlowmode'],
    voice: ['nsfw', 'slowmode', 'bitrate', 'userLimit', 'rtcRegion', 'videoQuality', 'position', 'parent', 'overwrites'],
    stage: ['nsfw', 'slowmode', 'bitrate', 'userLimit', 'rtcRegion', 'videoQuality', 'position', 'parent', 'overwrites'],
    forum: [
      'topic', 'nsfw', 'slowmode', 'position', 'parent', 'overwrites', 'autoArchive', 'threadSlowmode',
      'tags', 'defaultReaction', 'sortOrder', 'layout',
    ],
    media: [
      'topic', 'nsfw', 'slowmode', 'position', 'parent', 'overwrites', 'autoArchive', 'threadSlowmode',
      'tags', 'defaultReaction', 'sortOrder',
    ],
  };

  const ARCHIVE_DURATIONS = new Set<number>([60, 1440, 4320, 10080]); // ThreadAutoArchiveDuration values

  const FORUM_LAYOUT_MAP = {
    not_set: ForumLayoutType.NotSet,
    list_view: ForumLayoutType.ListView,
    gallery_view: ForumLayoutType.GalleryView,
  } as const;

  interface ChannelSettingsArgs {
    name?: string;
    topic?: string;
    nsfw?: boolean | string;
    slowmodeSeconds?: number | string;
    bitrate?: number | string;
    userLimit?: number | string;
    parentId?: string;
    position?: number | string;
    overwritesJson?: string;
    defaultAutoArchiveMinutes?: number | string;
    defaultReactionEmoji?: string;
    availableTagsJson?: string;
    defaultSortOrder?: 'recent_activity' | 'creation_time';
    defaultForumLayout?: 'list_view' | 'gallery_view' | 'not_set';
    defaultThreadSlowmode?: number | string;
    rtcRegion?: string;
    videoQualityMode?: 'auto' | 'full';
    lockPermissions?: boolean | string;
  }

  /**
   * Build a discord.js option object from the generic tool args, passing only
   * fields relevant to the channel kind. Returns the settings plus the list of
   * provided-but-irrelevant fields (surfaced in the tool result).
   */
  function buildChannelSettings(
    args: ChannelSettingsArgs,
    kind: ChannelKind,
    mode: 'create' | 'edit',
  ): { settings: Record<string, unknown>; ignored: string[] } {
    const allowed = new Set(KIND_FIELDS[kind]);
    const settings: Record<string, unknown> = {};
    const ignored: string[] = [];
    const allow = (field: string): boolean => {
      if (allowed.has(field)) return true;
      ignored.push(field);
      return false;
    };

    if (args.name !== undefined && args.name !== '') settings.name = args.name;

    if (args.nsfw !== undefined && allow('nsfw')) {
      const nsfw = parseBoolParam('nsfw', args.nsfw);
      if (nsfw !== undefined) settings.nsfw = nsfw;
    }

    if (args.topic !== undefined && allow('topic')) {
      // On edit an empty string clears the topic; on create it is omitted.
      settings.topic = args.topic === '' ? (mode === 'edit' ? null : undefined) : args.topic;
      if (settings.topic === undefined) delete settings.topic;
    }

    if (args.slowmodeSeconds !== undefined && allow('slowmode')) {
      const slow = parseIntParam('slowmodeSeconds', args.slowmodeSeconds, 0, 21600);
      if (slow !== undefined) settings.rateLimitPerUser = slow;
    }

    if (args.defaultThreadSlowmode !== undefined && allow('threadSlowmode')) {
      const slow = parseIntParam('defaultThreadSlowmode', args.defaultThreadSlowmode, 0, 21600);
      if (slow !== undefined) settings.defaultThreadRateLimitPerUser = slow;
    }

    if (args.bitrate !== undefined && allow('bitrate')) {
      const bitrate = parseIntParam('bitrate', args.bitrate, 8000, 512000);
      if (bitrate !== undefined) settings.bitrate = bitrate;
    }

    if (args.userLimit !== undefined && allow('userLimit')) {
      const limit = parseIntParam('userLimit', args.userLimit, 0, 99);
      if (limit !== undefined) settings.userLimit = limit;
    }

    if (args.rtcRegion !== undefined && allow('rtcRegion')) {
      settings.rtcRegion = args.rtcRegion === '' ? null : args.rtcRegion;
    }

    if (args.videoQualityMode !== undefined && allow('videoQuality')) {
      settings.videoQualityMode = args.videoQualityMode === 'full' ? VideoQualityMode.Full : VideoQualityMode.Auto;
    }

    if (args.parentId !== undefined && allow('parent')) {
      // "" removes the channel from its category (edit); on create it is omitted.
      settings.parent = args.parentId === '' ? (mode === 'edit' ? null : undefined) : assertSnowflake('parentId', args.parentId);
      if (settings.parent === undefined) delete settings.parent;
    }

    if (args.position !== undefined && allow('position')) {
      const position = parseIntParam('position', args.position, 0);
      if (position !== undefined) settings.position = position;
    }

    if (args.defaultAutoArchiveMinutes !== undefined && allow('autoArchive')) {
      const mins = parseIntParam('defaultAutoArchiveMinutes', args.defaultAutoArchiveMinutes);
      if (mins !== undefined) {
        if (!ARCHIVE_DURATIONS.has(mins)) {
          throw new ValidationError('defaultAutoArchiveMinutes: must be one of 60, 1440, 4320, 10080 (minutes)');
        }
        settings.defaultAutoArchiveDuration = mins as ThreadAutoArchiveDuration;
      }
    }

    if (args.defaultSortOrder !== undefined && allow('sortOrder')) {
      settings.defaultSortOrder =
        args.defaultSortOrder === 'creation_time' ? SortOrderType.CreationDate : SortOrderType.LatestActivity;
    }

    if (args.defaultForumLayout !== undefined && allow('layout')) {
      settings.defaultForumLayout = FORUM_LAYOUT_MAP[args.defaultForumLayout];
    }

    if (args.defaultReactionEmoji !== undefined && args.defaultReactionEmoji !== '' && allow('defaultReaction')) {
      settings.defaultReactionEmoji = parseDefaultReaction(args.defaultReactionEmoji);
    }

    if (args.availableTagsJson !== undefined && args.availableTagsJson.trim() !== '' && allow('tags')) {
      settings.availableTags = parseAvailableTags(parseJsonParam('availableTagsJson', args.availableTagsJson));
    }

    if (args.overwritesJson !== undefined && args.overwritesJson.trim() !== '' && allow('overwrites')) {
      settings.permissionOverwrites = parseOverwritesJson(args.overwritesJson);
    }

    if (mode === 'edit' && args.lockPermissions !== undefined) {
      const lock = parseBoolParam('lockPermissions', args.lockPermissions);
      if (lock) settings.lockPermissions = true; // sync permissions with the parent category
    }

    return { settings, ignored };
  }

  const ignoredNote = (kind: ChannelKind, ignored: string[]): string =>
    ignored.length ? `\n(ignored — not applicable to ${kind} channels: ${ignored.join(', ')})` : '';

  // -------------------------------------------------------------------------
  // Legacy channel tools
  // -------------------------------------------------------------------------

  reg.tool('create_text_channel', {
    description: 'Create a new text channel in the server.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().describe('Channel name'),
      categoryId: z.string().optional().describe('Category ID to create the channel under'),
      topic: z.string().optional().describe('Channel topic'),
      nsfw: z.union([z.boolean(), z.string()]).optional().describe('Whether the channel is NSFW'),
      slowmode: z.union([z.number(), z.string()]).optional().describe('Slowmode in seconds (0-21600)'),
      position: z.union([z.number(), z.string()]).optional().describe('Position in the channel list'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const name = checkedName(args.name);
      const nsfw = parseBoolParam('nsfw', args.nsfw);
      const slowmode = parseIntParam('slowmode', args.slowmode, 0, 21600);
      const position = parseIntParam('position', args.position, 0);
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        ...(args.categoryId ? { parent: assertSnowflake('categoryId', args.categoryId) } : {}),
        ...(args.topic ? { topic: args.topic } : {}),
        ...(nsfw !== undefined ? { nsfw } : {}),
        ...(slowmode !== undefined ? { rateLimitPerUser: slowmode } : {}),
        ...(position !== undefined ? { position } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Created text channel #${channel.name} (id ${channel.id}, <#${channel.id}>)`;
    },
  });

  reg.tool('edit_text_channel', {
    description: 'Edit a text channel: name, topic, nsfw, slowmode, category or position.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      name: z.string().optional().describe('New channel name'),
      topic: z.string().optional().describe('New channel topic (empty string clears it)'),
      nsfw: z.union([z.boolean(), z.string()]).optional().describe('Whether the channel is NSFW'),
      slowmode: z.union([z.number(), z.string()]).optional().describe('Slowmode in seconds (0-21600)'),
      categoryId: z.string().optional().describe('Category ID (empty string removes the channel from its category)'),
      position: z.union([z.number(), z.string()]).optional().describe('Position in the channel list'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await requireGuildChannel(ctx, args.channelId);
      const options: GuildChannelEditOptions = {};
      if (args.name !== undefined && args.name !== '') options.name = checkedName(args.name);
      if (args.topic !== undefined) options.topic = args.topic === '' ? null : args.topic;
      const nsfw = parseBoolParam('nsfw', args.nsfw);
      if (nsfw !== undefined) options.nsfw = nsfw;
      const slowmode = parseIntParam('slowmode', args.slowmode, 0, 21600);
      if (slowmode !== undefined) options.rateLimitPerUser = slowmode;
      if (args.categoryId !== undefined) {
        options.parent = args.categoryId === '' ? null : assertSnowflake('categoryId', args.categoryId);
      }
      const position = parseIntParam('position', args.position, 0);
      if (position !== undefined) options.position = position;
      if (!Object.keys(options).length) {
        throw new ValidationError('name: provide at least one of name, topic, nsfw, slowmode, categoryId, position');
      }
      if (args.reason) options.reason = args.reason;
      const updated = await channel.edit(options);
      return `Updated channel #${updated.name} (id ${updated.id})`;
    },
  });

  reg.tool('delete_channel', {
    description: 'Delete a channel (any type). This cannot be undone.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const channel = await fetchChannel(ctx, args.channelId);
      const summary = `#${channel.name} (id ${channel.id}, ${channelTypeName(channel.type)})`;
      await channel.delete(args.reason);
      return `Deleted channel ${summary}`;
    },
  });

  reg.tool('find_channel', {
    description: 'Find a channel by name (case-insensitive) and get its ID and type.',
    inputSchema: {
      guildId: guildIdParam,
      channelName: z.string().describe('Discord channel name'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const found = await findChannelsByName(args.guildId, args.channelName, false);
      if (!found.length) {
        throw new ValidationError(`channelName: no channel named "${args.channelName}" found in this server`);
      }
      return truncate(found.map((c) => formatChannelLine(c)).join('\n'));
    },
  });

  reg.tool('list_channels', {
    description: 'List every channel in the server, grouped by category.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const all = await allGuildChannels(args.guildId);
      const lines: string[] = [];
      const categorized = new Set<string>();
      for (const category of all.filter((c) => c.type === ChannelType.GuildCategory)) {
        lines.push(formatChannelLine(category));
        for (const child of all.filter((c) => c.parentId === category.id)) {
          lines.push(`  ${formatChannelLine(child)}`);
          categorized.add(child.id);
        }
      }
      const parentless = all.filter(
        (c) => c.type !== ChannelType.GuildCategory && !categorized.has(c.id),
      );
      if (parentless.length) {
        lines.push('(no category)');
        for (const channel of parentless) lines.push(formatChannelLine(channel));
      }
      return truncate(lines.join('\n')) || '(no channels)';
    },
  });

  reg.tool('get_channel_info', {
    description:
      'Get detailed settings for a channel: name, topic, nsfw, slowmode, category, position, ' +
      'plus voice (bitrate, user limit, region) and forum (tags, sort, layout) details.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channel = await fetchChannel(ctx, args.channelId);
      const raw = channel as unknown as Record<string, unknown>;
      const lines: string[] = [
        `#${channel.name} (id ${channel.id}) — ${channelTypeName(channel.type)} (type ${channel.type})`,
      ];
      const push = (label: string, value: unknown): void => {
        if (value === undefined || value === null || value === '') return;
        lines.push(`${label}: ${String(value)}`);
      };
      push('topic', raw.topic);
      push('nsfw', raw.nsfw);
      if (raw.rateLimitPerUser !== undefined && raw.rateLimitPerUser !== null) {
        lines.push(`slowmode: ${raw.rateLimitPerUser}s`);
      }
      const parent = raw.parent as { name?: string; id?: string } | null | undefined;
      if (parent) lines.push(`category: #${parent.name} (id ${parent.id})`);
      if (raw.rawPosition !== undefined && raw.rawPosition !== null) lines.push(`position: ${raw.rawPosition}`);
      if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        push('bitrate', typeof raw.bitrate === 'number' ? `${raw.bitrate} bps` : undefined);
        if (typeof raw.userLimit === 'number' && raw.userLimit > 0) lines.push(`user limit: ${raw.userLimit}`);
        lines.push(`rtc region: ${raw.rtcRegion ? String(raw.rtcRegion) : 'automatic'}`);
      }
      if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
        const tags = raw.availableTags as unknown as Array<{ name?: string }> | undefined;
        if (Array.isArray(tags)) {
          const names = tags.map((t) => t.name ?? '?').slice(0, 20);
          lines.push(`tags: ${tags.length}${names.length ? ` (${names.join(', ')})` : ''}`);
        }
        if (raw.defaultSortOrder !== undefined && raw.defaultSortOrder !== null) {
          const order = raw.defaultSortOrder as SortOrderType;
          lines.push(`default sort order: ${SortOrderType[order] ?? order}`);
        }
        if (raw.defaultForumLayout !== undefined && raw.defaultForumLayout !== null) {
          const layout = raw.defaultForumLayout as ForumLayoutType;
          lines.push(`default forum layout: ${ForumLayoutType[layout] ?? layout}`);
        }
        if (typeof raw.defaultThreadRateLimitPerUser === 'number') {
          lines.push(`default thread slowmode: ${raw.defaultThreadRateLimitPerUser}s`);
        }
        const reaction = raw.defaultReactionEmoji as { name?: string | null; id?: string | null } | null | undefined;
        if (reaction && (reaction.name || reaction.id)) {
          lines.push(`default reaction: ${reaction.name ?? `custom emoji ${reaction.id}`}`);
        }
      }
      return lines.join('\n');
    },
  });

  reg.tool('move_channel', {
    description: 'Move a channel to another category and/or change its position in the list.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      categoryId: z.string().optional().describe('Target category ID (empty string removes the channel from its category)'),
      position: z.union([z.number(), z.string()]).optional().describe('New position in the channel list'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await requireGuildChannel(ctx, args.channelId);
      const options: GuildChannelEditOptions = {};
      if (args.categoryId !== undefined) {
        options.parent = args.categoryId === '' ? null : assertSnowflake('categoryId', args.categoryId);
      }
      const position = parseIntParam('position', args.position, 0);
      if (position !== undefined) options.position = position;
      if (options.parent === undefined && options.position === undefined) {
        throw new ValidationError('categoryId: provide categoryId and/or position to move the channel');
      }
      if (args.reason) options.reason = args.reason;
      const updated = await channel.edit(options);
      const parts: string[] = [];
      if (options.parent !== undefined) {
        parts.push(options.parent === null ? 'removed from its category' : `moved under category ${options.parent}`);
      }
      if (position !== undefined) parts.push(`position ${position}`);
      return `Channel #${updated.name} (id ${updated.id}): ${parts.join(', ')}`;
    },
  });

  // -------------------------------------------------------------------------
  // Legacy category tools
  // -------------------------------------------------------------------------

  reg.tool('create_category', {
    description: 'Create a new channel category.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().describe('Category name'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const category = await guild.channels.create({
        name: checkedName(args.name),
        type: ChannelType.GuildCategory,
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Created category #${category.name} (id ${category.id})`;
    },
  });

  reg.tool('edit_category', {
    description: 'Edit a category: rename it or change its position.',
    inputSchema: {
      guildId: guildIdParam,
      categoryId: snowflakeId('Discord category ID'),
      name: z.string().optional().describe('New category name'),
      position: z.union([z.number(), z.string()]).optional().describe('New position in the channel list'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await requireGuildChannel(ctx, args.categoryId);
      if (channel.type !== ChannelType.GuildCategory) {
        throw new ValidationError(
          `categoryId: #${channel.name} (id ${channel.id}) is not a category (${channelTypeName(channel.type)})`,
        );
      }
      const options: GuildChannelEditOptions = {};
      if (args.name !== undefined && args.name !== '') options.name = checkedName(args.name);
      const position = parseIntParam('position', args.position, 0);
      if (position !== undefined) options.position = position;
      if (!Object.keys(options).length) {
        throw new ValidationError('name: provide name and/or position to edit');
      }
      if (args.reason) options.reason = args.reason;
      const updated = await channel.edit(options);
      return `Updated category #${updated.name} (id ${updated.id})`;
    },
  });

  reg.tool('delete_category', {
    description: 'Delete a category. Channels inside it are kept and become uncategorized.',
    inputSchema: {
      guildId: guildIdParam,
      categoryId: snowflakeId('Discord category ID'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const channel = await requireGuildChannel(ctx, args.categoryId);
      if (channel.type !== ChannelType.GuildCategory) {
        throw new ValidationError(
          `categoryId: #${channel.name} (id ${channel.id}) is not a category (${channelTypeName(channel.type)})`,
        );
      }
      const summary = `#${channel.name} (id ${channel.id})`;
      await channel.delete(args.reason);
      return `Deleted category ${summary} — its channels were kept and are now uncategorized`;
    },
  });

  reg.tool('find_category', {
    description: 'Find a category by name (case-insensitive) and get its ID.',
    inputSchema: {
      guildId: guildIdParam,
      categoryName: z.string().describe('Discord category name'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const found = await findChannelsByName(args.guildId, args.categoryName, true);
      if (!found.length) {
        throw new ValidationError(`categoryName: no category named "${args.categoryName}" found in this server`);
      }
      return truncate(found.map((c) => formatChannelLine(c)).join('\n'));
    },
  });

  reg.tool('list_channels_in_category', {
    description: 'List the channels inside a category, ordered by position.',
    inputSchema: {
      guildId: guildIdParam,
      categoryId: snowflakeId('Discord category ID'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channel = await requireGuildChannel(ctx, args.categoryId);
      if (channel.type !== ChannelType.GuildCategory) {
        throw new ValidationError(
          `categoryId: #${channel.name} (id ${channel.id}) is not a category (${channelTypeName(channel.type)})`,
        );
      }
      const children = (await allGuildChannels(args.guildId)).filter((c) => c.parentId === channel.id);
      if (!children.length) return `(no channels in category #${channel.name})`;
      return truncate(children.map((c) => formatChannelLine(c)).join('\n'));
    },
  });

  // -------------------------------------------------------------------------
  // Legacy channel permission overwrite tools
  // -------------------------------------------------------------------------

  reg.tool('list_channel_permission_overwrites', {
    description: 'List every permission overwrite on a channel, with allow/deny per role or member.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channel = await requireGuildChannel(ctx, args.channelId);
      const overwrites = [...channel.permissionOverwrites.cache.values()];
      if (!overwrites.length) return `(no permission overwrites on #${channel.name})`;
      const lines = overwrites.map((ow) => {
        let target: string;
        if (ow.type === OverwriteType.Role) {
          const role = channel.guild.roles.cache.get(ow.id);
          target = role ? `role @${role.name} (id ${ow.id})` : `role (id ${ow.id})`;
        } else {
          const member = channel.guild.members.cache.get(ow.id);
          target = member ? `member ${member.displayName} (id ${ow.id})` : `member (id ${ow.id})`;
        }
        const allowNames = permissionNames(ow.allow.bitfield);
        const denyNames = permissionNames(ow.deny.bitfield);
        return `${target}: allow [${allowNames.join(', ') || 'none'}], deny [${denyNames.join(', ') || 'none'}]`;
      });
      return truncate(`Permission overwrites on #${channel.name} (id ${channel.id}):\n${lines.join('\n')}`);
    },
  });

  /**
   * Shared body for the two upsert tools: resolves raw/named permissions to
   * bitfields, merges "no change" sides with the existing overwrite, and PUTs
   * the final allow/deny pair via raw REST (discord.js's overwrite manager
   * takes a per-permission map, which cannot express raw bitfields exactly).
   */
  async function upsertOverwrite(args: {
    channelId: string;
    targetId: string;
    targetParam: string;
    allowRaw?: string;
    denyRaw?: string;
    allowPermissions?: string;
    denyPermissions?: string;
    reason?: string;
  }): Promise<string> {
    const channel = await requireGuildChannel(ctx, args.channelId);
    const targetId = assertSnowflake(args.targetParam, args.targetId);
    const allow = combineBits(permBits(args.allowRaw, 'allowRaw'), permBits(args.allowPermissions, 'allowPermissions'));
    const deny = combineBits(permBits(args.denyRaw, 'denyRaw'), permBits(args.denyPermissions, 'denyPermissions'));
    if (allow === undefined && deny === undefined) {
      throw new ValidationError(
        'allowRaw: provide at least one of allowRaw, denyRaw, allowPermissions, denyPermissions',
      );
    }
    const isMember = args.targetParam === 'userId';
    const existing = channel.permissionOverwrites.cache.get(targetId);
    // Empty/omitted sides keep the overwrite's current bits ("no change").
    const allowBits = allow ?? existing?.allow.bitfield ?? 0n;
    const denyBits = deny ?? existing?.deny.bitfield ?? 0n;
    await ctx.client.rest.put(`/channels/${channel.id}/permissions/${targetId}`, {
      body: {
        id: targetId,
        type: isMember ? OverwriteType.Member : OverwriteType.Role,
        allow: String(allowBits),
        deny: String(denyBits),
      },
      reason: args.reason,
    });
    const target = isMember
      ? (() => {
          const member = channel.guild.members.cache.get(targetId);
          return member ? `member ${member.displayName} (id ${targetId})` : `member (id ${targetId})`;
        })()
      : (() => {
          const role = channel.guild.roles.cache.get(targetId);
          return role ? `role @${role.name} (id ${targetId})` : `role (id ${targetId})`;
        })();
    return (
      `Set overwrites on #${channel.name} for ${target}: ` +
      `allow [${permissionNames(allowBits).join(', ') || 'none'}], ` +
      `deny [${permissionNames(denyBits).join(', ') || 'none'}]`
    );
  }

  reg.tool('upsert_role_channel_permissions', {
    description: 'Create or update the permission overwrite for a role on a channel.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      roleId: roleIdParam,
      allowRaw: z.string().optional().describe('Allow permissions as a raw bitfield'),
      denyRaw: z.string().optional().describe('Deny permissions as a raw bitfield'),
      allowPermissions: z
        .string()
        .optional()
        .describe('Allow permissions as CSV of names (e.g. VIEW_CHANNEL,MESSAGE_SEND)'),
      denyPermissions: z
        .string()
        .optional()
        .describe('Deny permissions as CSV of names (e.g. MESSAGE_SEND,MANAGE_MESSAGES)'),
      reason: reasonParam,
    },
    handler: async (args) =>
      upsertOverwrite({ ...args, targetId: args.roleId, targetParam: 'roleId' }),
  });

  reg.tool('upsert_member_channel_permissions', {
    description: 'Create or update the permission overwrite for a member on a channel.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      userId: userIdParam,
      allowRaw: z.string().optional().describe('Allow permissions as a raw bitfield'),
      denyRaw: z.string().optional().describe('Deny permissions as a raw bitfield'),
      allowPermissions: z
        .string()
        .optional()
        .describe('Allow permissions as CSV of names (e.g. VIEW_CHANNEL,VOICE_CONNECT)'),
      denyPermissions: z
        .string()
        .optional()
        .describe('Deny permissions as CSV of names (e.g. MESSAGE_SEND,VOICE_SPEAK)'),
      reason: reasonParam,
    },
    handler: async (args) =>
      upsertOverwrite({ ...args, targetId: args.userId, targetParam: 'userId' }),
  });

  reg.tool('delete_channel_permission_overwrite', {
    description: 'Delete a role or member permission overwrite from a channel.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      targetType: z.string().describe("Target type: 'role' or 'member'"),
      targetId: snowflakeId('Target role or user ID'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const targetType = String(args.targetType ?? '').trim().toLowerCase();
      if (targetType !== 'role' && targetType !== 'member') {
        throw new ValidationError(`targetType: "${args.targetType}" must be 'role' or 'member'`);
      }
      const channel = await requireGuildChannel(ctx, args.channelId);
      const targetId = assertSnowflake('targetId', args.targetId);
      await channel.permissionOverwrites.delete(targetId, args.reason);
      return `Removed ${targetType} overwrite ${targetId} from #${channel.name} (id ${channel.id})`;
    },
  });

  // -------------------------------------------------------------------------
  // New generic tools
  // -------------------------------------------------------------------------

  reg.tool('create_channel', {
    description:
      'Create a channel of any type (text, voice, category, announcement, stage, forum, media) with full ' +
      'options: topic, nsfw, slowmode, bitrate, user limit, permission overwrites, forum tags and defaults.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().describe('Channel name'),
      type: z
        .enum(['text', 'voice', 'category', 'announcement', 'stage', 'forum', 'media'])
        .describe('Channel type'),
      topic: z.string().optional().describe('Channel topic (text, announcement, forum and media channels)'),
      nsfw: z.union([z.boolean(), z.string()]).optional().describe('Whether the channel is NSFW'),
      slowmodeSeconds: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Slowmode in seconds (0-21600); for forums this is the default post slowmode'),
      bitrate: z.union([z.number(), z.string()]).optional().describe('Voice bitrate in bps (8000-512000)'),
      userLimit: z.union([z.number(), z.string()]).optional().describe('Voice user limit (0-99, 0 = unlimited)'),
      parentId: z.string().optional().describe('Category ID to create the channel under'),
      position: z.union([z.number(), z.string()]).optional().describe('Position in the channel list'),
      overwritesJson: jsonParam(
        'Permission overwrites',
        'Array: [{id, type: "role"|"member", allow?: "CSV of permission names or numeric bitfield", deny?: "same"}]',
      ),
      defaultAutoArchiveMinutes: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Default auto-archive for threads/posts in minutes: 60, 1440, 4320 or 10080'),
      defaultReactionEmoji: z
        .string()
        .optional()
        .describe('Default reaction for forum/media posts: {"emojiName": "🔥"} or {"emojiId": "123..."} or a plain emoji'),
      availableTagsJson: jsonParam(
        'Forum tags',
        'Array: [{name, emoji?, moderated?}] — tags usable on posts in forum/media channels',
      ),
      defaultSortOrder: z
        .enum(['recent_activity', 'creation_time'])
        .optional()
        .describe('Default post sort order for forum/media channels'),
      defaultForumLayout: z
        .enum(['list_view', 'gallery_view', 'not_set'])
        .optional()
        .describe('Default layout for forum channels'),
      defaultThreadSlowmode: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Default slowmode for threads/posts created in this channel (seconds, 0-21600)'),
      rtcRegion: z.string().optional().describe('Voice region id, or "auto" (empty string resets to automatic)'),
      videoQualityMode: z.enum(['auto', 'full']).optional().describe('Voice video quality (auto or 720p full)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const kind = args.type as ChannelKind;
      const { settings, ignored } = buildChannelSettings(args, kind, 'create');
      const channel = await guild.channels.create({
        name: checkedName(args.name),
        type: CHANNEL_TYPE_MAP[kind],
        ...settings,
        ...(args.reason ? { reason: args.reason } : {}),
      } as unknown as GuildChannelCreateOptions);
      return `Created ${kind} channel #${channel.name} (id ${channel.id}, <#${channel.id}>)${ignoredNote(kind, ignored)}`;
    },
  });

  reg.tool('edit_channel', {
    description:
      'Edit any channel with only the provided fields: name, topic, nsfw, slowmode, bitrate, user limit, ' +
      'category, position, overwrites, forum tags/defaults, or lockPermissions to sync with the category.',
    inputSchema: {
      channelId: channelIdParam,
      name: z.string().optional().describe('New channel name'),
      topic: z.string().optional().describe('New channel topic (empty string clears it)'),
      nsfw: z.union([z.boolean(), z.string()]).optional().describe('Whether the channel is NSFW'),
      slowmodeSeconds: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Slowmode in seconds (0-21600)'),
      bitrate: z.union([z.number(), z.string()]).optional().describe('Voice bitrate in bps (8000-512000)'),
      userLimit: z.union([z.number(), z.string()]).optional().describe('Voice user limit (0-99, 0 = unlimited)'),
      parentId: z
        .string()
        .optional()
        .describe('Category ID (empty string removes the channel from its category)'),
      position: z.union([z.number(), z.string()]).optional().describe('Position in the channel list'),
      overwritesJson: jsonParam(
        'Permission overwrites',
        'Array: [{id, type: "role"|"member", allow?: "CSV of permission names or numeric bitfield", deny?: "same"}] — replaces all overwrites',
      ),
      defaultAutoArchiveMinutes: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Default auto-archive for threads/posts in minutes: 60, 1440, 4320 or 10080'),
      defaultReactionEmoji: z
        .string()
        .optional()
        .describe('Default reaction for forum/media posts: {"emojiName": "🔥"} or {"emojiId": "123..."} or a plain emoji'),
      availableTagsJson: jsonParam(
        'Forum tags',
        'Array: [{name, emoji?, moderated?}] — replaces the tag list of forum/media channels',
      ),
      defaultSortOrder: z
        .enum(['recent_activity', 'creation_time'])
        .optional()
        .describe('Default post sort order for forum/media channels'),
      defaultForumLayout: z
        .enum(['list_view', 'gallery_view', 'not_set'])
        .optional()
        .describe('Default layout for forum channels'),
      defaultThreadSlowmode: z
        .union([z.number(), z.string()])
        .optional()
        .describe('Default slowmode for threads/posts created in this channel (seconds, 0-21600)'),
      rtcRegion: z.string().optional().describe('Voice region id, or "auto" (empty string resets to automatic)'),
      videoQualityMode: z.enum(['auto', 'full']).optional().describe('Voice video quality (auto or 720p full)'),
      lockPermissions: z
        .union([z.boolean(), z.string()])
        .optional()
        .describe('Sync the channel permissions with its parent category (true)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await requireGuildChannel(ctx, args.channelId);
      const kind = TYPE_TO_KIND[channel.type];
      if (!kind) {
        throw new ValidationError(
          `channelId: #${channel.name} (id ${channel.id}) has type ${channelTypeName(channel.type)}, ` +
            'which edit_channel cannot edit',
        );
      }
      const { settings, ignored } = buildChannelSettings(args, kind, 'edit');
      if (!Object.keys(settings).length) {
        throw new ValidationError('name: provide at least one field to edit');
      }
      if (args.reason) settings.reason = args.reason;
      const updated = await channel.edit(settings as unknown as GuildChannelEditOptions);
      return `Updated ${kind} channel #${updated.name} (id ${updated.id})${ignoredNote(kind, ignored)}`;
    },
  });

  reg.tool('follow_announcement_channel', {
    description:
      'Follow an announcement channel, automatically crossposting its messages into a target text channel.',
    inputSchema: {
      channelId: channelIdParam,
      targetChannelId: snowflakeId('Target text channel ID that receives the crossposts'),
    },
    handler: async (args) => {
      const source = await fetchChannel(ctx, args.channelId);
      if (source.type !== ChannelType.GuildAnnouncement) {
        throw new ValidationError(
          `channelId: #${source.name} (id ${source.id}) is not an announcement channel ` +
            `(${channelTypeName(source.type)}) — only announcement channels can be followed`,
        );
      }
      const target = await fetchChannel(ctx, args.targetChannelId);
      if (target.type !== ChannelType.GuildText && target.type !== ChannelType.GuildAnnouncement) {
        throw new ValidationError(
          `targetChannelId: #${target.name} (id ${target.id}) is not a text channel ` +
            `(${channelTypeName(target.type)}) — crossposts must land in a text channel`,
        );
      }
      const result = (await ctx.client.rest.post(`/channels/${source.id}/followers`, {
        body: { webhook_channel_id: target.id },
      })) as { webhook_id?: string } | null | undefined;
      const webhookId =
        result && typeof result === 'object' && typeof result.webhook_id === 'string' ? result.webhook_id : undefined;
      return (
        `Now following #${source.name} (id ${source.id}) — new announcements will be crossposted to ` +
        `#${target.name} (id ${target.id})${webhookId ? ` via webhook ${webhookId}` : ''}`
      );
    },
  });

  reg.tool('list_channel_invites', {
    description: 'List the active invites for a channel: code, uses, expiry and creator.',
    inputSchema: {
      channelId: channelIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const channel = await fetchChannel(ctx, args.channelId);
      const rows: Array<{ code: string; channelName: string; uses: number; maxUses: number | null; expires: string; inviter: string }> = [];
      const fetchInvites = (channel as unknown as {
        fetchInvites?: (cache?: boolean) => Promise<Map<string, Invite>>;
      }).fetchInvites;
      if (typeof fetchInvites === 'function') {
        const invites = await fetchInvites.call(channel);
        for (const inv of invites.values()) {
          rows.push({
            code: inv.code,
            channelName: inv.channel?.name ?? '?',
            uses: inv.uses ?? 0,
            maxUses: inv.maxUses ?? null,
            expires: inv.expiresAt ? isoTime(inv.expiresAt) : '',
            inviter: inv.inviter ? `@${inv.inviter.username} (id ${inv.inviter.id})` : 'unknown',
          });
        }
      } else {
        // Categories and other channel types without the helper: ask the API directly.
        const raw = (await ctx.client.rest.get(`/channels/${channel.id}/invites`)) as unknown as
          | Array<Record<string, unknown>>
          | null;
        for (const inv of raw ?? []) {
          const target = (inv.channel ?? {}) as { name?: string };
          const inviter = (inv.inviter ?? {}) as { username?: string; id?: string };
          const expiresAt = typeof inv.expires_at === 'string' && inv.expires_at ? isoTime(Date.parse(inv.expires_at)) : '';
          rows.push({
            code: String(inv.code ?? '?'),
            channelName: target.name ?? '?',
            uses: typeof inv.uses === 'number' ? inv.uses : 0,
            maxUses: typeof inv.max_uses === 'number' ? inv.max_uses : null,
            expires: expiresAt,
            inviter: inviter.id ? `@${inviter.username ?? '?'} (id ${inviter.id})` : 'unknown',
          });
        }
      }
      if (!rows.length) return `(no active invites for #${channel.name})`;
      const lines = rows.map(
        (r) =>
          `${r.code} — #${r.channelName}, uses ${r.uses}${r.maxUses ? `/${r.maxUses}` : ' (unlimited)'}, ` +
          `${r.expires ? `expires ${r.expires}` : 'never expires'}, by ${r.inviter}`,
      );
      return truncate(lines.join('\n'));
    },
  });

  return reg.count;
}
