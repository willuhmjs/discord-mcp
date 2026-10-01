import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GuildEmoji } from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchGuild, parseIdList, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { guardedFetch, IMAGE_TYPES, SOUND_TYPES, STICKER_TYPES } from '../lib/fetch.js';
import { truncate } from '../lib/format.js';
import { createRegistrar, guildIdParam, reasonParam, snowflakeId } from '../lib/register.js';
import { imageToDataUri } from '../lib/validation.js';

const IMAGE_MAX_BYTES = 256 * 1024; // emoji / avatar images
const MEDIA_MAX_BYTES = 512 * 1024; // stickers and soundboard sounds

const EMOJI_NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

const STICKER_FORMATS: Record<number, string> = {
  1: 'PNG',
  2: 'APNG',
  3: 'LOTTIE',
  4: 'GIF',
};

// ---------------------------------------------------------------------------
// Shared response shapes (raw REST objects)
// ---------------------------------------------------------------------------

interface AppEmojiData {
  id: string;
  name: string;
  animated?: boolean;
}

interface StickerData {
  id: string;
  name: string;
  description: string | null;
  tags: string | null;
  format_type?: number | null;
  available?: boolean | null;
  sort_value?: number | null;
}

interface SoundData {
  name: string;
  sound_id: string;
  volume: number;
  emoji_id: string | null;
  emoji_name: string | null;
  available?: boolean;
  user?: { id: string; username: string } | null;
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function requireExactlyOne(aName: string, bName: string, a: string | undefined, b: string | undefined): void {
  if (present(a) === present(b)) {
    throw new ValidationError(`provide exactly one of ${aName} or ${bName}`);
  }
}

function requireAtMostOne(aName: string, bName: string, a: string | undefined, b: string | undefined): void {
  if (present(a) && present(b)) {
    throw new ValidationError(`${aName}/${bName}: provide at most one, not both`);
  }
}

/** `<:name:id>` / `<a:name:id>` plus name (id X) — one line per emoji. */
function emojiLine(e: { id: string; name: string; animated?: boolean | null }): string {
  const mention = `${e.animated ? '<a:' : '<:'}${e.name}:${e.id}>`;
  return `${mention} ${e.name} (id ${e.id})`;
}

/** One line per sticker: name (id X, "description", tags). */
function stickerLine(s: StickerData): string {
  return `${s.name} (id ${s.id}, "${s.description ?? ''}", ${s.tags ?? 'no tags'})`;
}

/** One line per soundboard sound. (The API does not expose sound duration.) */
function soundLine(s: SoundData): string {
  const emoji = s.emoji_name || (s.emoji_id ? `<:emoji:${s.emoji_id}>` : 'no emoji');
  return `${s.name} (id ${s.sound_id}, ${emoji}, volume ${s.volume})`;
}

/** Resolve an emoji image to a data URI from exactly one of base64/URL input. */
async function emojiImageFrom(image: string | undefined, imageUrl: string | undefined): Promise<string> {
  requireExactlyOne('image', 'imageUrl', image, imageUrl);
  if (present(image)) {
    return imageToDataUri(image!, 'image');
  }
  const fetched = await guardedFetch(imageUrl!, {
    allowedTypes: IMAGE_TYPES,
    maxBytes: IMAGE_MAX_BYTES,
  });
  return `data:${fetched.contentType};base64,${fetched.data.toString('base64')}`;
}

/** Comma-separated tags → the space-joined string the API expects. */
function splitTags(tags: string): string {
  const joined = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
  if (!joined) throw new ValidationError('tags: at least one tag required');
  return joined;
}

/** Decode a raw-base64 (or data-URI) file argument, capped at 512KB. */
function decodeBase64File(param: string, value: string, kind: 'sticker' | 'sound'): { buffer: Buffer; filename: string } {
  const raw = value.trim().replace(/^data:[^;]+;base64,/, '');
  if (!raw) throw new ValidationError(`${param}: empty base64 data`);
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    throw new ValidationError(`${param}: not valid base64`);
  }
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new ValidationError(`${param}: decoded to an empty file`);
  if (buffer.length > MEDIA_MAX_BYTES) {
    throw new ValidationError(`${param}: ${(buffer.length / 1024).toFixed(0)}KB exceeds the 512KB limit`);
  }
  let filename: string;
  if (kind === 'sticker') {
    filename = buffer.subarray(0, 3).toString('latin1') === 'GIF'
      ? 'sticker.gif'
      : looksLikeJson(buffer)
        ? 'sticker.json'
        : 'sticker.png';
  } else {
    filename = buffer.subarray(0, 4).toString('latin1') === 'OggS' ? 'sound.ogg' : 'sound.mp3';
  }
  return { buffer, filename };
}

