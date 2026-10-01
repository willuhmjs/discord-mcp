import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Guild } from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchGuild, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { truncate } from '../lib/format.js';
import { guardedFetch, IMAGE_TYPES } from '../lib/fetch.js';
import {
  booleanParam,
  createRegistrar,
  guildIdParam,
  jsonParam,
  limitParam,
  reasonParam,
  snowflakeId,
} from '../lib/register.js';
import { parseJsonParam } from '../lib/validation.js';

// ---------------------------------------------------------------------------
// Scheduled events via raw REST /guilds/{guild.id}/scheduled-events — the
// discord.js manager lacks recurrence rules, so raw REST is used throughout.
// ---------------------------------------------------------------------------

interface RawRecurrenceRule {
  start?: string;
  frequency: number;
  interval?: number;
  by_weekday?: number[] | null;
  by_n_weekday?: Array<{ n: number; day: number }> | null;
  by_month_day?: number[] | null;
  until?: string | null;
  count?: number | null;
}

interface RawScheduledEvent {
  id: string;
  guild_id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  privacy_level: number;
  status: number;
  entity_type: number;
  channel_id?: string | null;
  entity_metadata?: { location?: string } | null;
  creator?: { id: string; username: string; global_name?: string | null } | null;
  user_count?: number;
  recurrence_rule?: RawRecurrenceRule | null;
}

interface RawScheduledEventUser {
  guild_scheduled_event_id?: string;
  user_id?: string;
  user?: { id: string; username: string; global_name?: string | null } | null;
  member?: unknown;
}

const ENTITY_TYPE_NAMES: Record<number, string> = {
  1: 'stage',
  2: 'voice',
  3: 'external',
};

const STATUS_NAMES: Record<number, string> = {
  1: 'scheduled',
  2: 'active',
  3: 'completed',
  4: 'canceled',
};

const FREQUENCY_NAMES: Record<number, string> = {
  0: 'day',
  1: 'week',
  2: 'month',
  3: 'year',
};

const FREQUENCY_IDS: Record<string, number> = {
  daily: 0,
  weekly: 1,
  monthly: 2,
  yearly: 3,
};

const WEEKDAY_IDS: Record<string, number> = {
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
  SUN: 7,
};

const WEEKDAY_NAMES: Record<number, string> = {
  1: 'MON',
  2: 'TUE',
  3: 'WED',
  4: 'THU',
  5: 'FRI',
  6: 'SAT',
  7: 'SUN',
};

const entityTypeParam = z
  .number()
  .int()
  .refine((v) => v === 1 || v === 2 || v === 3, 'entityType: must be 1 (stage), 2 (voice) or 3 (external)')
  .describe('Event type: 1=Stage, 2=Voice, 3=External');

const recurrenceRuleParam = jsonParam(
  'Recurrence rule',
  '{frequency: "daily"|"weekly"|"monthly"|"yearly" (or 0-3), interval?: number, byWeekday?: ["MON","TUE"], ' +
    'byMonthDay?: [1-31], byNWeekday?: [{n, day}] (e.g. 2nd Tuesday), until?: ISO, count?: 1-999}',
);

const coverImageUrlParam = z
  .string()
  .optional()
  .describe('HTTP(S) URL of a cover image (png/jpeg/gif/webp/avif, max 1 MiB)');

/** Validate + normalize an ISO 8601 date-time parameter. */
function parseIsoTime(name: string, value: string): string {
  const v = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v)) {
    throw new ValidationError(`${name}: "${value}" is not an ISO 8601 date-time (e.g. 2026-07-04T20:00:00Z)`);
  }
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) {
    throw new ValidationError(`${name}: "${value}" is not a valid ISO 8601 date-time`);
  }
  return t.toISOString();
}

interface RecurrenceRuleInput {
  frequency?: unknown;
  interval?: unknown;
  byWeekday?: unknown;
  byMonthDay?: unknown;
  byNWeekday?: unknown;
  until?: unknown;
  count?: unknown;
  [k: string]: unknown;
}

