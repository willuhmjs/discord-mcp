import type { Client, Guild, GuildBasedChannel } from 'discord.js';
import { ValidationError, IntentError } from './errors.js';

const SNOWFLAKE_RE = /^\d{15,21}$/;

/** Validate a snowflake-style ID argument. */
export function assertSnowflake(name: string, value: string): string {
  const v = value?.trim();
  if (!v) throw new ValidationError(`${name}: required`);
  if (!SNOWFLAKE_RE.test(v)) throw new ValidationError(`${name}: "${v}" is not a valid Discord ID`);
  return v;
}

/** Parse a comma-separated list of IDs, validating each. */
export function parseIdList(name: string, value: string | undefined): string[] {
  if (value === undefined || value === null || value.trim() === '') return [];
  return value.split(',').map((part) => assertSnowflake(name, part));
}

export interface InteractionRecord {
  id: string;
  at: number;
  type: string;
  customId: string;
  userId: string;
  userTag: string;
  channelId: string;
  guildId: string;
  messageId?: string;
  values?: string[];
  outcome: string;
}

/** In-memory ring buffer of recent interactions, so the LLM can see who clicked what. */
export class InteractionLog {
  private records: InteractionRecord[] = [];

  constructor(private readonly max = 200) {}

  add(record: InteractionRecord): void {
    this.records.push(record);
    if (this.records.length > this.max) this.records.splice(0, this.records.length - this.max);
  }

  list(filter: { channelId?: string; sinceMs?: number } = {}): InteractionRecord[] {
    const cutoff = filter.sinceMs ? Date.now() - filter.sinceMs : 0;
    return this.records.filter(
      (r) => (!filter.channelId || r.channelId === filter.channelId) && r.at >= cutoff,
    );
  }
}

export interface ToolContext {
  client: Client;
  /** Used when a tool's guildId is omitted. */
  defaultGuildId?: string;
  /** Whether the privileged GuildMembers intent is enabled on this connection. */
  membersIntent: boolean;
  /** Ring buffer of handled interactions. */
  interactions: InteractionLog;
}

/** Resolve the effective guild ID for a guild-scoped tool. */
export function resolveGuildId(ctx: ToolContext, guildId?: string): string {
  const id = guildId?.trim() || ctx.defaultGuildId;
  if (!id) throw new ValidationError('guildId: required (set DISCORD_GUILD_ID or pass guildId)');
  return assertSnowflake('guildId', id);
}

/** Fetch a guild, throwing a friendly error when it is unknown. */
export async function fetchGuild(ctx: ToolContext, guildId?: string): Promise<Guild> {
  const id = resolveGuildId(ctx, guildId);
  try {
    return await ctx.client.guilds.fetch(id);
  } catch {
    throw new ValidationError(`guildId: the bot is not in server ${id} (or the ID is wrong)`);
  }
}

/** Fetch any channel the bot can see (text, voice, thread, forum post, ...). */
export async function fetchChannel<T = GuildBasedChannel>(
  ctx: ToolContext,
  channelId: string,
): Promise<T> {
  const id = assertSnowflake('channelId', channelId);
  try {
    const channel = await ctx.client.channels.fetch(id);
    if (!channel) throw new Error('null channel');
    return channel as T;
  } catch {
    throw new ValidationError(
      `channelId: ${id} is not a channel the bot can see (deleted, or missing View Channel)`,
    );
  }
}

/** A channel you can send messages in (text, DM, thread, announcement, voice-text, forum post). */
export interface SendableChannel {
  id: string;
  send(options: unknown): Promise<{ id: string; url?: string }>;
  messages: {
    fetch(options: unknown): Promise<unknown>;
    fetch(id: string): Promise<unknown>;
  };
}

export async function fetchSendableChannel(ctx: ToolContext, channelId: string): Promise<SendableChannel> {
  const channel = await fetchChannel<SendableChannel & { type: number; isTextBased?(): boolean }>(ctx, channelId);
  if (typeof channel.send !== 'function') {
    throw new ValidationError(
      `channelId: ${channelId} is not a text-like channel (categories and voice channels cannot hold messages; ` +
        'for voice use a voice channel text chat or a thread)',
    );
  }
  return channel;
}

/** Guard for tools that need the privileged GuildMembers intent. */
export function requireMembersIntent(ctx: ToolContext, what: string): void {
  if (!ctx.membersIntent) {
    throw new IntentError(
      `${what} requires the GuildMembers intent. Restart the server with ENABLE_MEMBERS_INTENT=1 and ` +
        'enable "Server Members Intent" for the bot in the Discord developer portal.',
    );
  }
}

/** Extract the webhook id + token from a webhook URL. */
export function parseWebhookUrl(webhookUrl: string): { id: string; token: string } {
  const m = webhookUrl.trim().match(/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,21})\/([\w-]+)$/);
  if (!m) {
    throw new ValidationError(
      'webhookUrl: not a Discord webhook URL (expected https://discord.com/api/webhooks/<id>/<token>)',
    );
  }
  return { id: m[1]!, token: m[2]! };
}

/** Format a millisecond timestamp as ISO 8601 UTC. */
export function isoTime(ms: number | Date | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const d = ms instanceof Date ? ms : new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}
