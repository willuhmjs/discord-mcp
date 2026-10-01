import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GuildMemberEditOptions } from 'discord.js';
import { z } from 'zod';
import {
  assertSnowflake,
  fetchGuild,
  isoTime,
  parseIdList,
  requireMembersIntent,
  type ToolContext,
} from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { formatUserLine, truncate } from '../lib/format.js';
import {
  booleanParam,
  createRegistrar,
  guildIdParam,
  limitParam,
  optionalIdListParam,
  reasonParam,
  snowflakeId,
  userIdParam,
} from '../lib/register.js';

const TIMEOUT_MAX_MS = 28 * 24 * 60 * 60 * 1000; // Discord caps timeouts at 28 days
const TIMEOUT_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse edit_member's timeoutUntil: an ISO 8601 timestamp, a relative
 * duration ("30s", "10m", "2h", "1d", "7d") or "clear"/"none"/"" to remove
 * the timeout. Returns null to clear.
 */
function parseTimeoutUntil(value: string): Date | null {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'clear' || v === 'none' || v === 'off' || v === 'remove') return null;
  const rel = v.match(/^(\d+)\s*([smhdw])$/);
  if (rel) {
    const ms = Number.parseInt(rel[1]!, 10) * TIMEOUT_UNITS[rel[2]!]!;
    if (ms <= 0) throw new ValidationError(`timeoutUntil: "${value}" must be a positive duration`);
    if (ms > TIMEOUT_MAX_MS) {
      throw new ValidationError(`timeoutUntil: "${value}" exceeds Discord's 28-day timeout limit`);
    }
    return new Date(Date.now() + ms);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(
      `timeoutUntil: "${value}" is not an ISO 8601 date or a duration like "30m", "2h", "7d" (or "clear" to remove)`,
    );
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ValidationError(`timeoutUntil: "${value}" is in the past — pass "clear" to remove a timeout`);
  }
  if (parsed.getTime() - Date.now() > TIMEOUT_MAX_MS) {
    throw new ValidationError(`timeoutUntil: "${value}" is more than 28 days away (Discord's limit)`);
  }
  return parsed;
}

/** Validate a nickname-length string parameter (Discord caps nicknames at 32 chars). */
function checkNick(value: string | undefined, param: string): void {
  if (value !== undefined && value.length > 32) {
    throw new ValidationError(`${param}: ${value.length} chars > 32`);
  }
}

/**
 * Member & moderation tools: the legacy kick/ban/timeout/nickname/bans set
 * plus member detail, search, bulk ban and prune.
 * Returns the number of tools registered.
 */
