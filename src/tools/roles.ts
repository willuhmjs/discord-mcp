import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Role, RoleEditOptions } from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchGuild, isoTime, requireMembersIntent, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { formatRoleLine, truncate } from '../lib/format.js';
import { guardedFetch, IMAGE_TYPES } from '../lib/fetch.js';
import { parsePermissionBits, parsePermissionNames, permissionNames } from '../lib/permissions.js';
import {
  createRegistrar,
  guildIdParam,
  limitParam,
  reasonParam,
  roleIdParam,
  userIdParam,
} from '../lib/register.js';
import { imageToDataUri, normalizeColor, parseJsonParam } from '../lib/validation.js';

/** Color given as integer or "#RRGGBB" (legacy callers pass integer strings). */
const colorParam = z
  .union([z.string(), z.number()])
  .optional()
  .describe('Color as an integer (e.g. 16711680 for red) or "#RRGGBB"');

/** Booleans that legacy callers pass as "true"/"false" strings. */
const boolishParam = (desc: string) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .describe(`${desc} (true/false)`);

const permissionsParam = z
  .string()
  .optional()
  .describe('Permissions as a bitfield string (e.g. "8") or a CSV of names (e.g. "ManageRoles,KickMembers"; empty = none)');

function parseBoolish(field: string, value: boolean | string | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const s = value.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  throw new ValidationError(`${field}: "${value}" is not true/false`);
}

/** Permissions input: numeric bitfield string, or CSV of permission names. */
function parsePermissionsInput(raw: string, param: string): bigint {
  const t = raw.trim();
  if (!t) return 0n;
  if (/^\d+$/.test(t)) return parsePermissionBits(t, param);
  return parsePermissionNames(t, param);
}

/** Adapt a discord.js Role for formatRoleLine (Role.members is a Collection, not a count). */
function roleLine(r: Role): string {
  return formatRoleLine({
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    managed: r.managed,
  });
}

/** Fetch an http(s) image URL via guardedFetch (or accept a base64 data URI) and return a Discord data URI. */
async function fetchImageUri(url: string, path: string, maxBytes = 512 * 1024): Promise<string> {
  const trimmed = url.trim();
  if (trimmed.startsWith('data:')) return imageToDataUri(trimmed, path);
  const file = await guardedFetch(trimmed, { allowedTypes: IMAGE_TYPES, maxBytes });
  return `data:${file.contentType};base64,${file.data.toString('base64')}`;
}

/**
 * Role tools: legacy list/create/edit/delete/assign/remove plus reorder,
 * member counts, role detail, and role member listing.
 * Returns the number of tools registered.
 */