function weekdayValue(name: string, v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 7) return v;
  if (typeof v === 'string') {
    const n = WEEKDAY_IDS[v.trim().toUpperCase()];
    if (n !== undefined) return n;
  }
  throw new ValidationError(`${name}: "${String(v)}" must be a weekday MON-SUN (or 1-7, Monday=1)`);
}

/** Parse recurrenceRuleJson into the API's snake_case recurrence_rule object. */
function parseRecurrenceRule(name: string, value: string): Record<string, unknown> {
  const raw = parseJsonParam<RecurrenceRuleInput>(name, value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`${name}: must be a JSON object`);
  }
  const out: Record<string, unknown> = {};
  const f = raw.frequency;
  if (typeof f === 'string') {
    const id = FREQUENCY_IDS[f.trim().toLowerCase()];
    if (id === undefined) {
      throw new ValidationError(`${name}.frequency: must be daily, weekly, monthly or yearly (or 0-3)`);
    }
    out.frequency = id;
  } else if (typeof f === 'number' && Number.isInteger(f) && f >= 0 && f <= 3) {
    out.frequency = f;
  } else {
    throw new ValidationError(`${name}.frequency: required — daily (0), weekly (1), monthly (2) or yearly (3)`);
  }
  if (raw.interval !== undefined && raw.interval !== null) {
    if (typeof raw.interval !== 'number' || !Number.isInteger(raw.interval) || raw.interval < 1) {
      throw new ValidationError(`${name}.interval: must be a whole number >= 1`);
    }
    out.interval = raw.interval;
  }
  if (raw.byWeekday !== undefined && raw.byWeekday !== null) {
    if (!Array.isArray(raw.byWeekday) || !raw.byWeekday.length) {
      throw new ValidationError(`${name}.byWeekday: must be a non-empty array like ["MON","TUE"]`);
    }
    out.by_weekday = raw.byWeekday.map((d, i) => weekdayValue(`${name}.byWeekday[${i}]`, d));
  }
  if (raw.byMonthDay !== undefined && raw.byMonthDay !== null) {
    if (!Array.isArray(raw.byMonthDay) || !raw.byMonthDay.length) {
      throw new ValidationError(`${name}.byMonthDay: must be a non-empty array of days 1-31`);
    }
    out.by_month_day = raw.byMonthDay.map((d, i) => {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 31) {
        throw new ValidationError(`${name}.byMonthDay[${i}]: must be a day of month 1-31`);
      }
      return d;
    });
  }
  if (raw.byNWeekday !== undefined && raw.byNWeekday !== null) {
    if (!Array.isArray(raw.byNWeekday) || !raw.byNWeekday.length) {
      throw new ValidationError(`${name}.byNWeekday: must be a non-empty array like [{n: 2, day: "TUE"}]`);
    }
    out.by_n_weekday = raw.byNWeekday.map((e, i) => {
      const here = `${name}.byNWeekday[${i}]`;
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        throw new ValidationError(`${here}: must be an object {n, day}`);
      }
      const n = (e as Record<string, unknown>).n;
      const day = (e as Record<string, unknown>).day;
      if (typeof n !== 'number' || !Number.isInteger(n) || n === 0 || n < -5 || n > 5) {
        throw new ValidationError(`${here}.n: must be 1-5 (or -1 for the last <day> of the month)`);
      }
      return { n, day: weekdayValue(`${here}.day`, day) };
    });
  }
  if (raw.until !== undefined && raw.until !== null) {
    out.until = parseIsoTime(`${name}.until`, String(raw.until));
  }
  if (raw.count !== undefined && raw.count !== null) {
    if (typeof raw.count !== 'number' || !Number.isInteger(raw.count) || raw.count < 1 || raw.count > 999) {
      throw new ValidationError(`${name}.count: must be a whole number 1-999`);
    }
    out.count = raw.count;
  }
  return out;
}

/** Fetch a cover image URL and convert it to a data URI for the API's `image` field. */
async function coverImageToDataUri(name: string, url: string): Promise<string> {
  const fetched = await guardedFetch(url, { allowedTypes: IMAGE_TYPES, maxBytes: 1024 * 1024 });
  return `data:${fetched.contentType};base64,${fetched.data.toString('base64')}`;
}

