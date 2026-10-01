import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ActionRow,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuComponent,
  StringSelectMenuOptionBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type Guild,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type Role,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { z } from 'zod';
import {
  assertSnowflake,
  fetchSendableChannel,
  isoTime,
  parseIdList,
  type ToolContext,
} from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { truncate } from '../lib/format.js';
import { assertRoleToggleable } from '../lib/permissions.js';
import { channelIdParam, createRegistrar, jsonParam } from '../lib/register.js';
import { normalizeColor, parseJsonParam } from '../lib/validation.js';

/**
 * Interactions area: built-in handling for component interactions whose custom_id
 * uses the `mcp:` prefix (stateless — the behaviour is encoded in the id itself,
 * so menus survive restarts with no storage):
 *   mcp:role:<roleId>  button that toggles one role on the clicker
 *   mcp:roleselect     string select whose option values are role IDs
 *                      (selected roles are added, deselected menu roles removed)
 *   mcp:reply:<base64> ephemeral canned reply (decoded text, max 80 chars)
 * Anything else is acknowledged (deferUpdate) and recorded, so the LLM can see
 * who clicked what via list_interactions.
 */

const ROLE_PREFIX = 'mcp:role:';
const ROLESELECT_ID = 'mcp:roleselect';
const REPLY_PREFIX = 'mcp:reply:';
const DEFAULT_MENU_COLOR = 0x5865f2;

/** Interactions this server handles: buttons, selects and modal submits. */
type HandledInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

/** Emoji object accepted by ButtonBuilder/StringSelectMenuOptionBuilder setEmoji. */
interface MenuEmoji {
  name: string;
  id?: string;
  animated?: boolean;
}

/** One role-menu entry, from the `roles` JSON array or the `roleIds` CSV. */
interface MenuEntry {
  roleId: string;
  label?: string;
  emoji?: string;
  description?: string;
}

interface CreateRoleMenuArgs {
  channelId: string;
  roles?: string;
  roleIds?: string;
  style?: 'buttons' | 'select';
  title?: string;
  description?: string;
  embedColor?: string;
}

interface ListInteractionsArgs {
  channelId?: string;
  sinceMinutes?: number;
}

// ---------------------------------------------------------------------------
// interactionCreate handler
// ---------------------------------------------------------------------------

