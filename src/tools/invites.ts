import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Invite, InviteCreateOptions } from 'discord.js';
import { z } from 'zod';
import { fetchChannel, fetchGuild, isoTime, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { truncate } from '../lib/format.js';
import {
  booleanParam,
  channelIdParam,
  createRegistrar,
  guildIdParam,
  reasonParam,
  userIdParam,
} from '../lib/register.js';

interface RawInvite {
  code?: string;
  uses?: number;
  [k: string]: unknown;
}

interface RawInviteDetail {
  code: string;
  guild?: { id: string; name: string; description?: string | null } | null;
  channel?: { id: string; name: string; type: number } | null;
  inviter?: { id: string; username: string; global_name?: string | null } | null;
  uses?: number;
  max_uses?: number;
  temporary?: boolean;
  expires_at?: string | null;
  approximate_member_count?: number;
  approximate_presence_count?: number;
  target_type?: number | null;
  target_user?: { id: string; username: string } | null;
  target_application?: { id: string; name: string } | null;
  guild_scheduled_event?: { id: string; name: string } | null;
}

/**
 * Accept either a bare invite code ("ABCde") or any invite URL
 * (https://discord.gg/ABCde, discord.com/invite/ABCde, ...) and return the code.
 */
function extractInviteCode(input: string): string {
  let v = String(input ?? '').trim();
  if (!v) throw new ValidationError('inviteCode: required');
  v = v.split(/[?#]/, 1)[0]!.replace(/\/+$/, '');
  if (v.includes('/')) v = v.slice(v.lastIndexOf('/') + 1);
  if (!/^[\w-]+$/.test(v)) {
    throw new ValidationError(
      'inviteCode: must be an invite code like "ABCde" or a URL like "https://discord.gg/ABCde"',
    );
  }
  return v;
}

/**
 * Invite tools (create/list/delete/get details).
 * Returns the number of tools registered.
 */
export function registerInviteTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('create_invite', {
    description: 'Create a new invite link for a specific channel. Requires Create Instant Invite.',
    inputSchema: {
      guildId: guildIdParam,
      channelId: channelIdParam,
      maxAge: z
        .number()
        .int()
        .min(0)
        .max(604800)
        .optional()
        .describe('Duration in seconds before expiry (0 = never, default 86400 = 24h)'),
      maxUses: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Max number of uses (0 = unlimited, default 0)'),
      temporary: booleanParam(
        'Whether members get temporary membership (kicked when disconnected unless role assigned)',
      ),
      unique: booleanParam('Force creation of a new unique invite code'),
      targetType: z
        .number()
        .int()
        .refine((v) => v === 1 || v === 2, 'targetType: must be 1 (stream) or 2 (embedded application)')
        .optional()
        .describe('Target type: 1 = stream (needs targetUserId), 2 = embedded application'),
      targetUserId: userIdParam
        .optional()
        .describe('User ID whose stream to target (targetType 1)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchChannel(ctx, args.channelId);
      const createInvite = (channel as unknown as {
        createInvite?: (options: InviteCreateOptions) => Promise<Invite>;
      }).createInvite;
      if (typeof createInvite !== 'function') {
        throw new ValidationError(
          'channelId: invites cannot be created for this channel type ' +
            '(use a text, voice, stage, announcement or forum channel)',
        );
      }
      const invite = await createInvite({
        maxAge: args.maxAge ?? 86400,
        maxUses: args.maxUses ?? 0,
        temporary: args.temporary,
        unique: args.unique,
        ...(args.targetType !== undefined ? { targetType: args.targetType } : {}),
        ...(args.targetUserId !== undefined ? { targetUser: args.targetUserId } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      const expiry = invite.expiresTimestamp
        ? `, expires ${isoTime(invite.expiresTimestamp)}`
        : ', never expires';
      return `Invite created: https://discord.gg/${invite.code} (code ${invite.code}${expiry})`;
    },
  });

  reg.tool('list_invites', {
    description: 'List all active invites on the server with their statistics. Requires Manage Guild.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const invites = await guild.invites.fetch();
      if (!invites.size) return 'No active invites.';
      const lines = [...invites.values()].map((inv) => {
        const target = inv.channel ? `→ #${inv.channel.name}` : '→ ?';
        const uses = inv.maxUses ? `${inv.uses ?? 0}/${inv.maxUses} uses` : `${inv.uses ?? 0} uses`;
        const expires = inv.expiresTimestamp ? `expires ${isoTime(inv.expiresTimestamp)}` : 'never expires';
        const by = inv.inviter ? `by @${inv.inviter.username}` : 'by unknown';
        return `${inv.code} (${target}): ${uses}, ${expires}, ${by}`;
      });
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('delete_invite', {
    description: 'Delete (revoke) an invite so the link stops working. Requires Manage Guild.',
    inputSchema: {
      inviteCode: z
        .string()
        .describe('Invite code or full URL (e.g. \'ABCde\' or \'https://discord.gg/ABCde\')'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const code = extractInviteCode(args.inviteCode);
      const deleted = (await ctx.client.rest.delete(`/invites/${code}`, {
        reason: args.reason,
      })) as RawInvite | null;
      const uses = deleted?.uses !== undefined ? ` (had been used ${deleted.uses} times)` : '';
      return `Invite ${code} deleted${uses}`;
    },
  });

  reg.tool('get_invite_details', {
    description: 'Get details about a specific invite (works for any public invite).',
    inputSchema: {
      inviteCode: z
        .string()
        .describe('Invite code or full URL (e.g. \'ABCde\' or \'https://discord.gg/ABCde\')'),
      withCounts: booleanParam('Whether to include approximate member counts (default true)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const code = extractInviteCode(args.inviteCode);
      const withCounts = args.withCounts ?? true;
      const detail = (await ctx.client.rest.get(
        `/invites/${code}?with_counts=${withCounts}&with_expires=true`,
      )) as RawInviteDetail;
      const lines: string[] = [`Invite ${detail.code} (https://discord.gg/${detail.code})`];
      if (detail.guild) {
        lines.push(`server: ${detail.guild.name} (id ${detail.guild.id})`);
      } else {
        lines.push('server: (none — group DM invite)');
      }
      if (detail.channel) lines.push(`channel: #${detail.channel.name} (id ${detail.channel.id})`);
      if (detail.inviter) lines.push(`inviter: @${detail.inviter.username} (id ${detail.inviter.id})`);
      if (detail.uses !== undefined && detail.uses !== null) {
        const max = detail.max_uses ? `/${detail.max_uses}` : ' (unlimited)';
        lines.push(`uses: ${detail.uses}${max}`);
      }
      lines.push(`expires: ${detail.expires_at ?? 'never'}`);
      if (detail.temporary) lines.push('grants temporary membership');
      if (detail.approximate_member_count !== undefined && detail.approximate_member_count !== null) {
        lines.push(
          `members: ~${detail.approximate_member_count} (~${detail.approximate_presence_count ?? 0} online)`,
        );
      }
      if (detail.target_type === 1 && detail.target_user) {
        lines.push(`target stream: @${detail.target_user.username} (id ${detail.target_user.id})`);
      }
      if (detail.target_type === 2 && detail.target_application) {
        lines.push(`target application: ${detail.target_application.name} (id ${detail.target_application.id})`);
      }
      if (detail.guild_scheduled_event) {
        lines.push(`for event: ${detail.guild_scheduled_event.name} (id ${detail.guild_scheduled_event.id})`);
      }
      return truncate(lines.join('\n'));
    },
  });

  return reg.count;
}