function channelLabel(guild: Guild, id: string | null | undefined): string {
  if (!id) return '?';
  const name = guild.channels.cache.get(id)?.name;
  return `#${name ?? id}`;
}

function eventWhere(e: RawScheduledEvent, guild: Guild): string {
  return e.entity_type === 3
    ? `@${e.entity_metadata?.location ?? '?'}`
    : channelLabel(guild, e.channel_id);
}

function ordinal(n: number): string {
  if (n === -1) return 'last';
  if (n < 0) return `${-n}-from-last`;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 1 && mod10 <= 3 && !(mod100 >= 11 && mod100 <= 13)) {
    return `${n}${['th', 'st', 'nd', 'rd'][mod10]}`;
  }
  return `${n}th`;
}

function describeRecurrence(r: RawRecurrenceRule): string {
  const unit = FREQUENCY_NAMES[r.frequency] ?? `frequency ${r.frequency}`;
  const every = r.interval && r.interval > 1 ? `every ${r.interval} ${unit}s` : `every ${unit}`;
  const bits: string[] = [];
  if (r.by_weekday?.length) {
    bits.push(`on ${r.by_weekday.map((d) => WEEKDAY_NAMES[d] ?? String(d)).join('/')}`);
  }
  if (r.by_n_weekday?.length) {
    bits.push(
      `on the ${r.by_n_weekday
        .map((e) => `${ordinal(e.n)} ${WEEKDAY_NAMES[e.day] ?? String(e.day)}`)
        .join(' and ')}`,
    );
  }
  if (r.by_month_day?.length) bits.push(`on day ${r.by_month_day.join(', ')} of the month`);
  if (r.count) bits.push(`${r.count} times`);
  if (r.until) bits.push(`until ${r.until}`);
  return [every, ...bits].join(', ');
}

function formatEventDetail(e: RawScheduledEvent, guild: Guild): string {
  const lines: string[] = [];
  const status = STATUS_NAMES[e.status] ?? `status ${e.status}`;
  lines.push(`${e.name} (id ${e.id}, ${status})`);
  const type = ENTITY_TYPE_NAMES[e.entity_type] ?? `type ${e.entity_type}`;
  lines.push(`type: ${type} (${eventWhere(e, guild)})`);
  if (e.description) lines.push(`description: ${e.description}`);
  lines.push(`starts: ${e.scheduled_start_time}`);
  lines.push(`ends: ${e.scheduled_end_time ?? '(none)'}`);
  if (e.recurrence_rule) lines.push(`recurs: ${describeRecurrence(e.recurrence_rule)}`);
  if (e.creator) lines.push(`creator: @${e.creator.username} (id ${e.creator.id})`);
  if (e.user_count !== undefined && e.user_count !== null) lines.push(`${e.user_count} interested`);
  return truncate(lines.join('\n'));
}

/**
 * Scheduled event tools (create/edit/delete/list/get + interested users).
 * Mutations need Manage Events. Returns the number of tools registered.
 */