/** Attach the built-in interaction handler (mcp: buttons/selects + recording). */
export function setupInteractions(ctx: ToolContext): void {
  ctx.client.on('interactionCreate', async (interaction) => {
    // Only buttons, select menus and modal submits; everything else is not ours.
    if (!(interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit())) {
      return;
    }
    const handled = interaction as HandledInteraction;
    const messageId = (handled as unknown as { message?: { id?: string } | null }).message?.id;
    let outcome = '';
    try {
      outcome = await routeInteraction(ctx, handled);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort ack so the clicker is not left with a failed interaction.
      try {
        if (handled.replied || handled.deferred) {
          await handled.followUp({
            content: 'Something went wrong handling that click.',
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await handled.reply({
            content: 'Something went wrong handling that click.',
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // Already failed once; nothing more we can do within the ack window.
      }
      outcome = `error: ${message}`;
    }
    ctx.interactions.add({
      id: handled.id,
      at: Date.now(),
      type: handled.isButton() ? 'button' : handled.isAnySelectMenu() ? 'select_menu' : 'modal',
      customId: handled.customId,
      userId: handled.user.id,
      userTag: handled.user.tag,
      channelId: handled.channelId ?? '',
      guildId: handled.guildId ?? '',
      messageId,
      values: handled.isAnySelectMenu() ? [...handled.values] : undefined,
      outcome,
    });
  });
}

/** Route one handled interaction by its custom_id. Returns the outcome for the log. */
async function routeInteraction(ctx: ToolContext, interaction: HandledInteraction): Promise<string> {
  const customId = interaction.customId;
  if (customId.startsWith(ROLE_PREFIX)) {
    return handleRoleToggle(ctx, interaction, customId.slice(ROLE_PREFIX.length));
  }
  if (customId.startsWith(REPLY_PREFIX)) {
    return handleReplyButton(interaction, customId.slice(REPLY_PREFIX.length));
  }
  if (customId === ROLESELECT_ID && interaction.isStringSelectMenu()) {
    return handleRoleSelect(ctx, interaction);
  }
  if (interaction.isButton() || interaction.isAnySelectMenu()) {
    await interaction.deferUpdate();
    return 'deferred (unknown custom id)';
  }
  // Unknown modal submit (this server never shows modals) — just record it.
  return 'recorded (modal)';
}

/** mcp:role:<roleId> — toggle one role on the clicker, then confirm ephemerally. */
async function handleRoleToggle(
  ctx: ToolContext,
  interaction: HandledInteraction,
  roleIdRaw: string,
): Promise<string> {
  let roleId: string;
  try {
    roleId = assertSnowflake('roleId', roleIdRaw);
  } catch {
    await interaction.reply({ content: 'Invalid role menu button.', flags: MessageFlags.Ephemeral });
    return 'error';
  }
  if (!interaction.inGuild() || !interaction.member) {
    await interaction.reply({
      content: 'Role menu buttons only work in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return 'refused';
  }
  const guild = interaction.guild ?? (await ctx.client.guilds.fetch(interaction.guildId));
  let role: Role | null = null;
  try {
    role = await guild.roles.fetch(roleId);
  } catch {
    role = null;
  }
  if (!role) {
    await interaction.reply({ content: 'That role no longer exists.', flags: MessageFlags.Ephemeral });
    return 'refused';
  }
  try {
    assertRoleToggleable(role, guild.members.me?.roles.highest);
  } catch (err) {
    await interaction.reply({
      content: `This role can't be self-assigned: ${(err as Error).message}`,
      flags: MessageFlags.Ephemeral,
    });
    return 'refused';
  }
  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : await guild.members.fetch(interaction.user.id);
  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId);
    await interaction.reply({
      content: `Removed role @${role.name}`,
      flags: MessageFlags.Ephemeral,
    });
    return `toggled role @${role.name} (removed)`;
  }
  await member.roles.add(roleId);
  await interaction.reply({ content: `Added role @${role.name}`, flags: MessageFlags.Ephemeral });
  return `toggled role @${role.name} (added)`;
}

/** mcp:roleselect — add selected roles, remove deselected menu roles. */
async function handleRoleSelect(
  ctx: ToolContext,
  interaction: StringSelectMenuInteraction,
): Promise<string> {
  if (!interaction.inGuild() || !interaction.member) {
    await interaction.reply({
      content: 'Role menus only work in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return 'refused';
  }
  const guild = interaction.guild ?? (await ctx.client.guilds.fetch(interaction.guildId));
  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : await guild.members.fetch(interaction.user.id);

  const selected = [...interaction.values];
  const menuRoleIds = collectRoleSelectOptions(interaction);
  const toAdd = selected.filter((id) => !member.roles.cache.has(id));
  const toRemove = menuRoleIds.filter((id) => !selected.includes(id) && member.roles.cache.has(id));

  // Validate every affected role before mutating anything (no partial changes).
  const botTopRole = guild.members.me?.roles.highest;
  const roleNames = new Map<string, string>();
  for (const id of new Set([...toAdd, ...toRemove])) {
    let role: Role | null = guild.roles.cache.get(id) ?? null;
    if (!role) {
      try {
        role = await guild.roles.fetch(id);
      } catch {
        role = null;
      }
    }
    if (!role) {
      await interaction.reply({
        content: `A role in this menu (id ${id}) no longer exists.`,
        flags: MessageFlags.Ephemeral,
      });
      return 'refused';
    }
    try {
      assertRoleToggleable(role, botTopRole);
    } catch (err) {
      await interaction.reply({
        content: `This role can't be self-assigned: ${(err as Error).message}`,
        flags: MessageFlags.Ephemeral,
      });
      return 'refused';
    }
    roleNames.set(id, role.name);
  }

  if (toAdd.length) await member.roles.add(toAdd);
  if (toRemove.length) await member.roles.remove(toRemove);

  const parts: string[] = [];
  if (toAdd.length) {
    parts.push(`Added: ${toAdd.map((id) => `@${roleNames.get(id) ?? id}`).join(', ')}.`);
  }
  if (toRemove.length) {
    parts.push(`Removed: ${toRemove.map((id) => `@${roleNames.get(id) ?? id}`).join(', ')}.`);
  }
  const summary = parts.join(' ') || 'No changes.';
  await interaction.reply({ content: summary, flags: MessageFlags.Ephemeral });
  return summary;
}

/** Read the menu's own option values from the message components (stateless source of truth). */
function collectRoleSelectOptions(interaction: StringSelectMenuInteraction): string[] {
  const values: string[] = [];
  for (const row of interaction.message.components) {
    if (!(row instanceof ActionRow)) continue;
    for (const component of row.components) {
      if (component instanceof StringSelectMenuComponent && component.customId === ROLESELECT_ID) {
        values.push(...component.options.map((option) => String(option.value)));
      }
    }
  }
  return values;
}

/** mcp:reply:<base64> — ephemeral canned reply. */
async function handleReplyButton(
  interaction: HandledInteraction,
  base64: string,
): Promise<string> {
  const text = Buffer.from(base64, 'base64').toString('utf8');
  if (!text.trim() || text.length > 80) {
    await interaction.reply({ content: 'Invalid reply button.', flags: MessageFlags.Ephemeral });
    return 'error';
  }
  await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  return 'replied';
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Interaction tools (create_role_menu, list_interactions).
 * Returns the number of tools registered.
 */
export function registerInteractionTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('create_role_menu', {
    description:
      'Post a self-service role menu (reaction-role style) to a channel, as buttons or a select menu. ' +
      'Every role is validated up front (not managed, no dangerous permissions, below the bot\u2019s top role). ' +
      'Clicks are handled automatically afterwards: a button toggles that role; the select adds selected roles ' +
      'and removes deselected ones. Confirmation is always ephemeral.',
    inputSchema: {
      channelId: channelIdParam,
      roles: jsonParam(
        'Roles',
        'JSON array [{roleId, label, emoji?, description?}] — 1 to 25 entries',
      ),
      roleIds: z
        .string()
        .optional()
        .describe(
          'Comma-separated role IDs — alternative to `roles` (labels default to the role names); ' +
            'kept as a plain string so permission scanners can check it',
        ),
      style: z
        .enum(['buttons', 'select'])
        .optional()
        .describe("Menu style: 'buttons' (default, up to 25 buttons) or 'select' (one select menu)"),
      title: z.string().optional().describe('Embed title (default "Pick your roles")'),
      description: z
        .string()
        .optional()
        .describe('Embed description (default "Click a button to toggle a role.")'),
      embedColor: z
        .string()
        .optional()
        .describe('Embed color as an integer or #RRGGBB (default #5865f2)'),
    },
    handler: async (args: CreateRoleMenuArgs) => {
      const entries = mergeMenuEntries(
        parseRolesJson(args.roles),
        parseIdList('roleIds', args.roleIds),
      );
      if (!entries.length) {
        throw new ValidationError(
          'roles: provide `roles` (JSON array) or `roleIds` (comma-separated role IDs) with at least 1 role',
        );
      }
      if (entries.length > 25) {
        throw new ValidationError(
          `roles: ${entries.length} entries > 25 (Discord caps a message at 25 buttons / select options)`,
        );
      }

      // The channel decides the guild (never DISCORD_GUILD_ID — a role menu in
      // the wrong server's channel would toggle the wrong server's roles).
      const channel = await fetchSendableChannel(ctx, args.channelId);
      const guild = (channel as unknown as { guild?: Guild }).guild;
      if (!guild) {
        throw new ValidationError(
          'channelId: role menus must be posted in a server channel (DM channels have no roles)',
        );
      }

      const botTopRole = guild.members.me?.roles.highest;
      const roles = new Map<string, Role>();
      for (const entry of entries) {
        let role: Role | null = null;
        try {
          role = await guild.roles.fetch(entry.roleId);
        } catch {
          role = null;
        }
        if (!role) {
          throw new ValidationError(`roles: role ${entry.roleId} does not exist in this server`);
        }
        try {
          assertRoleToggleable(role, botTopRole);
        } catch (err) {
          // Refuse the whole menu; the message names the offending role.
          throw new ValidationError(`roles: ${(err as Error).message}`);
        }
        roles.set(entry.roleId, role);
      }

      const title = args.title?.trim() || 'Pick your roles';
      if (title.length > 256) throw new ValidationError(`title: ${title.length} chars > 256`);
      const description = args.description?.trim() || 'Click a button to toggle a role.';
      if (description.length > 4096) {
        throw new ValidationError(`description: ${description.length} chars > 4096`);
      }
      const embedColor = parseEmbedColor('embedColor', args.embedColor) ?? DEFAULT_MENU_COLOR;

      const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(embedColor);
      const components =
        args.style === 'select'
          ? [buildSelectRow(entries, roles)]
          : buildButtonRows(entries, roles);

      const sent = await channel.send({ embeds: [embed], components });
      const url = sent.url ?? `https://discord.com/channels/${guild.id}/${channel.id}/${sent.id}`;
      return `Role menu posted (message id ${sent.id}): ${url}`;
    },
  });

  reg.tool('list_interactions', {
    description:
      'List recently handled button/select/modal interactions: who clicked what, the custom_id, ' +
      'select values and the outcome (e.g. toggled role, refused, deferred). Useful for seeing how a role menu is being used.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      channelId: channelIdParam.optional().describe(
        'Discord channel ID (optional; only interactions from this channel)',
      ),
      sinceMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe('Look-back window in minutes (default 30, max 1440)'),
    },
    handler: async (args: ListInteractionsArgs) => {
      const minutes = args.sinceMinutes ?? 30;
      const channelId = args.channelId ? assertSnowflake('channelId', args.channelId) : undefined;
      const records = ctx.interactions.list({
        ...(channelId ? { channelId } : {}),
        sinceMs: minutes * 60_000,
      });
      if (!records.length) {
        return `No interactions recorded in the last ${minutes} minutes.`;
      }
      const lines = records.map(
        (r) =>
          `[${isoTime(r.at)}] @${r.userTag} (id ${r.userId}) ${r.type} custom_id "${r.customId}" → ${r.outcome}`,
      );
      return truncate(lines.join('\n'));
    },
  });

  return reg.count;
}

// ---------------------------------------------------------------------------
// create_role_menu helpers
// ---------------------------------------------------------------------------

/** Parse the `roles` JSON array param. Returns [] when the param is absent. */
function parseRolesJson(raw: string | undefined): MenuEntry[] {
  const parsed = parseJsonParam<unknown>('roles', raw);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new ValidationError('roles: must be a JSON array of {roleId, label, emoji?, description?}');
  }
  return parsed.map((item, i): MenuEntry => {
    const here = `roles[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError(`${here}: must be an object {roleId, label, emoji?, description?}`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.roleId !== 'string' && typeof obj.roleId !== 'number') {
      throw new ValidationError(`${here}.roleId: required (Discord role ID)`);
    }
    const roleId = assertSnowflake(`${here}.roleId`, String(obj.roleId));
    const label = stringField(obj.label, `${here}.label`);
    const emoji = stringField(obj.emoji, `${here}.emoji`);
    const description = stringField(obj.description, `${here}.description`);
    return {
      roleId,
      ...(label !== undefined ? { label } : {}),
      ...(emoji !== undefined ? { emoji } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  });
}

/** Optional string/number field; empty/whitespace-only counts as absent. */
function stringField(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${path}: must be a string`);
  }
  const s = String(value);
  return s.trim() ? s : undefined;
}

/** Merge JSON entries with CSV IDs, deduping by roleId (first occurrence wins). */
function mergeMenuEntries(jsonEntries: MenuEntry[], csvIds: string[]): MenuEntry[] {
  const byId = new Map<string, MenuEntry>();
  for (const entry of jsonEntries) {
    if (!byId.has(entry.roleId)) byId.set(entry.roleId, entry);
  }
  for (const roleId of csvIds) {
    if (!byId.has(roleId)) byId.set(roleId, { roleId }); // label defaults to the role name
  }
  return [...byId.values()];
}

/** Embed color param: integer (decimal digits) or #RRGGBB, via normalizeColor. */
function parseEmbedColor(path: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return normalizeColor(path, Number(value));
  return normalizeColor(path, value);
}

/**
 * Parse an emoji string into a component emoji object:
 * unicode emoji → {name}; "name:id" / "<:name:id>" / "<a:name:id>" → {name, id, animated?};
 * bare digits (custom emoji ID) → {name: '', id}.
 */
function parseMenuEmoji(emoji: string): MenuEmoji {
  const s = emoji.trim();
  if (/^\d{15,21}$/.test(s)) return { name: '', id: s };
  const wrapped = s.match(/^<(a?):([^:\s]+):(\d{15,21})>$/);
  if (wrapped) {
    return {
      name: wrapped[2] as string,
      id: wrapped[3] as string,
      ...(wrapped[1] ? { animated: true } : {}),
    };
  }
  const bare = s.match(/^([^:\s]+):(\d{15,21})$/);
  if (bare) return { name: bare[1] as string, id: bare[2] as string };
  return { name: s };
}

/** Buttons: one ButtonBuilder per role (custom id mcp:role:<id>), 5 per action row. */
function buildButtonRows(entries: MenuEntry[], roles: Map<string, Role>): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = entries.map((entry) => {
    const label = (entry.label?.trim() || (roles.get(entry.roleId) as Role).name).slice(0, 80);
    const button = new ButtonBuilder()
      .setCustomId(`${ROLE_PREFIX}${entry.roleId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary);
    if (entry.emoji !== undefined) button.setEmoji(parseMenuEmoji(entry.emoji));
    return button;
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

/** Select: a single row holding one mcp:roleselect string select menu. */
function buildSelectRow(
  entries: MenuEntry[],
  roles: Map<string, Role>,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder().setCustomId(ROLESELECT_ID);
  for (const entry of entries) {
    const label = (entry.label?.trim() || (roles.get(entry.roleId) as Role).name).slice(0, 100);
    const option = new StringSelectMenuOptionBuilder().setLabel(label).setValue(entry.roleId);
    const description = entry.description?.trim();
    if (description) option.setDescription(description.slice(0, 100));
    if (entry.emoji !== undefined) option.setEmoji(parseMenuEmoji(entry.emoji));
    menu.addOptions(option);
  }
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}
