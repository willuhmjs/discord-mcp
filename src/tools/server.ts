import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AuditLogEvent,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildVerificationLevel,
  type GuildEditOptions,
  type Locale,
} from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchGuild, isoTime, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { truncate } from '../lib/format.js';
import { guardedFetch, IMAGE_TYPES } from '../lib/fetch.js';
import {
  booleanParam,
  createRegistrar,
  guildIdParam,
  jsonParam,
  limitParam,
  optionalIdListParam,
  reasonParam,
  snowflakeId,
} from '../lib/register.js';
import { imageToDataUri, parseJsonParam } from '../lib/validation.js';

/** Fetch an http(s) image URL via guardedFetch (or accept a base64 data URI) and return a Discord data URI. */
async function fetchImageUri(url: string, path: string, maxBytes = 512 * 1024): Promise<string> {
  const trimmed = url.trim();
  if (trimmed.startsWith('data:')) return imageToDataUri(trimmed, path);
  const file = await guardedFetch(trimmed, { allowedTypes: IMAGE_TYPES, maxBytes });
  return `data:${file.contentType};base64,${file.data.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Enum-ish input mappers (accept legacy numeric strings or friendly names)
// ---------------------------------------------------------------------------

const VERIFICATION_LEVELS: Record<string, GuildVerificationLevel> = {
  none: GuildVerificationLevel.None,
  low: GuildVerificationLevel.Low,
  medium: GuildVerificationLevel.Medium,
  high: GuildVerificationLevel.High,
  very_high: GuildVerificationLevel.VeryHigh,
};

function mapVerificationLevel(value: string | number): GuildVerificationLevel {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 4) {
      throw new ValidationError(`verificationLevel: ${value} must be 0-4`);
    }
    return value as GuildVerificationLevel;
  }
  const s = value.trim().toLowerCase();
  if (/^\d+$/.test(s)) return mapVerificationLevel(Number(s));
  const mapped = VERIFICATION_LEVELS[s];
  if (mapped === undefined) {
    throw new ValidationError(`verificationLevel: "${value}" must be 0-4 or none|low|medium|high|very_high`);
  }
  return mapped;
}

const CONTENT_FILTERS: Record<string, GuildExplicitContentFilter> = {
  disabled: GuildExplicitContentFilter.Disabled,
  members_without_roles: GuildExplicitContentFilter.MembersWithoutRoles,
  all_members: GuildExplicitContentFilter.AllMembers,
};

function mapContentFilter(value: string | number): GuildExplicitContentFilter {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 2) {
      throw new ValidationError(`explicitContentFilter: ${value} must be 0-2`);
    }
    return value as GuildExplicitContentFilter;
  }
  const s = value.trim().toLowerCase();
  if (/^\d+$/.test(s)) return mapContentFilter(Number(s));
  const mapped = CONTENT_FILTERS[s];
  if (mapped === undefined) {
    throw new ValidationError(
      `explicitContentFilter: "${value}" must be 0-2 or disabled|members_without_roles|all_members`,
    );
  }
  return mapped;
}

function parseBitfield(value: string | number, field: string): number {
  const s = typeof value === 'number' ? String(value) : value.trim();
  if (!/^\d+$/.test(s)) throw new ValidationError(`${field}: "${value}" must be a numeric bitfield string`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new ValidationError(`${field}: bitfield too large`);
  return n;
}

/**
 * Server-level incident actions: ISO 8601 timestamp, a relative duration
 * ("30m", "1h", "6h"), or "clear"/"none"/"" to lift the restriction.
 */
function parseIncidentUntil(field: string, value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v || v === 'clear' || v === 'none' || v === 'off' || v === 'false') return null;
  const dur = v.match(/^(\d+)\s*(s|m|h|d)?$/);
  if (dur) {
    const n = Number(dur[1]!);
    const unit = dur[2] ?? 'm';
    const ms =
      unit === 's' ? n * 1_000 : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${field}: "${value}" must be ISO 8601, a duration like 30m/1h/6h, or "clear"`);
  }
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Onboarding prompt mapping (camelCase tool JSON → snake_case REST body)
// ---------------------------------------------------------------------------

function parseIdListField(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((v, i) => assertSnowflake(`${field}[${i}]`, String(v)));
  }
  const s = String(value);
  if (!s.trim()) return [];
  return s.split(',').map((part, i) => assertSnowflake(`${field}[${i}]`, part));
}

let promptIdCounter = 0;