export function registerEventTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('create_guild_scheduled_event', {
    description:
      'Schedule a new event on the server (voice, stage, or external), optionally recurring. Requires Manage Events.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).describe('Name of the event'),
      description: z.string().optional().describe('Description of the event'),
      scheduledStartTime: z.string().describe('ISO8601 timestamp for when the event starts'),
      scheduledEndTime: z
        .string()
        .optional()
        .describe('ISO8601 timestamp for when the event ends (required for External events)'),
      entityType: entityTypeParam,
      channelId: z.string().optional().describe('Channel ID (required for types 1 and 2)'),
      location: z.string().optional().describe('Location or link (required for type 3 - External)'),
      recurrenceRuleJson: recurrenceRuleParam,
      coverImageUrl: coverImageUrlParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const entityType: number = args.entityType;
      const start = parseIsoTime('scheduledStartTime', args.scheduledStartTime);
      const end =
        args.scheduledEndTime !== undefined && args.scheduledEndTime !== ''
          ? parseIsoTime('scheduledEndTime', args.scheduledEndTime)
          : undefined;
      if (entityType === 1 || entityType === 2) {
        if (!args.channelId) {
          throw new ValidationError(`channelId: required for entityType ${entityType} (stage/voice events)`);
        }
      }
      if (entityType === 3) {
        if (!args.location) {
          throw new ValidationError('location: required for entityType 3 (external events)');
        }
        if (!end) {
          throw new ValidationError('scheduledEndTime: required for entityType 3 (external events)');
        }
      }
      if (end && Date.parse(end) <= Date.parse(start)) {
        throw new ValidationError('scheduledEndTime: must be after scheduledStartTime');
      }
      const body: Record<string, unknown> = {
        name: args.name,
        privacy_level: 2,
        scheduled_start_time: start,
        entity_type: entityType,
      };
      if (args.description !== undefined && args.description !== '') body.description = args.description;
      if (end) body.scheduled_end_time = end;
      if (entityType !== 3) body.channel_id = assertSnowflake('channelId', args.channelId);
      if (args.location) body.entity_metadata = { location: args.location };
      if (args.recurrenceRuleJson !== undefined && args.recurrenceRuleJson !== '') {
        body.recurrence_rule = parseRecurrenceRule('recurrenceRuleJson', args.recurrenceRuleJson);
      }
      if (args.coverImageUrl !== undefined && args.coverImageUrl !== '') {
        body.image = await coverImageToDataUri('coverImageUrl', args.coverImageUrl);
      }
      const event = (await ctx.client.rest.post(`/guilds/${guild.id}/scheduled-events`, {
        body,
        reason: args.reason,
      })) as RawScheduledEvent;
      const type = ENTITY_TYPE_NAMES[event.entity_type] ?? event.entity_type;
      return `Event "${event.name}" created (id ${event.id}, ${type}, starts ${event.scheduled_start_time})`;
    },
  });

  reg.tool('edit_guild_scheduled_event', {
    description:
      'Modify details of an existing event or change its status (start, complete, cancel). ' +
      'Requires Manage Events.',
    inputSchema: {
      guildId: guildIdParam,
      eventId: snowflakeId('Scheduled event ID'),
      status: z
        .number()
        .int()
        .refine(
          (v) => v >= 1 && v <= 4,
          'status: must be 1 (Scheduled), 2 (Active), 3 (Completed) or 4 (Canceled)',
        )
        .optional()
        .describe('New status: 1=Scheduled, 2=Active (start), 3=Completed, 4=Canceled'),
      name: z.string().min(1).optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      scheduledStartTime: z.string().optional().describe('New ISO8601 start time'),
      scheduledEndTime: z.string().optional().describe('New ISO8601 end time'),
      channelId: z.string().optional().describe('New channel ID (stage/voice events)'),
      location: z.string().optional().describe('New location (for External events)'),
      coverImageUrl: coverImageUrlParam,
      recurrenceRuleJson: recurrenceRuleParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const eventId = assertSnowflake('eventId', args.eventId);
      const body: Record<string, unknown> = {};
      if (args.status !== undefined) body.status = args.status;
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (args.scheduledStartTime !== undefined && args.scheduledStartTime !== '') {
        body.scheduled_start_time = parseIsoTime('scheduledStartTime', args.scheduledStartTime);
      }
      if (args.scheduledEndTime !== undefined && args.scheduledEndTime !== '') {
        body.scheduled_end_time = parseIsoTime('scheduledEndTime', args.scheduledEndTime);
      }
      if (args.channelId !== undefined && args.channelId !== '') {
        body.channel_id = assertSnowflake('channelId', args.channelId);
      }
      if (args.location !== undefined && args.location !== '') {
        body.entity_metadata = { location: args.location };
      }
      if (args.recurrenceRuleJson !== undefined && args.recurrenceRuleJson !== '') {
        body.recurrence_rule = parseRecurrenceRule('recurrenceRuleJson', args.recurrenceRuleJson);
      }
      if (args.coverImageUrl !== undefined && args.coverImageUrl !== '') {
        body.image = await coverImageToDataUri('coverImageUrl', args.coverImageUrl);
      }
      if (!Object.keys(body).length) {
        throw new ValidationError('nothing to edit: provide at least one field to change');
      }
      const event = (await ctx.client.rest.patch(
        `/guilds/${guild.id}/scheduled-events/${eventId}`,
        { body, reason: args.reason },
      )) as RawScheduledEvent;
      const status = STATUS_NAMES[event.status] ?? `status ${event.status}`;
      return `Event "${event.name}" (id ${event.id}) updated — ${status}, starts ${event.scheduled_start_time}`;
    },
  });

  reg.tool('delete_guild_scheduled_event', {
    description: 'Permanently delete a scheduled event. Requires Manage Events.',
    inputSchema: {
      guildId: guildIdParam,
      eventId: snowflakeId('Scheduled event ID'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const eventId = assertSnowflake('eventId', args.eventId);
      await ctx.client.rest.delete(`/guilds/${guild.id}/scheduled-events/${eventId}`, {
        reason: args.reason,
      });
      return `Event ${eventId} deleted`;
    },
  });

  reg.tool('list_guild_scheduled_events', {
    description: 'List all active and scheduled events on the server.',
    inputSchema: {
      guildId: guildIdParam,
      withUserCount: booleanParam('Whether to include the interested user count (default true)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const withUserCount = args.withUserCount ?? true;
      const events = (await ctx.client.rest.get(
        `/guilds/${guild.id}/scheduled-events?with_user_count=${withUserCount}`,
      )) as RawScheduledEvent[];
      if (!Array.isArray(events) || !events.length) return 'No scheduled events.';
      const lines = events.map((e) => {
        const type = ENTITY_TYPE_NAMES[e.entity_type] ?? `type ${e.entity_type}`;
        const count =
          e.user_count !== undefined && e.user_count !== null ? `, ${e.user_count} interested` : '';
        return (
          `${e.name} (id ${e.id}): ${e.scheduled_start_time} → ${e.scheduled_end_time ?? '?'}, ` +
          `${type}, ${eventWhere(e, guild)}${count}`
        );
      });
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('get_guild_scheduled_event', {
    description:
      'Get one scheduled event\u2019s full details, including its recurrence rule, creator and interested count.',
    inputSchema: {
      eventId: snowflakeId('Scheduled event ID'),
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const eventId = assertSnowflake('eventId', args.eventId);
      const event = (await ctx.client.rest.get(
        `/guilds/${guild.id}/scheduled-events/${eventId}`,
      )) as RawScheduledEvent;
      return formatEventDetail(event, guild);
    },
  });

  reg.tool('get_guild_scheduled_event_users', {
    description: 'Get the list of users interested in a scheduled event.',
    inputSchema: {
      guildId: guildIdParam,
      eventId: snowflakeId('Scheduled event ID'),
      limit: limitParam(100, 100),
      withMember: booleanParam('Whether to include full member data with roles (default true)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const eventId = assertSnowflake('eventId', args.eventId);
      const limit = args.limit ?? 100;
      const withMember = args.withMember ?? true;
      const event = (await ctx.client.rest.get(
        `/guilds/${guild.id}/scheduled-events/${eventId}`,
      )) as RawScheduledEvent;
      const users = (await ctx.client.rest.get(
        `/guilds/${guild.id}/scheduled-events/${eventId}/users?with_member=${withMember}&limit=${limit}`,
      )) as RawScheduledEventUser[];
      // While an event is ACTIVE the returned users are participating, not just interested.
      const label = event.status === 2 ? 'participating' : 'interested';
      if (!Array.isArray(users) || !users.length) {
        return `No users ${label} in "${event.name}" yet.`;
      }
      const lines = users.map((u) => {
        const id = u.user?.id ?? u.user_id ?? '?';
        const name = u.user?.global_name ?? u.user?.username ?? id;
        return `${name} (id ${id}, ${label})`;
      });
      return truncate(lines.join('\n'));
    },
  });

  return reg.count;
}