export function registerRoleTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  async function fetchRole(guildId: string | undefined, roleId: string): Promise<{ role: Role; guildId: string }> {
    const guild = await fetchGuild(ctx, guildId);
    const id = assertSnowflake('roleId', roleId);
    const role = await guild.roles.fetch(id);
    if (!role) throw new ValidationError(`roleId: role ${id} not found in this server`);
    return { role, guildId: guild.id };
  }

  reg.tool('list_roles', {
    description:
      'List all roles on the server with their ID, name, color, and position (highest first). Does not include member counts.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const roles = await guild.roles.fetch();
      const lines = [...roles.values()]
        .sort((a, b) => b.position - a.position)
        .map((r) => roleLine(r));
      return truncate(`${roles.size} roles (highest first):\n${lines.join('\n')}`) || '(no roles)';
    },
  });

  reg.tool('create_role', {
    description: 'Create a new role on the server with the specified parameters.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).max(100).describe('Name of the new role'),
      color: colorParam,
      hoist: boolishParam('Whether the role is displayed separately in the sidebar (default false)'),
      mentionable: boolishParam('Whether the role can be mentioned by everyone (default false)'),
      permissions: permissionsParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const role = await guild.roles.create({
        name: args.name,
        ...(args.color !== undefined ? { color: normalizeColor('color', args.color) } : {}),
        ...(args.hoist !== undefined ? { hoist: parseBoolish('hoist', args.hoist) } : {}),
        ...(args.mentionable !== undefined ? { mentionable: parseBoolish('mentionable', args.mentionable) } : {}),
        ...(args.permissions !== undefined
          ? { permissions: parsePermissionsInput(args.permissions, 'permissions') }
          : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Role created: ${roleLine(role)}`;
    },
  });

  reg.tool('edit_role', {
    description:
      'Update an existing role (name, color, hoist, mentionable, permissions, and optionally icon / unicode emoji ' +
      '/ gradient secondary & tertiary colors). All parameters except guildId and roleId are optional.',
    inputSchema: {
      guildId: guildIdParam,
      roleId: roleIdParam,
      name: z.string().min(1).max(100).optional().describe('New name for the role'),
      color: colorParam,
      hoist: boolishParam('New hoist (display separately) setting'),
      mentionable: boolishParam('New mentionable setting'),
      permissions: permissionsParam,
      reason: reasonParam,
      iconUrl: z
        .string()
        .optional()
        .describe('Image URL (or data URI) for a custom role icon — fetched by the server, max 512KB (boost perk)'),
      unicodeEmoji: z.string().optional().describe('Unicode emoji shown instead of a custom icon (boost perk), e.g. "🎮"'),
      secondaryColor: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Secondary color for role gradient effects as integer or "#RRGGBB" (boost perk)'),
      tertiaryColor: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Tertiary color for role gradient effects as integer or "#RRGGBB" (boost perk)'),
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const roleId = assertSnowflake('roleId', args.roleId);
      const role = await guild.roles.fetch(roleId);
      if (!role) throw new ValidationError(`roleId: role ${roleId} not found in this server`);

      const hasNewField =
        args.iconUrl !== undefined ||
        args.unicodeEmoji !== undefined ||
        args.secondaryColor !== undefined ||
        args.tertiaryColor !== undefined;
      const hasAnyField =
        hasNewField ||
        [args.name, args.color, args.hoist, args.mentionable, args.permissions].some((v) => v !== undefined);
      if (!hasAnyField) throw new ValidationError('edit_role: provide at least one field to change');

      if (hasNewField) {
        // Raw REST so we can set fields discord.js does not wrap (icon data URI, unicode emoji, gradient colors).
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.color !== undefined) body.color = normalizeColor('color', args.color);
        if (args.hoist !== undefined) body.hoist = parseBoolish('hoist', args.hoist);
        if (args.mentionable !== undefined) body.mentionable = parseBoolish('mentionable', args.mentionable);
        if (args.permissions !== undefined) {
          body.permissions = String(parsePermissionsInput(args.permissions, 'permissions'));
        }
        if (args.iconUrl !== undefined) body.icon = await fetchImageUri(args.iconUrl, 'iconUrl');
        if (args.unicodeEmoji !== undefined) body.unicode_emoji = args.unicodeEmoji;
        if (args.secondaryColor !== undefined) {
          body.secondary_color = normalizeColor('secondaryColor', args.secondaryColor);
        }
        if (args.tertiaryColor !== undefined) {
          body.tertiary_color = normalizeColor('tertiaryColor', args.tertiaryColor);
        }
        await ctx.client.rest.patch(`/guilds/${guild.id}/roles/${roleId}`, {
          body,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        const updated = await guild.roles.fetch(roleId);
        return `Role updated: ${updated ? roleLine(updated) : `id ${roleId}`}`;
      }

      const options: RoleEditOptions = {};
      if (args.name !== undefined) options.name = args.name;
      if (args.color !== undefined) options.color = normalizeColor('color', args.color);
      if (args.hoist !== undefined) options.hoist = parseBoolish('hoist', args.hoist);
      if (args.mentionable !== undefined) options.mentionable = parseBoolish('mentionable', args.mentionable);
      if (args.permissions !== undefined) {
        options.permissions = parsePermissionsInput(args.permissions, 'permissions');
      }
      if (args.reason) options.reason = args.reason;
      const updated = await role.edit(options);
      return `Role updated: ${roleLine(updated)}`;
    },
  });

  reg.tool('delete_role', {
    description: 'Permanently delete a role from the server.',
    inputSchema: {
      guildId: guildIdParam,
      roleId: roleIdParam,
      reason: reasonParam,
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const roleId = assertSnowflake('roleId', args.roleId);
      const role = await guild.roles.fetch(roleId);
      if (!role) throw new ValidationError(`roleId: role ${roleId} not found in this server`);
      await guild.roles.delete(roleId, args.reason);
      return `Role @${role.name} (id ${roleId}) deleted`;
    },
  });

  reg.tool('assign_role', {
    description: 'Assign a role to a user.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      roleId: roleIdParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      const roleId = assertSnowflake('roleId', args.roleId);
      const member = await guild.members.fetch(userId);
      await member.roles.add(roleId, args.reason);
      return `Role ${roleId} assigned to ${member.displayName} (id ${member.id})`;
    },
  });

  reg.tool('remove_role', {
    description: 'Remove a role from a user.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      roleId: roleIdParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const userId = assertSnowflake('userId', args.userId);
      const roleId = assertSnowflake('roleId', args.roleId);
      const member = await guild.members.fetch(userId);
      await member.roles.remove(roleId, args.reason);
      return `Role ${roleId} removed from ${member.displayName} (id ${member.id})`;
    },
  });

  reg.tool('reorder_roles', {
    description: 'Reorder roles by position. Provide all roles whose position should change.',
    inputSchema: {
      guildId: guildIdParam,
      positionsJson: z
        .string()
        .describe('JSON array of positions: [{"id":"<role id>","position":1},{"id":"<role id>","position":2}]'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const parsed = parseJsonParam<unknown>('positionsJson', args.positionsJson);
      if (!Array.isArray(parsed) || !parsed.length) {
        throw new ValidationError('positionsJson: must be a non-empty JSON array of {id, position} objects');
      }
      const body = parsed.map((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new ValidationError(`positionsJson[${i}]: must be an object {id, position}`);
        }
        const raw = item as Record<string, unknown>;
        const id = assertSnowflake(`positionsJson[${i}].id`, String(raw.id ?? ''));
        const position = Number(raw.position);
        if (!Number.isInteger(position) || position < 0) {
          throw new ValidationError(`positionsJson[${i}].position: must be a non-negative integer`);
        }
        return { id, position };
      });
      await ctx.client.rest.patch(`/guilds/${guild.id}/roles`, { body, reason: args.reason });
      return `Reordered ${body.length} role${body.length === 1 ? '' : 's'}`;
    },
  });

  reg.tool('get_role_member_counts', {
    description: 'Get the member count for every role on the server (Discord-computed, includes @everyone).',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const raw = await ctx.client.rest.get(`/guilds/${guild.id}/roles/member-counts`);
      const list = Array.isArray(raw) ? (raw as Array<{ id?: unknown; member_count?: unknown }>) : null;
      if (!list) throw new ValidationError('get_role_member_counts: unexpected response from Discord');
      const roles = await guild.roles.fetch().catch(() => null);
      const names = new Map<string, string>();
      if (roles) for (const r of roles.values()) names.set(r.id, r.name);
      const lines = list
        .map((c) => ({ id: String(c.id ?? '?'), count: Number(c.member_count ?? 0) }))
        .sort((a, b) => b.count - a.count)
        .map((c) => `${names.has(c.id) ? `@${names.get(c.id)}` : 'unknown role'} (id ${c.id}): ${c.count} members`);
      return (
        truncate(`${list.length} roles with member counts (largest first):\n${lines.join('\n')}`) ||
        '(no role member counts)'
      );
    },
  });

  reg.tool('get_role', {
    description: 'Get full details for one role: identity line, readable permission names, icon/emoji, and creation date.',
    inputSchema: {
      guildId: guildIdParam,
      roleId: roleIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const { role } = await fetchRole(args.guildId, args.roleId);
      const perms = permissionNames(role.permissions.bitfield);
      const lines = [
        roleLine(role),
        `Mentionable: ${role.mentionable ? 'yes' : 'no'}, hoisted: ${role.hoist ? 'yes' : 'no'}`,
        `Permissions (${perms.length}): ${perms.length ? perms.join(', ') : '(none)'}`,
      ];
      if (role.unicodeEmoji) lines.push(`Emoji: ${role.unicodeEmoji}`);
      if (role.icon) lines.push(`Icon: https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png`);
      lines.push(`Created: ${isoTime(role.createdTimestamp)}`);
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('list_role_members', {
    description:
      'List the members that have a role. Requires the GuildMembers intent (ENABLE_MEMBERS_INTENT=1).',
    inputSchema: {
      guildId: guildIdParam,
      roleId: roleIdParam,
      limit: limitParam(50, 1000),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      requireMembersIntent(ctx, 'list_role_members');
      const guild = await fetchGuild(ctx, args.guildId);
      const roleId = assertSnowflake('roleId', args.roleId);
      const role = await guild.roles.fetch(roleId);
      if (!role) throw new ValidationError(`roleId: role ${roleId} not found in this server`);
      const all = await guild.members.fetch();
      const members = [...all.values()].filter((m) => m.roles.cache.has(roleId));
      const limit = args.limit ?? 50;
      const shown = members.slice(0, limit).map((m) => `${m.displayName} (id ${m.id})`);
      const extra = members.length > limit ? `\n…(${members.length - limit} more)` : '';
      return (
        truncate(`${members.length} member${members.length === 1 ? '' : 's'} with @${role.name}:\n${shown.join('\n')}${extra}`) ||
        `(nobody has @${role.name})`
      );
    },
  });

  return reg.count;
}

