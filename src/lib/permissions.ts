import { PermissionsBitField, type Role } from 'discord.js';
import { ValidationError } from './errors.js';

/** Permissions that disqualify a role from self-service toggling via role menus. */
export const DANGEROUS_PERMISSIONS: string[] = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'BanMembers',
  'KickMembers',
  'ManageWebhooks',
  'MentionEveryone',
  'ModerateMembers',
];

const FLAGS = PermissionsBitField.Flags as Record<string, bigint>;

const DANGEROUS_FLAGS: bigint[] = DANGEROUS_PERMISSIONS.map((n) => FLAGS[n]).filter((b) => b !== undefined);

// Lookup accepting "ManageRoles", "MANAGE_ROLES", "manage_roles".
const NAME_TO_FLAG = new Map<string, bigint>();
for (const [name, bit] of Object.entries(FLAGS)) {
  NAME_TO_FLAG.set(name, bit);
  NAME_TO_FLAG.set(name.toUpperCase(), bit);
  NAME_TO_FLAG.set(name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase(), bit);
}

/** Parse a CSV of permission names ("VIEW_CHANNEL,MESSAGE_SEND") to a bitfield. */
export function parsePermissionNames(csv: string, param: string): bigint {
  let bits = 0n;
  for (const part of csv.split(',').map((s) => s.trim()).filter(Boolean)) {
    const bit = NAME_TO_FLAG.get(part) ?? NAME_TO_FLAG.get(part.toUpperCase());
    if (bit === undefined) {
      throw new ValidationError(
        `${param}: unknown permission "${part}". Use Discord names like ViewChannel, SendMessages, ` +
          `ManageMessages (or VIEW_CHANNEL, MESSAGE_SEND).`,
      );
    }
    bits |= bit;
  }
  return bits;
}

/** Parse a raw permission bitfield given as a (possibly very large) numeric string. */
export function parsePermissionBits(raw: string, param: string): bigint {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new ValidationError(`${param}: "${raw}" is not a numeric bitfield`);
  try {
    return BigInt(trimmed);
  } catch {
    throw new ValidationError(`${param}: "${raw}" is not a valid bitfield`);
  }
}

/** Render a bitfield as readable permission names. */
export function permissionNames(bits: bigint): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(FLAGS)) {
    if ((bits & bit) === bit) names.push(name);
  }
  return names;
}

/** True when the role has any of the dangerous permissions. */
export function isDangerousRole(role: Role): boolean {
  return role.permissions.has(DANGEROUS_FLAGS);
}

/**
 * Assert a role can be safely assigned/removed through the bot:
 * not managed, not dangerously powerful, and below the bot's top role.
 * Used at menu-creation time and again at click time.
 */
export function assertRoleToggleable(role: Role, botTopRole: Role | null | undefined): void {
  if (role.managed) {
    throw new ValidationError(
      `role @${role.name} is managed by an integration or is the bot's own role — it cannot be assigned by menu`,
    );
  }
  if (isDangerousRole(role)) {
    const dangerous = permissionNames(role.permissions.bitfield).filter((n) =>
      DANGEROUS_PERMISSIONS.includes(n),
    );
    throw new ValidationError(
      `role @${role.name} has dangerous permissions (${dangerous.join(', ')}) — not allowed in role menus`,
    );
  }
  if (botTopRole && role.position >= botTopRole.position) {
    throw new ValidationError(
      `role @${role.name} is at or above the bot's highest role (@${botTopRole.name}) — move the bot role up`,
    );
  }
}