export function registerMemberTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('kick_member', {
    description: 'Kick a member from the server. They can rejoin with a new invite.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      await guild.members.kick(userId, args.reason);
      return `Kicked user ${userId} from ${guild.name}`;
    },
  });

  reg.tool('ban_member', {
    description:
      'Ban a user from the server, optionally deleting their recent messages. Prevents rejoining until unbanned.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      deleteMessageSeconds: z
        .number()
        .int()
        .min(0)
        .max(604800)
        .optional()
        .describe('Delete the user\u2019s messages from the last N seconds (max 604800 = 7 days; 0 = none)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      const options: { deleteMessageSeconds?: number; reason?: string } = {};
      if (args.deleteMessageSeconds !== undefined) options.deleteMessageSeconds = args.deleteMessageSeconds;
      if (args.reason !== undefined) options.reason = args.reason;
      await guild.members.ban(userId, options);
      const note =
        args.deleteMessageSeconds !== undefined && args.deleteMessageSeconds > 0
          ? ` (deleted messages from the last ${args.deleteMessageSeconds}s)`
          : '';
      return `Banned user ${userId} from ${guild.name}${note}`;
    },
  });

  reg.tool('unban_member', {
    description: 'Remove a ban from a user, allowing them to rejoin the server.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      await guild.bans.remove(userId, args.reason);
      return `Unbanned user ${userId} from ${guild.name}`;
    },
  });

  reg.tool('timeout_member', {
    description:
      'Timeout a member, preventing them from sending messages or joining voice, for a duration in seconds (max 28 days).',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      durationSeconds: z
        .number()
        .int()
        .min(1)
        .max(2419200)
        .describe('Timeout duration in seconds (1-2419200; 2419200 = 28 days)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      const until = new Date(Date.now() + args.durationSeconds * 1000);
      await guild.members.edit(userId, {
        communicationDisabledUntil: until,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return `Timed out user ${userId} for ${args.durationSeconds}s (until ${until.toISOString()})`;
    },
  });

  reg.tool('remove_timeout', {
    description: 'Remove an active timeout from a member before it expires.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      await guild.members.edit(userId, {
        communicationDisabledUntil: null,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return `Removed timeout from user ${userId}`;
    },
  });

  reg.tool('set_nickname', {
    description:
      'Change a member\u2019s nickname on the server. Pass an empty nick (or omit it) to reset to their username.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      nick: z.string().max(32).optional().describe('New nickname (max 32 chars; empty or omitted resets)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      checkNick(args.nick, 'nick');
      const nick = args.nick ?? '';
      await guild.members.edit(userId, {
        nick,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return nick ? `Set nickname of user ${userId} to "${nick}"` : `Reset nickname of user ${userId} to their username`;
    },
  });

  reg.tool('get_bans', {
    description: 'List banned users on the server with their ban reasons.',
    inputSchema: {
      guildId: guildIdParam,
      limit: limitParam(50, 1000),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const bans = await guild.bans.fetch({ limit: args.limit ?? 50 });
      const lines = [...bans.values()]
        .sort((a, b) => a.user.username.localeCompare(b.user.username))
        .map((ban) => `${ban.user.username} (id ${ban.user.id}): ${ban.reason ?? '(no reason)'}`);
      return truncate(lines.join('\n')) || '(no bans)';
    },
  });

  reg.tool('get_member', {
    description:
      'Get a member\u2019s full profile: display name, username, nickname, join/created dates, roles, ' +
      'timeout, avatar URL and voice state.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      const member = await guild.members.fetch(userId);
      const roles = member.roles.cache
        .filter((r) => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => r.name);
      const voice = guild.voiceStates.cache.get(member.id);
      let voiceLine = 'voice: not connected';
      if (voice?.channelId) {
        const flags: string[] = [];
        if (voice.mute) flags.push('muted');
        if (voice.deaf) flags.push('deafened');
        const where = voice.channel ? `#${voice.channel.name}` : `channel ${voice.channelId}`;
        voiceLine = `voice: connected to ${where}${flags.length ? `, ${flags.join(', ')}` : ''}`;
      }
      const lines = [
        formatUserLine({
          id: member.id,
          username: member.user.username,
          displayName: member.displayName,
          bot: member.user.bot,
        }),
        ...(member.nickname ? [`nickname: ${member.nickname}`] : []),
        `joined: ${isoTime(member.joinedTimestamp) || 'unknown'}`,
        `created: ${isoTime(member.user.createdTimestamp) || 'unknown'}`,
        `roles: ${roles.length ? roles.join(', ') : 'none'}`,
        ...(member.communicationDisabledUntil
          ? [`timeout until: ${isoTime(member.communicationDisabledUntil)}`]
          : []),
        `avatar: ${member.displayAvatarURL()}`,
        voiceLine,
      ];
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('search_members', {
    description:
      'Search members by username or display name (REST prefix search; works without the GuildMembers intent).',
    inputSchema: {
      guildId: guildIdParam,
      query: z.string().min(1).describe('Username or display name (or prefix) to search for'),
      limit: limitParam(25, 1000),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const found = await guild.members.search({ query: args.query, limit: args.limit ?? 25 });
      const lines = [...found.values()].map((m) =>
        formatUserLine({
          id: m.id,
          username: m.user.username,
          displayName: m.displayName,
          bot: m.user.bot,
        }),
      );
      return truncate(lines.join('\n')) || `No members matching "${args.query}"`;
    },
  });

  reg.tool('list_members', {
    description:
      'List members of the server, paginated (displayName @username per line). Requires the privileged GuildMembers intent.',
    inputSchema: {
      guildId: guildIdParam,
      limit: limitParam(100, 1000),
      after: snowflakeId('Member ID to start listing after (pagination)').optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      requireMembersIntent(ctx, 'list_members');
      const guild = await fetchGuild(ctx, args.guildId);
      const members = await guild.members.list({
        limit: args.limit ?? 100,
        ...(args.after ? { after: args.after } : {}),
      });
      const lines = [...members.values()].map((m) => `${m.displayName} @${m.user.username} (id ${m.id})`);
      return truncate(lines.join('\n')) || '(no members)';
    },
  });

  reg.tool('edit_member', {
    description:
      'Edit a member: nickname, roles (full replacement), voice mute/deaf/move, or timeout. ' +
      'Provide at least one field; permissions depend on which fields are used. ' +
      'mute/deaf/voiceChannelId only work while the member is connected to voice.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      nick: z.string().max(32).optional().describe('New nickname (empty string resets to username)'),
      roleIds: z
        .array(z.string())
        .optional()
        .describe('Full replacement list of role IDs — the member ends up with exactly these roles'),
      mute: booleanParam('Server-mute (true) or unmute (false); member must be in voice'),
      deaf: booleanParam('Server-deafen (true) or undeafen (false); member must be in voice'),
      voiceChannelId: z
        .string()
        .optional()
        .describe('Voice channel ID to move the member to (empty string disconnects them)'),
      timeoutUntil: z
        .string()
        .optional()
        .describe(
          'Timeout: ISO 8601 timestamp, or a relative duration like "30s", "10m", "2h", "1d", "7d", ' +
            'or "clear"/"none"/"" to remove a timeout',
        ),
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      checkNick(args.nick, 'nick');
      const options: GuildMemberEditOptions = {};
      if (args.nick !== undefined) options.nick = args.nick;
      if (args.roleIds !== undefined) {
        options.roles = (args.roleIds as string[]).map((id, i) => assertSnowflake(`roleIds[${i}]`, id));
      }
      if (args.mute !== undefined) options.mute = args.mute;
      if (args.deaf !== undefined) options.deaf = args.deaf;
      if (args.voiceChannelId !== undefined) {
        options.channel = args.voiceChannelId === '' ? null : assertSnowflake('voiceChannelId', args.voiceChannelId);
      }
      if (args.timeoutUntil !== undefined) {
        options.communicationDisabledUntil = parseTimeoutUntil(args.timeoutUntil);
      }
      const changed = Object.keys(options);
      if (!changed.length) {
        throw new ValidationError(
          'edit_member: provide at least one of nick, roleIds, mute, deaf, voiceChannelId, timeoutUntil',
        );
      }
      if (args.reason !== undefined) options.reason = args.reason;
      await guild.members.edit(userId, options);
      return `Updated member ${userId} (${changed.join(', ')})`;
    },
  });

  reg.tool('bulk_ban', {
    description:
      'Ban up to 200 users at once. Reports how many were banned and which IDs failed. Optionally deletes recent messages.',
    inputSchema: {
      guildId: guildIdParam,
      userIds: z.string().describe('Comma-separated user IDs to ban (1-200)'),
      deleteMessageSeconds: z
        .number()
        .int()
        .min(0)
        .max(604800)
        .optional()
        .describe('Delete the users\u2019 messages from the last N seconds (max 604800 = 7 days; 0 = none)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const ids = parseIdList('userIds', args.userIds);
      if (!ids.length) throw new ValidationError('userIds: required — pass comma-separated user IDs');
      if (ids.length > 200) throw new ValidationError(`userIds: ${ids.length} IDs > 200`);
      const body: { user_ids: string[]; delete_message_seconds?: number } = { user_ids: ids };
      if (args.deleteMessageSeconds !== undefined) body.delete_message_seconds = args.deleteMessageSeconds;
      const result = (await ctx.client.rest.post(`/guilds/${guild.id}/bulk-ban`, {
        body,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      })) as { banned_users?: string[]; failed_users?: string[] };
      const banned = Array.isArray(result.banned_users) ? result.banned_users : [];
      const failed = Array.isArray(result.failed_users) ? result.failed_users : [];
      let out = `Banned ${banned.length} of ${ids.length} users from ${guild.name}`;
      if (failed.length) out += `; ${failed.length} failed: ${failed.join(', ')}`;
      return out;
    },
  });

  reg.tool('get_ban', {
    description: 'Get one user\u2019s ban details (username, ID and reason).',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      const ban = await guild.bans.fetch(userId);
      return `${ban.user.username} (id ${ban.user.id}): ${ban.reason ?? '(no reason)'}`;
    },
  });

  reg.tool('prune_members', {
    description:
      'Prune members who have been inactive for N days. Dry run by default (reports how many would be ' +
      'pruned without removing anyone); pass dryRun: false to actually prune.',
    inputSchema: {
      guildId: guildIdParam,
      days: z.number().int().min(1).max(30).describe('Days of inactivity (1-30)'),
      includeRoleIds: optionalIdListParam('role IDs — only members with at least one of these roles are pruned'),
      dryRun: booleanParam('Report the count without pruning (default true)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const roleIds = parseIdList('includeRoleIds', args.includeRoleIds);
      const dry = args.dryRun ?? true;
      if (dry) {
        const query = new URLSearchParams({ days: String(args.days) });
        if (roleIds.length) query.set('include_roles', roleIds.join(','));
        const result = (await ctx.client.rest.get(`/guilds/${guild.id}/prune`, { query })) as {
          pruned?: number;
        };
        return `${result.pruned ?? 0} members would be pruned (dry run)`;
      }
      const body: { days: number; include_roles?: string[] } = { days: args.days };
      if (roleIds.length) body.include_roles = roleIds;
      const result = (await ctx.client.rest.post(`/guilds/${guild.id}/prune`, {
        body,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      })) as { pruned?: number };
      return `${result.pruned ?? 0} members pruned`;
    },
  });

  reg.tool('set_bot_nickname', {
    description:
      'Change the bot\u2019s own nickname in a server (empty nick resets to the bot username). ' +
      'Requires Manage Nicknames (Discord also lets a bot change its own nickname with Manage Server).',
    inputSchema: {
      guildId: guildIdParam,
      nick: z.string().max(32).describe('New nickname for the bot (max 32 chars; empty string resets)'),
      reason: reasonParam,
    },
    annotations: { destructiveHint: false },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const nick = args.nick ?? '';
      await me.edit({ nick, ...(args.reason !== undefined ? { reason: args.reason } : {}) });
      return nick ? `Set bot nickname to "${nick}"` : 'Reset bot nickname to the bot username';
    },
  });

  return reg.count;
}