function looksLikeJson(buffer: Buffer): boolean {
  const first = buffer.find((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
  return first === 0x7b || first === 0x5b; // { or [
}

/** Fetch a sticker file (PNG/APNG/GIF ≤512KB or Lottie JSON) from url XOR base64. */
async function stickerFileFrom(
  fileUrl: string | undefined,
  fileBase64: string | undefined,
): Promise<{ buffer: Buffer; filename: string }> {
  requireExactlyOne('fileUrl', 'fileBase64', fileUrl, fileBase64);
  if (present(fileUrl)) {
    const fetched = await guardedFetch(fileUrl!, {
      allowedTypes: STICKER_TYPES,
      maxBytes: MEDIA_MAX_BYTES,
    });
    const filename =
      fetched.contentType === 'image/gif' ? 'sticker.gif'
      : fetched.contentType === 'application/json' ? 'sticker.json'
      : 'sticker.png';
    return { buffer: fetched.data, filename };
  }
  return decodeBase64File('fileBase64', fileBase64!, 'sticker');
}

/** Fetch a soundboard sound file (mp3/ogg ≤512KB, ≤5.2s) from url XOR base64. */
async function soundFileFrom(
  fileUrl: string | undefined,
  fileBase64: string | undefined,
): Promise<{ buffer: Buffer; filename: string }> {
  requireExactlyOne('fileUrl', 'fileBase64', fileUrl, fileBase64);
  if (present(fileUrl)) {
    const fetched = await guardedFetch(fileUrl!, {
      allowedTypes: SOUND_TYPES,
      maxBytes: MEDIA_MAX_BYTES,
    });
    return { buffer: fetched.data, filename: fetched.contentType === 'audio/mpeg' ? 'sound.mp3' : 'sound.ogg' };
  }
  return decodeBase64File('fileBase64', fileBase64!, 'sound');
}

/**
 * Expression tools: guild emojis, application emojis, stickers and soundboard
 * sounds. All guild-scoped tools take an optional guildId first (defaults to
 * DISCORD_GUILD_ID). Returns the number of tools registered.
 */
export function registerExpressionTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  // -------------------------------------------------------------------------
  // Guild emojis (legacy names, exact)
  // -------------------------------------------------------------------------

  reg.tool('list_emojis', {
    description: 'List all custom emojis on the server.',
    inputSchema: {
      guildId: guildIdParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const emojis = await guild.emojis.fetch();
      const lines = [...emojis.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => emojiLine(e));
      return truncate(lines.join('\n')) || '(no custom emojis)';
    },
  });

  reg.tool('get_emoji_details', {
    description: 'Get detailed information about a specific custom emoji.',
    inputSchema: {
      guildId: guildIdParam,
      emojiId: snowflakeId('ID of the emoji'),
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('emojiId', args.emojiId);
      let emoji: GuildEmoji;
      try {
        emoji = await guild.emojis.fetch(id);
      } catch {
        throw new Error(`emojiId: emoji ${id} not found in this server`);
      }
      let creator = emoji.author;
      if (!creator) {
        try {
          creator = await emoji.fetchAuthor();
        } catch {
          creator = null;
        }
      }
      const roleNames = [...emoji.roles.cache.values()].map((role) => `@${role.name}`);
      const url =
        emoji.imageURL() ?? `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`;
      const lines = [
        emojiLine(emoji),
        `animated: ${emoji.animated ? 'yes' : 'no'}, managed: ${emoji.managed ? 'yes' : 'no'}, ` +
          `requires colons: ${emoji.requiresColons === false ? 'no' : 'yes'}`,
        roleNames.length ? `restricted to roles: ${roleNames.join(', ')}` : 'usable by everyone',
        `URL: ${url}`,
      ];
      if (creator) lines.push(`creator: @${creator.username} (id ${creator.id})`);
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('create_emoji', {
    description:
      'Upload a new custom emoji to the server. Provide image as base64 (Data URI or raw) OR a direct ' +
      'image URL. Max 256KB.',
    inputSchema: {
      guildId: guildIdParam,
      name: z
        .string()
        .regex(EMOJI_NAME_RE, 'name must be 2-32 chars, alphanumeric and underscores only')
        .describe('Emoji name (2-32 chars, alphanumeric and underscores only)'),
      image: z
        .string()
        .optional()
        .describe('Image as base64 Data URI (e.g. data:image/png;base64,...) or raw base64 string'),
      imageUrl: z
        .string()
        .optional()
        .describe('Direct URL to the image file (alternative to base64 image)'),
      roles: z
        .string()
        .optional()
        .describe('Comma-separated role IDs to restrict emoji usage (empty = everyone)'),
    },
    handler: async (args) => {
      const dataUri = await emojiImageFrom(args.image, args.imageUrl);
      const roles = parseIdList('roles', args.roles);
      const guild = await fetchGuild(ctx, args.guildId);
      const emoji = await guild.emojis.create({
        name: args.name,
        attachment: dataUri,
        ...(roles.length ? { roles } : {}),
      });
      return `Emoji created: ${emojiLine(emoji)}`;
    },
  });

  reg.tool('edit_emoji', {
    description: "Edit an existing emoji's name or role restrictions.",
    inputSchema: {
      guildId: guildIdParam,
      emojiId: snowflakeId('ID of the emoji to edit'),
      name: z
        .string()
        .regex(EMOJI_NAME_RE, 'name must be 2-32 chars, alphanumeric and underscores only')
        .optional()
        .describe('New name for the emoji'),
      roles: z
        .string()
        .optional()
        .describe('Comma-separated role IDs to restrict usage (empty string = unrestrict for everyone)'),
    },
    handler: async (args) => {
      if (args.name === undefined && args.roles === undefined) {
        throw new ValidationError('provide at least one of name or roles');
      }
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('emojiId', args.emojiId);
      let emoji: GuildEmoji;
      try {
        emoji = await guild.emojis.fetch(id);
      } catch {
        throw new Error(`emojiId: emoji ${id} not found in this server`);
      }
      const roles = args.roles !== undefined ? parseIdList('roles', args.roles) : undefined;
      await emoji.edit({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(roles !== undefined ? { roles } : {}),
      });
      return `Emoji edited: ${emojiLine({ id: emoji.id, name: args.name ?? emoji.name, animated: emoji.animated })}`;
    },
  });

  reg.tool('delete_emoji', {
    description: 'Permanently delete a custom emoji from the server.',
    inputSchema: {
      guildId: guildIdParam,
      emojiId: snowflakeId('ID of the emoji to delete'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('emojiId', args.emojiId);
      await guild.emojis.delete(id, args.reason);
      return `Emoji ${id} deleted`;
    },
  });

  // -------------------------------------------------------------------------
  // Application emojis (owned by the bot's application, usable in any server)
  // -------------------------------------------------------------------------

  reg.tool('list_app_emojis', {
    description: "List the application's emojis (usable in every server the bot is in).",
    inputSchema: {},
    handler: async () => {
      const res = (await ctx.client.rest.get('/applications/@me/emojis')) as { items?: AppEmojiData[] };
      const items = res.items ?? [];
      const lines = [...items]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => emojiLine(e));
      return truncate(lines.join('\n')) || '(no application emojis)';
    },
  });

  reg.tool('create_app_emoji', {
    description:
      'Create an application emoji owned by the bot (works in any server). Provide image as base64 ' +
      '(Data URI or raw) OR a direct image URL. Max 256KB.',
    inputSchema: {
      name: z
        .string()
        .regex(EMOJI_NAME_RE, 'name must be 2-32 chars, alphanumeric and underscores only')
        .describe('Emoji name (2-32 chars, alphanumeric and underscores only)'),
      image: z
        .string()
        .optional()
        .describe('Image as base64 Data URI (e.g. data:image/png;base64,...) or raw base64 string'),
      imageUrl: z
        .string()
        .optional()
        .describe('Direct URL to the image file (alternative to base64 image)'),
    },
    handler: async (args) => {
      const dataUri = await emojiImageFrom(args.image, args.imageUrl);
      const created = (await ctx.client.rest.post('/applications/@me/emojis', {
        body: { name: args.name, image: dataUri },
      })) as AppEmojiData;
      return `App emoji created: ${emojiLine(created)} — usable in any server as ${
        created.animated ? `<a:${created.name}:${created.id}>` : `<:${created.name}:${created.id}>`
      }`;
    },
  });

  reg.tool('delete_app_emoji', {
    description: 'Permanently delete one of the application\u2019s emojis.',
    inputSchema: {
      emojiId: snowflakeId('ID of the application emoji to delete'),
    },
    handler: async (args) => {
      const id = assertSnowflake('emojiId', args.emojiId);
      await ctx.client.rest.delete(`/applications/@me/emojis/${id}`);
      return `App emoji ${id} deleted`;
    },
  });

  // -------------------------------------------------------------------------
  // Stickers
  // -------------------------------------------------------------------------

  reg.tool('list_guild_stickers', {
    description: 'List all custom stickers on the server.',
    inputSchema: {
      guildId: guildIdParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const stickers = (await ctx.client.rest.get(`/guilds/${guild.id}/stickers`)) as unknown as StickerData[];
      const lines = [...stickers]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => stickerLine(s));
      return truncate(lines.join('\n')) || '(no stickers)';
    },
  });

  reg.tool('get_guild_sticker', {
    description: 'Get detailed information about a specific custom sticker.',
    inputSchema: {
      guildId: guildIdParam,
      stickerId: snowflakeId('ID of the sticker'),
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('stickerId', args.stickerId);
      const s = (await ctx.client.rest.get(`/guilds/${guild.id}/stickers/${id}`)) as unknown as StickerData;
      const lines = [
        `${s.name} (id ${s.id})`,
        `description: "${s.description ?? ''}"`,
        `tags: ${s.tags ?? 'none'}`,
        `format: ${s.format_type ? (STICKER_FORMATS[s.format_type] ?? String(s.format_type)) : 'unknown'}`,
        `available: ${s.available !== false ? 'yes' : 'no'}`,
        `sort: ${s.sort_value ?? '—'}`,
      ];
      return lines.join('\n');
    },
  });

  reg.tool('create_guild_sticker', {
    description:
      'Upload a new custom sticker to the server. File must be PNG, APNG or GIF (≤512KB, animated ' +
      '≤5s) or a Lottie JSON. Provide exactly one of fileUrl or fileBase64.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(2).max(30).describe('Sticker name (2-30 chars)'),
      description: z.string().max(200).optional().describe('Sticker description (max 200 chars)'),
      tags: z.string().min(1).describe('Comma-separated tags (joined with spaces for the API)'),
      fileUrl: z
        .string()
        .optional()
        .describe('Direct URL to the sticker file (PNG/APNG/GIF ≤512KB or Lottie JSON)'),
      fileBase64: z.string().optional().describe('Sticker file as raw base64 (or a base64 data URI)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      requireExactlyOne('fileUrl', 'fileBase64', args.fileUrl, args.fileBase64);
      const tags = splitTags(args.tags);
      const guild = await fetchGuild(ctx, args.guildId);
      const file = await stickerFileFrom(args.fileUrl, args.fileBase64);
      const sticker = await guild.stickers.create({
        name: args.name,
        description: args.description ?? '',
        tags,
        file: { attachment: file.buffer, name: file.filename },
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return `Sticker created: ${stickerLine(sticker)}`;
    },
  });

  reg.tool('edit_guild_sticker', {
    description: 'Edit a custom sticker (name, description or tags).',
    inputSchema: {
      guildId: guildIdParam,
      stickerId: snowflakeId('ID of the sticker to edit'),
      name: z.string().min(2).max(30).optional().describe('New sticker name'),
      description: z.string().max(200).optional().describe('New sticker description (empty string clears it)'),
      tags: z.string().min(1).optional().describe('New comma-separated tags'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (args.tags !== undefined) body.tags = splitTags(args.tags);
      if (!Object.keys(body).length) {
        throw new ValidationError('provide at least one of name, description, tags');
      }
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('stickerId', args.stickerId);
      await ctx.client.rest.patch(`/guilds/${guild.id}/stickers/${id}`, {
        body,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return `Sticker ${id} edited`;
    },
  });

  reg.tool('delete_guild_sticker', {
    description: 'Permanently delete a custom sticker from the server.',
    inputSchema: {
      guildId: guildIdParam,
      stickerId: snowflakeId('ID of the sticker to delete'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('stickerId', args.stickerId);
      await guild.stickers.delete(id, args.reason);
      return `Sticker ${id} deleted`;
    },
  });

  reg.tool('list_sticker_packs', {
    description: 'List Discord\u2019s standard sticker packs.',
    inputSchema: {},
    handler: async () => {
      const res = (await ctx.client.rest.get('/sticker-packs')) as {
        sticker_packs?: Array<{ id: string; name: string; stickers?: unknown[] }>;
      };
      const packs = res.sticker_packs ?? [];
      const lines = packs.map(
        (p) => `${p.name} (id ${p.id}, ${p.stickers?.length ?? 0} stickers)`,
      );
      return truncate(lines.join('\n')) || '(no sticker packs)';
    },
  });

  // -------------------------------------------------------------------------
  // Soundboard sounds
  // -------------------------------------------------------------------------

  reg.tool('list_default_sounds', {
    description: 'List Discord\u2019s default soundboard sounds (usable in voice channels).',
    inputSchema: {},
    handler: async () => {
      const sounds = (await ctx.client.rest.get('/soundboard-default-sounds')) as unknown as SoundData[];
      const lines = sounds.map((s) => soundLine(s));
      return truncate(lines.join('\n')) || '(no default sounds)';
    },
  });

  reg.tool('list_guild_sounds', {
    description: 'List the server\u2019s custom soundboard sounds.',
    inputSchema: {
      guildId: guildIdParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const sounds = (await ctx.client.rest.get(`/guilds/${guild.id}/soundboard-sounds`)) as unknown as SoundData[];
      const lines = sounds.map(
        (s) => `${soundLine(s)} — added by @${s.user?.username ?? 'unknown'}`,
      );
      return truncate(lines.join('\n')) || '(no custom sounds)';
    },
  });

  reg.tool('get_guild_sound', {
    description: 'Get detailed information about a custom soundboard sound.',
    inputSchema: {
      guildId: guildIdParam,
      soundId: snowflakeId('ID of the soundboard sound'),
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('soundId', args.soundId);
      const s = (await ctx.client.rest.get(
        `/guilds/${guild.id}/soundboard-sounds/${id}`,
      )) as unknown as SoundData;
      const emoji = s.emoji_name || (s.emoji_id ? `<:emoji:${s.emoji_id}>` : 'no emoji');
      const lines = [
        `${s.name} (id ${s.sound_id})`,
        `volume: ${s.volume}, available: ${s.available !== false ? 'yes' : 'no'}`,
        `emoji: ${emoji}`,
      ];
      if (s.user) lines.push(`added by: @${s.user.username} (id ${s.user.id})`);
      return lines.join('\n');
    },
  });

  reg.tool('create_guild_sound', {
    description:
      'Upload a custom soundboard sound. File must be mp3 or ogg, ≤512KB and at most 5.2 seconds ' +
      '(Discord enforces the duration). Provide exactly one of fileUrl or fileBase64, and at most ' +
      'one of emojiId (custom emoji) or emojiName (unicode emoji).',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).max(32).describe('Sound name (max 32 chars)'),
      fileUrl: z.string().optional().describe('Direct URL to the sound file (mp3 or ogg, ≤512KB, ≤5.2s)'),
      fileBase64: z.string().optional().describe('Sound file as raw base64 (mp3 or ogg, ≤512KB, ≤5.2s)'),
      volume: z.number().min(0).max(1).optional().describe('Volume 0–1 (default 1)'),
      emojiId: snowflakeId('Custom emoji ID shown next to the sound').optional(),
      emojiName: z.string().optional().describe('Standard unicode emoji shown next to the sound'),
      reason: reasonParam,
    },
    handler: async (args) => {
      requireAtMostOne('emojiId', 'emojiName', args.emojiId, args.emojiName);
      requireExactlyOne('fileUrl', 'fileBase64', args.fileUrl, args.fileBase64);
      const guild = await fetchGuild(ctx, args.guildId);
      const file = await soundFileFrom(args.fileUrl, args.fileBase64);
      const created = (await ctx.client.rest.post(`/guilds/${guild.id}/soundboard-sounds`, {
        body: {
          name: args.name,
          volume: String(args.volume ?? 1),
          ...(present(args.emojiId) ? { emoji_id: assertSnowflake('emojiId', args.emojiId!) } : {}),
          ...(present(args.emojiName) ? { emoji_name: args.emojiName } : {}),
        },
        files: [{ key: 'sound', name: file.filename, data: file.buffer }],
        appendToFormData: true,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      })) as unknown as SoundData;
      return `Soundboard sound created: ${soundLine(created)}`;
    },
  });

  reg.tool('edit_guild_sound', {
    description:
      'Edit a custom soundboard sound (name, volume or emoji). Pass emojiId or emojiName as an empty ' +
      'string (with no other emoji value) to clear the emoji.',
    inputSchema: {
      guildId: guildIdParam,
      soundId: snowflakeId('ID of the soundboard sound to edit'),
      name: z.string().min(1).max(32).optional().describe('New sound name'),
      volume: z.number().min(0).max(1).optional().describe('New volume 0–1'),
      emojiId: snowflakeId('New custom emoji ID').optional(),
      emojiName: z.string().optional().describe('New standard unicode emoji'),
      reason: reasonParam,
    },
    handler: async (args) => {
      requireAtMostOne('emojiId', 'emojiName', args.emojiId, args.emojiName);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.volume !== undefined) body.volume = args.volume;
      // Clear the emoji only when an empty string is the ONLY emoji input given;
      // a real value wins over an empty sibling.
      const clearEmoji =
        (args.emojiId !== undefined && !present(args.emojiId) && !present(args.emojiName)) ||
        (args.emojiName !== undefined && !present(args.emojiName) && !present(args.emojiId));
      if (clearEmoji) {
        body.emoji_id = null;
        body.emoji_name = null;
      } else {
        if (present(args.emojiId)) body.emoji_id = assertSnowflake('emojiId', args.emojiId!);
        if (present(args.emojiName)) body.emoji_name = args.emojiName;
      }
      if (!Object.keys(body).length) {
        throw new ValidationError('provide at least one of name, volume, emojiId, emojiName');
      }
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('soundId', args.soundId);
      await ctx.client.rest.patch(`/guilds/${guild.id}/soundboard-sounds/${id}`, {
        body,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return `Soundboard sound ${id} edited`;
    },
  });

  reg.tool('delete_guild_sound', {
    description: 'Permanently delete a custom soundboard sound from the server.',
    inputSchema: {
      guildId: guildIdParam,
      soundId: snowflakeId('ID of the soundboard sound to delete'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('soundId', args.soundId);
      await ctx.client.rest.delete(`/guilds/${guild.id}/soundboard-sounds/${id}`, {
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return `Soundboard sound ${id} deleted`;
    },
  });

  return reg.count;
}