/** A snowflake-ish unique ID for new onboarding prompts (Discord requires an id even for new prompts). */
function generatePromptId(): string {
  const unixMs = BigInt(Date.now()) - 1420070400000n;
  const worker = 1n << 17n;
  const seq = BigInt((promptIdCounter += 1) % 4096);
  return (unixMs << 22n | worker | seq).toString();
}

function mapOnboardingPrompts(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError('promptsJson: must be a JSON array of prompt objects');
  return value.map((p, i) => {
    const here = `promptsJson[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new ValidationError(`${here}: must be an object`);
    }
    const raw = p as Record<string, unknown>;
    const title = raw.title === undefined || raw.title === null ? '' : String(raw.title).trim();
    if (!title) throw new ValidationError(`${here}.title: required`);
    const options = raw.options;
    if (!Array.isArray(options) || !options.length) {
      throw new ValidationError(`${here}.options: at least one option required`);
    }
    const mappedOptions = options.map((o, j) => {
      const oh = `${here}.options[${j}]`;
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        throw new ValidationError(`${oh}: must be an object`);
      }
      const opt = o as Record<string, unknown>;
      const optTitle = opt.title === undefined || opt.title === null ? '' : String(opt.title).trim();
      if (!optTitle) throw new ValidationError(`${oh}.title: required`);
      const channelIds = parseIdListField(opt.channelIds, `${oh}.channelIds`);
      const roleIds = parseIdListField(opt.roleIds, `${oh}.roleIds`);
      if (!channelIds.length && !roleIds.length) {
        throw new ValidationError(`${oh}: each option needs channelIds and/or roleIds`);
      }
      const out: Record<string, unknown> = { title: optTitle, channel_ids: channelIds, role_ids: roleIds };
      if (opt.description !== undefined && opt.description !== null) out.description = String(opt.description);
      let emojiName: unknown = opt.emojiName;
      let emojiId: unknown = opt.emojiId;
      if (opt.emoji && typeof opt.emoji === 'object' && !Array.isArray(opt.emoji)) {
        const e = opt.emoji as Record<string, unknown>;
        emojiName = e.emojiName ?? e.emoji_name ?? emojiName;
        emojiId = e.emojiId ?? e.emoji_id ?? emojiId;
      }
      out.emoji_name = emojiName === undefined || emojiName === null ? null : String(emojiName);
      out.emoji_id = emojiId === undefined || emojiId === null ? null : String(emojiId);
      return out;
    });
    const prompt: Record<string, unknown> = {
      id:
        raw.id !== undefined && raw.id !== null && String(raw.id).trim()
          ? assertSnowflake(`${here}.id`, String(raw.id))
          : generatePromptId(),
      title,
      options: mappedOptions,
      type: 0,
    };
    if (raw.type !== undefined && raw.type !== null) {
      const t = Number(raw.type);
      if (t !== 0 && t !== 1) throw new ValidationError(`${here}.type: must be 0 (multiple choice) or 1 (dropdown)`);
      prompt.type = t;
    }
    prompt.single_select = raw.singleSelect === undefined || raw.singleSelect === null ? true : Boolean(raw.singleSelect);
    prompt.required = raw.required === undefined || raw.required === null ? false : Boolean(raw.required);
    prompt.in_onboarding = raw.inOnboarding === undefined || raw.inOnboarding === null ? true : Boolean(raw.inOnboarding);
    if (raw.invert !== undefined && raw.invert !== null) prompt.invert = Boolean(raw.invert);
    return prompt;
  });
}

// ---------------------------------------------------------------------------
// Audit log helpers
// ---------------------------------------------------------------------------

const AUDIT_NAMES = AuditLogEvent as unknown as Record<number, string>;

function parseActionType(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ValidationError(`actionType: ${value} is not a valid audit log action type`);
    }
    return value;
  }
  const s = value.trim();
  if (/^\d+$/.test(s)) return parseActionType(Number(s));
  const byName = AuditLogEvent as unknown as Record<string, number>;
  if (byName[s] !== undefined) return byName[s]!;
  throw new ValidationError(
    `actionType: unknown action type "${value}" (use a number or an AuditLogEvent name like MemberKick)`,
  );
}

/** Discord snowflakes encode their creation time in the top 22 bits. */
function snowflakeMs(id: string): number | null {
  try {
    return Number(BigInt(id) >> 22n) + 1420070400000;
  } catch {
    return null;
  }
}

function fmtChangeValue(v: unknown): string {
  if (v === undefined || v === null) return '∅';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

interface RawAuditEntry {
  id?: string;
  action_type?: number;
  user_id?: string;
  target_id?: string | null;
  changes?: Array<{ key?: unknown; old_value?: unknown; new_value?: unknown }>;
  reason?: string;
}

interface RawAuditLogBody {
  audit_log_entries?: RawAuditEntry[];
  users?: Array<{ id?: string; username?: string; global_name?: string | null }>;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Server (guild) settings tools: info, edits, welcome screen, onboarding,
 * incidents, widget, vanity URL, integrations, voice regions, templates,
 * and the audit log. Returns the number of tools registered.
 */
export function registerServerTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('get_server_info', {
    description: 'Get detailed Discord server information: name, owner, boosts, verification level, features, counts.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      let owner = `id ${guild.ownerId}`;
      try {
        const o = await guild.fetchOwner();
        owner = `${o.user.tag} (id ${o.id})`;
      } catch {
        // Owner not fetchable — fall back to the raw ID.
      }
      const features = guild.features;
      const shown = features.slice(0, 10).join(', ');
      const lines = [
        `${guild.name} (id ${guild.id})`,
        `Owner: ${owner}`,
        `Created: ${isoTime(guild.createdTimestamp)}`,
        `Members: ${guild.memberCount}`,
        `Premium: tier ${guild.premiumTier}, ${guild.premiumSubscriptionCount ?? 0} boosts`,
        `Description: ${guild.description ?? '(none)'}`,
        `Verification: ${verificationLevelName(guild.verificationLevel)}`,
      ];
      if (shown) {
        lines.push(
          `Features: ${shown}${features.length > 10 ? ` (+${features.length - 10} more)` : ''}`,
        );
      }
      lines.push(
        `Channels: ${guild.channels.cache.size}, roles: ${guild.roles.cache.size}, emojis: ${guild.emojis.cache.size}`,
      );
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('edit_server', {
    description:
      'Edit server settings: name, description, icon/banner images, verification level, default notifications, ' +
      'explicit content filter, AFK channel/timeout, system channel + flags, rules/public-updates channels, ' +
      'preferred locale. Only provided fields are changed. Requires Manage Server. Mutating but reversible.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(2).max(100).optional().describe('New server name'),
      description: z.string().max(120).optional().describe('New server description (community servers)'),
      iconUrl: z
        .string()
        .optional()
        .describe('Image URL (or data URI) for the new server icon — fetched by the server, max 256KB'),
      bannerUrl: z
        .string()
        .optional()
        .describe('Image URL (or data URI) for the new server banner — fetched by the server, max 256KB'),
      verificationLevel: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Verification level: 0-4 or none|low|medium|high|very_high'),
      defaultNotifications: z
        .enum(['all_messages', 'only_mentions'])
        .optional()
        .describe('Default notification setting for new members'),
      explicitContentFilter: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Explicit content filter: 0-2 or disabled|members_without_roles|all_members'),
      afkChannelId: z.string().optional().describe('AFK voice channel ID'),
      afkTimeout: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('AFK timeout in seconds (allowed: 60, 300, 900, 1800, 3600)'),
      systemChannelId: z.string().optional().describe('System channel ID (join/boost notices)'),
      systemChannelFlags: z
        .union([z.string(), z.number()])
        .optional()
        .describe('System channel flags as a numeric bitfield string (1=no joins, 2=no boosts, 4=no tips, ...)'),
      rulesChannelId: z.string().optional().describe('Rules channel ID (community servers)'),
      publicUpdatesChannelId: z.string().optional().describe('Public updates channel ID (community servers)'),
      preferredLocale: z.string().optional().describe("Preferred locale, e.g. 'en-US'"),
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const options: GuildEditOptions = {};
      if (args.name !== undefined) options.name = args.name;
      if (args.description !== undefined) options.description = args.description;
      if (args.iconUrl !== undefined) options.icon = await fetchImageUri(args.iconUrl, 'iconUrl', 256 * 1024);
      if (args.bannerUrl !== undefined) options.banner = await fetchImageUri(args.bannerUrl, 'bannerUrl', 256 * 1024);
      if (args.verificationLevel !== undefined) options.verificationLevel = mapVerificationLevel(args.verificationLevel);
      if (args.defaultNotifications !== undefined) {
        options.defaultMessageNotifications =
          args.defaultNotifications === 'all_messages'
            ? GuildDefaultMessageNotifications.AllMessages
            : GuildDefaultMessageNotifications.OnlyMentions;
      }
      if (args.explicitContentFilter !== undefined) {
        options.explicitContentFilter = mapContentFilter(args.explicitContentFilter);
      }
      if (args.afkChannelId !== undefined) options.afkChannel = assertSnowflake('afkChannelId', args.afkChannelId);
      if (args.afkTimeout !== undefined) options.afkTimeout = args.afkTimeout;
      if (args.systemChannelId !== undefined) options.systemChannel = assertSnowflake('systemChannelId', args.systemChannelId);
      if (args.systemChannelFlags !== undefined) {
        options.systemChannelFlags = parseBitfield(args.systemChannelFlags, 'systemChannelFlags');
      }
      if (args.rulesChannelId !== undefined) options.rulesChannel = assertSnowflake('rulesChannelId', args.rulesChannelId);
      if (args.publicUpdatesChannelId !== undefined) {
        options.publicUpdatesChannel = assertSnowflake('publicUpdatesChannelId', args.publicUpdatesChannelId);
      }
      if (args.preferredLocale !== undefined) options.preferredLocale = args.preferredLocale as Locale;
      if (args.reason) options.reason = args.reason;
      if (!Object.keys(options).some((k) => k !== 'reason')) {
        throw new ValidationError('edit_server: provide at least one setting to change');
      }
      await guild.edit(options);
      return 'Server settings updated';
    },
  });

  reg.tool('get_welcome_screen', {
    description: "Get the server's welcome screen (community servers): description and suggested channels.",
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = (await ctx.client.rest.get(`/guilds/${guild.id}/welcome-screen`)) as {
        description?: string | null;
        welcome_channels?: Array<{
          channel_id?: string;
          description?: string;
          emoji_name?: string | null;
          emoji_id?: string | null;
        }>;
      };
      const lines = [`Description: ${raw.description ?? '(none)'}`];
      const channels = raw.welcome_channels ?? [];
      lines.push(channels.length ? `${channels.length} suggested channels:` : 'No suggested channels.');
      for (const c of channels) {
        const name = c.channel_id ? guild.channels.cache.get(c.channel_id)?.name : undefined;
        const emoji = c.emoji_name ?? (c.emoji_id ? `custom emoji ${c.emoji_id}` : '');
        lines.push(
          `#${name ?? 'unknown'} (id ${c.channel_id ?? '?'}): ${c.description ?? ''}${emoji ? ` [${emoji}]` : ''}`,
        );
      }
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('edit_welcome_screen', {
    description:
      "Edit the server's welcome screen (community servers): enable/disable it, set the description, and set " +
      'suggested channels. Requires Manage Server.',
    inputSchema: {
      guildId: guildIdParam,
      enabled: booleanParam('Whether the welcome screen is enabled'),
      description: z.string().max(140).optional().describe('Welcome screen description'),
      channelsJson: jsonParam(
        'Suggested channels',
        'Array: [{"channelId":"123","description":"Come say hi","emojiName":"👋","emojiId":null}]. Emoji can be a unicode emoji name or a custom emoji ID.',
      ),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const body: Record<string, unknown> = {};
      if (args.enabled !== undefined) body.enabled = args.enabled;
      if (args.description !== undefined) body.description = args.description;
      if (args.channelsJson !== undefined) {
        const parsed = parseJsonParam<unknown>('channelsJson', args.channelsJson);
        if (!Array.isArray(parsed)) throw new ValidationError('channelsJson: must be a JSON array');
        body.welcome_channels = parsed.map((c, i) => {
          const here = `channelsJson[${i}]`;
          if (!c || typeof c !== 'object' || Array.isArray(c)) {
            throw new ValidationError(`${here}: must be an object {channelId, description, emojiName?, emojiId?}`);
          }
          const raw = c as Record<string, unknown>;
          const channelId = assertSnowflake(`${here}.channelId`, String(raw.channelId ?? ''));
          const description = raw.description === undefined || raw.description === null ? '' : String(raw.description);
          if (!description.trim()) throw new ValidationError(`${here}.description: required`);
          return {
            channel_id: channelId,
            description,
            emoji_name: raw.emojiName === undefined || raw.emojiName === null ? null : String(raw.emojiName),
            emoji_id: raw.emojiId === undefined || raw.emojiId === null ? null : String(raw.emojiId),
          };
        });
      }
      if (!Object.keys(body).length) {
        throw new ValidationError('edit_welcome_screen: provide enabled, description, or channelsJson');
      }
      const updated = (await ctx.client.rest.patch(`/guilds/${guild.id}/welcome-screen`, {
        body,
        reason: args.reason,
      })) as { description?: string | null; welcome_channels?: unknown[] };
      return `Welcome screen updated: description ${updated.description ? 'set' : 'empty'}, ${
        updated.welcome_channels?.length ?? 0
      } suggested channels`;
    },
  });

  reg.tool('get_onboarding', {
    description:
      "Get the server's onboarding configuration (community servers): prompts, default channels, and mode.",
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = (await ctx.client.rest.get(`/guilds/${guild.id}/onboarding`)) as {
        prompts?: Array<{
          title?: string;
          type?: number;
          single_select?: boolean;
          required?: boolean;
          in_onboarding?: boolean;
          options?: Array<{
            title?: string;
            description?: string | null;
            emoji?: { name?: string | null; id?: string | null } | null;
            channel_ids?: string[];
            role_ids?: string[];
          }>;
        }>;
        default_channel_ids?: string[];
        enabled?: boolean;
        mode?: number;
      };
      const lines = [
        `Enabled: ${raw.enabled ? 'yes' : 'no'}`,
        `Mode: ${raw.mode === 1 ? 'onboarding' : 'default'} (${raw.mode ?? 0})`,
      ];
      const defaults = raw.default_channel_ids ?? [];
      lines.push(
        `Default channels (${defaults.length}): ${defaults
          .map((id) => `#${guild.channels.cache.get(id)?.name ?? id}`)
          .join(', ') || '(none)'}`,
      );
      const prompts = raw.prompts ?? [];
      lines.push(`Prompts: ${prompts.length}`);
      for (const p of prompts) {
        const attrs = [p.type === 1 ? 'dropdown' : 'multiple choice'];
        if (p.single_select) attrs.push('single-select');
        if (p.required) attrs.push('required');
        if (!p.in_onboarding) attrs.push('channels & roles tab only');
        lines.push(`- ${p.title ?? '(untitled)'} (${attrs.join(', ')})`);
        for (const o of p.options ?? []) {
          const grants = [
            ...(o.channel_ids ?? []).map((id) => `#${guild.channels.cache.get(id)?.name ?? id}`),
            ...(o.role_ids ?? []).map((id) => `@${guild.roles.cache.get(id)?.name ?? id}`),
          ];
          lines.push(
            `  - ${o.title ?? '(untitled)'}${o.description ? `: ${o.description}` : ''} → ${grants.join(', ') || '(nothing)'}`,
          );
        }
      }
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('edit_onboarding', {
    description:
      "Edit the server's onboarding configuration (community servers). Requires BOTH Manage Server and " +
      'Manage Roles permissions. promptsJson options map to channels/roles new members get opted into.',
    inputSchema: {
      guildId: guildIdParam,
      promptsJson: jsonParam(
        'Onboarding prompts',
        'Array: [{"title":"What do you like?","type":0,"singleSelect":true,"required":false,"options":[{"title":"Gaming","description":"...","emoji":{"emojiName":"🎮"},"channelIds":["123"],"roleIds":["456"]}]}]. Every option needs channelIds and/or roleIds.',
      ),
      defaultChannelIds: optionalIdListParam('default channel IDs members are opted into'),
      enabled: booleanParam('Whether onboarding is enabled'),
      mode: z
        .enum(['default', 'onboarding'])
        .optional()
        .describe("'default' (0) shows Channels & Roles tab; 'onboarding' (1) forces new members through it"),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const body: Record<string, unknown> = {};
      if (args.promptsJson !== undefined) body.prompts = mapOnboardingPrompts(parseJsonParam('promptsJson', args.promptsJson));
      if (args.defaultChannelIds !== undefined) {
        const ids = parseIdListField(args.defaultChannelIds, 'defaultChannelIds');
        body.default_channel_ids = ids;
      }
      if (args.enabled !== undefined) body.enabled = args.enabled;
      if (args.mode !== undefined) body.mode = args.mode === 'onboarding' ? 1 : 0;
      if (!Object.keys(body).length) {
        throw new ValidationError('edit_onboarding: provide promptsJson, defaultChannelIds, enabled, or mode');
      }
      // Discord only supports PUT on this endpoint (it replaces the given fields).
      const raw = (await ctx.client.rest.put(`/guilds/${guild.id}/onboarding`, {
        body,
        reason: args.reason,
      })) as {
        prompts?: unknown[];
        default_channel_ids?: string[];
        enabled?: boolean;
        mode?: number;
      };
      return `Onboarding updated: ${raw.enabled ? 'enabled' : 'disabled'}, mode ${
        raw.mode === 1 ? 'onboarding' : 'default'
      }, ${raw.prompts?.length ?? 0} prompts, ${raw.default_channel_ids?.length ?? 0} default channels`;
    },
  });

  reg.tool('set_incident_actions', {
    description:
      'Temporarily disable server invites and/or member DMs (raid response). Pass an ISO 8601 timestamp, a ' +
      'duration like "30m"/"1h"/"6h", or "clear" to lift the restriction. Mutating but reversible.',
    inputSchema: {
      guildId: guildIdParam,
      invitesDisabledUntil: z
        .string()
        .optional()
        .describe('Disable new invites until: ISO 8601 time, duration (30m/1h/6h), or "clear"'),
      dmsDisabledUntil: z
        .string()
        .optional()
        .describe('Disable member DMs until: ISO 8601 time, duration (30m/1h/6h), or "clear"'),
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      if (args.invitesDisabledUntil === undefined && args.dmsDisabledUntil === undefined) {
        throw new ValidationError('set_incident_actions: provide invitesDisabledUntil and/or dmsDisabledUntil');
      }
      const body: Record<string, unknown> = {};
      if (args.invitesDisabledUntil !== undefined) {
        body.invites_disabled_until = parseIncidentUntil('invitesDisabledUntil', args.invitesDisabledUntil);
      }
      if (args.dmsDisabledUntil !== undefined) {
        body.dms_disabled_until = parseIncidentUntil('dmsDisabledUntil', args.dmsDisabledUntil);
      }
      const raw = (await ctx.client.rest.put(`/guilds/${guild.id}/incident-actions`, { body })) as {
        invites_disabled_until?: string | null;
        dms_disabled_until?: string | null;
      };
      const invites = raw.invites_disabled_until ? `disabled until ${raw.invites_disabled_until}` : 'enabled';
      const dms = raw.dms_disabled_until ? `disabled until ${raw.dms_disabled_until}` : 'enabled';
      return `Incident actions set — invites: ${invites}; member DMs: ${dms}`;
    },
  });

  reg.tool('get_widget', {
    description:
      'Get the server widget settings and live widget data: enabled state, channel, and online (presence) count.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const lines: string[] = [];
      let name = guild.name;
      try {
        const settings = (await ctx.client.rest.get(`/guilds/${guild.id}/widget`)) as {
          enabled?: boolean;
          channel_id?: string | null;
        };
        lines.push(`Enabled: ${settings.enabled ? 'yes' : 'no'}`);
        const channel = settings.channel_id
          ? `#${guild.channels.cache.get(settings.channel_id)?.name ?? '?'} (id ${settings.channel_id})`
          : '(not set)';
        lines.push(`Channel: ${channel}`);
      } catch {
        lines.push('Enabled: unknown (could not read widget settings — needs Manage Server)');
      }
      try {
        const data = (await ctx.client.rest.get(`/guilds/${guild.id}/widget.json`)) as {
          name?: string;
          presence_count?: number;
          instant_invite?: string | null;
          channels?: unknown[];
          members?: unknown[];
        };
        name = data.name ?? name;
        lines.push(`Online members (presence count): ${data.presence_count ?? 0}`);
        if (data.instant_invite) lines.push(`Invite: ${data.instant_invite}`);
        lines.push(`Channels listed: ${data.channels?.length ?? 0}, members listed: ${data.members?.length ?? 0}`);
      } catch {
        lines.push('Widget data unavailable (the widget is disabled or not yet generated)');
      }
      return truncate(`Widget for ${name} (id ${guild.id}):\n${lines.join('\n')}`);
    },
  });

  reg.tool('edit_widget', {
    description: 'Edit the server widget settings: enable/disable it and set the invite channel.',
    inputSchema: {
      guildId: guildIdParam,
      enabled: booleanParam('Whether the widget is enabled'),
      channelId: z.string().optional().describe('Widget invite channel ID'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const body: Record<string, unknown> = {};
      if (args.enabled !== undefined) body.enabled = args.enabled;
      if (args.channelId !== undefined) body.channel_id = assertSnowflake('channelId', args.channelId);
      if (!Object.keys(body).length) throw new ValidationError('edit_widget: provide enabled and/or channelId');
      const updated = (await ctx.client.rest.patch(`/guilds/${guild.id}/widget`, {
        body,
        reason: args.reason,
      })) as { enabled?: boolean; channel_id?: string | null };
      return `Widget updated: ${updated.enabled ? 'enabled' : 'disabled'}, channel ${
        updated.channel_id ?? '(none)'
      }`;
    },
  });

  reg.tool('get_vanity_url', {
    description: "Get the server's custom vanity invite URL and its uses (requires a boosted server).",
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = (await ctx.client.rest.get(`/guilds/${guild.id}/vanity-url`)) as {
        code?: string | null;
        uses?: number | null;
      };
      if (!raw.code) return 'No vanity URL set (needs a boosted server)';
      return `Vanity URL: https://discord.gg/${raw.code} (${raw.uses ?? 0} uses)`;
    },
  });

  reg.tool('list_integrations', {
    description: 'List the bot/external integrations (twitch, YouTube, ...) connected to the server.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = await ctx.client.rest.get(`/guilds/${guild.id}/integrations`);
      const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      if (!list.length) return 'No integrations.';
      const lines = list.map((i) => {
        // Only id/name/type/enabled — never tokens or secrets.
        const name = String(i.name ?? '(unnamed)');
        const type = String(i.type ?? '?');
        const id = String(i.id ?? '?');
        const enabled = i.enabled === undefined ? '' : i.enabled ? ', enabled' : ', disabled';
        return `${name} (${type}, id ${id}${enabled})`;
      });
      return truncate(`${list.length} integrations:\n${lines.join('\n')}`);
    },
  });

  reg.tool('delete_integration', {
    description: 'Remove an integration (connected bot or external service) from the server.',
    inputSchema: {
      guildId: guildIdParam,
      integrationId: snowflakeId('Integration ID'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const id = assertSnowflake('integrationId', args.integrationId);
      await ctx.client.rest.delete(`/guilds/${guild.id}/integrations/${id}`, { reason: args.reason });
      return `Integration ${id} deleted`;
    },
  });

  reg.tool('list_voice_regions', {
    description: 'List the available Discord voice server regions.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const raw = await ctx.client.rest.get('/voice/regions');
      const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      const lines = list.map((r) => {
        const optimal = r.optimal ? ', optimal' : '';
        const deprecated = r.deprecated ? ', deprecated' : '';
        return `${String(r.id ?? '?')} (${String(r.name ?? '?')}${optimal}${deprecated})`;
      });
      return truncate(`${list.length} voice regions:\n${lines.join('\n')}`) || '(no voice regions)';
    },
  });

  reg.tool('list_guild_templates', {
    description: "List the server's templates with their codes, usage counts, and timestamps.",
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = await ctx.client.rest.get(`/guilds/${guild.id}/templates`);
      const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      if (!list.length) return 'No templates.';
      const lines = list.map((t) => {
        const name = String(t.name ?? '(unnamed)');
        const code = String(t.code ?? '?');
        const uses = Number(t.usage_count ?? 0);
        const created = t.created_at ? String(t.created_at) : '?';
        const updated = t.updated_at ? String(t.updated_at) : '?';
        const desc = t.description ? ` — ${String(t.description)}` : '';
        return `${name} (code ${code}, ${uses} uses, created ${created}, updated ${updated})${desc}`;
      });
      return truncate(`${list.length} templates:\n${lines.join('\n')}`);
    },
  });

  reg.tool('create_guild_template', {
    description: 'Create a template of the server that others can use to copy its structure.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).max(100).describe('Template name'),
      description: z.string().max(120).optional().describe('Template description'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const body: Record<string, unknown> = { name: args.name };
      if (args.description !== undefined) body.description = args.description;
      const raw = (await ctx.client.rest.post(`/guilds/${guild.id}/templates`, {
        body,
        reason: args.reason,
      })) as { code?: string; name?: string };
      return `Template "${raw.name ?? args.name}" created (code ${raw.code ?? '?'})`;
    },
  });

  reg.tool('sync_guild_template', {
    description: 'Sync a server template with the current server structure.',
    inputSchema: {
      guildId: guildIdParam,
      templateCode: z.string().min(1).describe('Template code to sync'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = (await ctx.client.rest.put(
        `/guilds/${guild.id}/templates/${encodeURIComponent(args.templateCode)}`,
        { reason: args.reason },
      )) as { name?: string; code?: string; updated_at?: string };
      return `Template "${raw.name ?? args.templateCode}" (code ${raw.code ?? args.templateCode}) synced${
        raw.updated_at ? `, updated ${raw.updated_at}` : ''
      }`;
    },
  });

  reg.tool('edit_guild_template', {
    description: "Edit a server template's name and/or description.",
    inputSchema: {
      guildId: guildIdParam,
      templateCode: z.string().min(1).describe('Template code to edit'),
      name: z.string().min(1).max(100).optional().describe('New template name'),
      description: z.string().max(120).optional().describe('New template description'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (!Object.keys(body).length) {
        throw new ValidationError('edit_guild_template: provide name and/or description');
      }
      const raw = (await ctx.client.rest.patch(
        `/guilds/${guild.id}/templates/${encodeURIComponent(args.templateCode)}`,
        { body, reason: args.reason },
      )) as { name?: string; code?: string };
      return `Template "${raw.name ?? args.templateCode}" (code ${raw.code ?? args.templateCode}) updated`;
    },
  });

  reg.tool('delete_guild_template', {
    description: 'Delete a server template.',
    inputSchema: {
      guildId: guildIdParam,
      templateCode: z.string().min(1).describe('Template code to delete'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = (await ctx.client.rest.delete(
        `/guilds/${guild.id}/templates/${encodeURIComponent(args.templateCode)}`,
        { reason: args.reason },
      )) as { name?: string; code?: string };
      return `Template "${raw.name ?? '(unnamed)'}" (code ${raw.code ?? args.templateCode}) deleted`;
    },
  });

  reg.tool('get_audit_log', {
    description:
      "Read the server's audit log (who did what, when, with what changes). Filter by user and action type; " +
      'use "before" with the last entry ID to page through history. Requires View Audit Log permission.',
    inputSchema: {
      guildId: guildIdParam,
      userId: z.string().optional().describe('Only entries created by this user ID'),
      actionType: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Only entries of this action type — number (e.g. 20) or name (e.g. "MemberKick")'),
      before: z.string().optional().describe('Only entries before this audit log entry ID (for pagination)'),
      limit: limitParam(25, 100),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const query = new URLSearchParams();
      query.set('limit', String(args.limit ?? 25));
      if (args.userId !== undefined) query.set('user_id', assertSnowflake('userId', args.userId));
      if (args.actionType !== undefined) query.set('action_type', String(parseActionType(args.actionType)));
      if (args.before !== undefined) query.set('before', assertSnowflake('before', args.before));
      const body = (await ctx.client.rest.get(`/guilds/${guild.id}/audit-logs`, { query })) as RawAuditLogBody;
      const entries = body.audit_log_entries ?? [];
      if (!entries.length) return 'No audit log entries found.';
      const users = new Map<string, string>();
      for (const u of body.users ?? []) {
        if (u.id) users.set(u.id, u.global_name ?? u.username ?? u.id);
      }
      const lines = entries.map((e) => {
        const ms = e.id ? snowflakeMs(e.id) : null;
        const when = ms ? isoTime(ms) : '?';
        const action = AUDIT_NAMES[e.action_type as number] ?? `Unknown(${e.action_type})`;
        const actor = e.user_id ? users.get(e.user_id) ?? `id ${e.user_id}` : 'unknown user';
        const changes = (e.changes ?? [])
          .slice(0, 6)
          .map((c) => `${String(c.key ?? '?')}: ${fmtChangeValue(c.old_value)} → ${fmtChangeValue(c.new_value)}`);
        const parts: string[] = [];
        if (changes.length) parts.push(changes.join('; '));
        if (e.reason) parts.push(`reason: ${e.reason}`);
        const tail = parts.length ? `: ${parts.join(', ')}` : '';
        return `[${when}] ${action} by @${actor} → target ${e.target_id ?? '?'}${tail}`;
      });
      return truncate(`${entries.length} audit log entries (newest first):\n${lines.join('\n')}`);
    },
  });

  return reg.count;
}

function verificationLevelName(level: GuildVerificationLevel): string {
  const names: Record<number, string> = {
    [GuildVerificationLevel.None]: 'none',
    [GuildVerificationLevel.Low]: 'low',
    [GuildVerificationLevel.Medium]: 'medium',
    [GuildVerificationLevel.High]: 'high',
    [GuildVerificationLevel.VeryHigh]: 'very high',
  };
  return names[level] ?? String(level);
}
