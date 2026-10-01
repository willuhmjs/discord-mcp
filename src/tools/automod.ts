import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertSnowflake, fetchGuild, parseIdList, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { truncate } from '../lib/format.js';
import {
  booleanParam,
  createRegistrar,
  guildIdParam,
  jsonParam,
  optionalIdListParam,
  reasonParam,
  snowflakeId,
} from '../lib/register.js';
import { parseJsonParam } from '../lib/validation.js';

// ---------------------------------------------------------------------------
// Raw REST shapes — discord.js 14 has no AutoMod manager, so every call goes
// through /guilds/{guild.id}/auto-moderation/rules. Requires Manage Guild.
// ---------------------------------------------------------------------------

interface RawAutoModAction {
  type: number;
  metadata?: {
    channel_id?: string;
    duration_seconds?: number;
    custom_message?: string;
  } | null;
}

interface RawTriggerMetadata {
  keyword_filter?: string[] | null;
  regex_patterns?: string[] | null;
  presets?: number[] | null;
  allow_list?: string[] | null;
  mention_total_limit?: number | null;
  mention_raid_protection_enabled?: boolean | null;
}

interface RawAutoModRule {
  id: string;
  name: string;
  event_type?: number;
  trigger_type: number;
  trigger_metadata?: RawTriggerMetadata | null;
  actions?: RawAutoModAction[];
  enabled?: boolean;
  exempt_roles?: string[];
  exempt_channels?: string[];
  creator_id?: string;
}

const TRIGGER_TYPE_NAMES: Record<number, string> = {
  1: 'keyword',
  3: 'spam',
  4: 'preset',
  5: 'mention spam',
  6: 'member profile',
};

const PRESET_IDS: Record<string, number> = {
  profanity: 1,
  sexual_content: 2,
  slurs: 3,
};

const PRESET_NAMES: Record<number, string> = {
  1: 'profanity',
  2: 'sexual_content',
  3: 'slurs',
};

const triggerTypeParam = z
  .number()
  .int()
  .refine(
    (v) => v === 1 || v === 3 || v === 4 || v === 5 || v === 6,
    'triggerType: must be 1 (keyword), 3 (spam), 4 (preset), 5 (mention spam) or 6 (member profile)',
  )
  .describe('Trigger type: 1=keyword, 3=spam, 4=preset, 5=mention spam, 6=member profile');

const triggerFieldsShape = {
  keywords: z
    .string()
    .optional()
    .describe('Comma-separated keywords to block (triggerType 1)'),
  regexPatterns: z
    .string()
    .optional()
    .describe('Comma-separated regex patterns to block (triggerType 1)'),
  allowList: z
    .string()
    .optional()
    .describe('Comma-separated words exempt from the rule (triggerType 1)'),
  presets: z
    .string()
    .optional()
    .describe('Comma-separated content presets: profanity, sexual_content, slurs (triggerType 4 only)'),
  mentionTotalLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Max unique mentions per message, 1-50 (triggerType 5 only)'),
  mentionRaidProtectionEnabled: booleanParam(
    'Auto-timeout new members who spam mentions in their first message (triggerType 5)',
  ),
};

interface TriggerParams {
  keywords?: string;
  regexPatterns?: string;
  allowList?: string;
  presets?: string;
  mentionTotalLimit?: number;
  mentionRaidProtectionEnabled?: boolean;
}

/** Split a comma-separated parameter into non-empty trimmed values. */
function csvValues(name: string, value: string): string[] {
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new ValidationError(`${name}: no non-empty values in "${value}"`);
  return parts;
}

interface ActionInput {
  type?: unknown;
  customMessage?: unknown;
  channelId?: unknown;
  durationSeconds?: unknown;
  [k: string]: unknown;
}

/**
 * Parse actionsJson — a JSON array of {type, ...} — into Discord action objects:
 * {type: 1, customMessage?} | {type: 2, channelId} | {type: 3, durationSeconds} | {type: 4}.
 */
function parseActions(name: string, value: string): unknown[] {
  const parsed = parseJsonParam<ActionInput[]>(name, value);
  if (parsed === undefined) throw new ValidationError(`${name}: required`);
  if (!Array.isArray(parsed)) throw new ValidationError(`${name}: must be a JSON array of action objects`);
  if (!parsed.length) throw new ValidationError(`${name}: at least one action is required`);
  return parsed.map((raw, i) => {
    const here = `${name}[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError(`${here}: must be an object`);
    }
    const type = raw.type;
    if (typeof type !== 'number' || !Number.isInteger(type) || type < 1 || type > 4) {
      throw new ValidationError(
        `${here}.type: must be 1 (block_message), 2 (send_alert), 3 (timeout) or 4 (block_member_interaction)`,
      );
    }
    if (type === 1) {
      const metadata: { custom_message?: string } = {};
      if (raw.customMessage !== undefined && raw.customMessage !== null) {
        if (typeof raw.customMessage !== 'string') {
          throw new ValidationError(`${here}.customMessage: must be a string`);
        }
        if (raw.customMessage.length > 150) {
          throw new ValidationError(`${here}.customMessage: ${raw.customMessage.length} chars > 150`);
        }
        metadata.custom_message = raw.customMessage;
      }
      return { type, metadata };
    }
    if (type === 2) {
      if (raw.channelId === undefined || raw.channelId === null || raw.channelId === '') {
        throw new ValidationError(`${here}.channelId: required for send_alert actions (type 2)`);
      }
      const channelId = assertSnowflake(`${here}.channelId`, String(raw.channelId));
      return { type, metadata: { channel_id: channelId } };
    }
    if (type === 3) {
      const dur = raw.durationSeconds;
      if (
        typeof dur !== 'number' ||
        !Number.isInteger(dur) ||
        dur < 1 ||
        dur > 2419200
      ) {
        throw new ValidationError(
          `${here}.durationSeconds: timeout actions need whole seconds between 1 and 2419200 (28 days)`,
        );
      }
      return { type, metadata: { duration_seconds: dur } };
    }
    return { type: 4, metadata: {} };
  });
}

/**
 * Build trigger_metadata from the keyword/regex/preset/mention params.
 * Only provided fields are included (edit semantics); cross-field checks run
 * when the trigger type is known in this call, otherwise Discord validates.
 */
function buildTriggerMetadata(p: TriggerParams, triggerType?: number): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (p.keywords !== undefined && p.keywords.trim() !== '') {
    meta.keyword_filter = csvValues('keywords', p.keywords);
  }
  if (p.regexPatterns !== undefined && p.regexPatterns.trim() !== '') {
    meta.regex_patterns = csvValues('regexPatterns', p.regexPatterns);
  }
  if (p.allowList !== undefined && p.allowList.trim() !== '') {
    meta.allow_list = csvValues('allowList', p.allowList);
  }
  if (p.presets !== undefined && p.presets.trim() !== '') {
    if (triggerType !== undefined && triggerType !== 4) {
      throw new ValidationError('presets: only allowed when triggerType is 4 (preset)');
    }
    meta.presets = csvValues('presets', p.presets).map((part) => {
      const id = PRESET_IDS[part.toLowerCase()];
      if (id === undefined) {
        throw new ValidationError(`presets: "${part}" must be one of profanity, sexual_content, slurs`);
      }
      return id;
    });
  }
  if (p.mentionTotalLimit !== undefined) {
    if (triggerType !== undefined && triggerType !== 5) {
      throw new ValidationError('mentionTotalLimit: only allowed when triggerType is 5 (mention spam)');
    }
    meta.mention_total_limit = p.mentionTotalLimit;
  }
  if (p.mentionRaidProtectionEnabled !== undefined) {
    meta.mention_raid_protection_enabled = p.mentionRaidProtectionEnabled;
  }
  return meta;
}

function describeTriggerDetail(rule: RawAutoModRule): string {
  const meta = rule.trigger_metadata ?? {};
  const parts: string[] = [];
  if (meta.keyword_filter?.length) {
    const shown = meta.keyword_filter.slice(0, 5).join(', ');
    parts.push(
      `keywords: ${shown}${meta.keyword_filter.length > 5 ? ` (+${meta.keyword_filter.length - 5} more)` : ''}`,
    );
  }
  if (meta.regex_patterns?.length) {
    parts.push(`${meta.regex_patterns.length} regex pattern${meta.regex_patterns.length > 1 ? 's' : ''}`);
  }
  if (meta.presets?.length) {
    parts.push(`presets: ${meta.presets.map((p) => PRESET_NAMES[p] ?? String(p)).join(', ')}`);
  }
  if (meta.allow_list?.length) {
    const shown = meta.allow_list.slice(0, 5).join(', ');
    parts.push(
      `allow list: ${shown}${meta.allow_list.length > 5 ? ` (+${meta.allow_list.length - 5} more)` : ''}`,
    );
  }
  if (meta.mention_total_limit !== undefined && meta.mention_total_limit !== null) {
    parts.push(`mention limit ${meta.mention_total_limit}`);
  }
  if (meta.mention_raid_protection_enabled) parts.push('mention raid protection on');
  return parts.join('; ');
}

function describeAction(
  action: RawAutoModAction,
  channelName?: (id: string) => string | undefined,
): string {
  const meta = action.metadata ?? {};
  switch (action.type) {
    case 1:
      return meta.custom_message
        ? `block_message (custom message: "${meta.custom_message}")`
        : 'block_message';
    case 2: {
      const id = meta.channel_id ?? '?';
      const label = channelName ? channelName(id) ?? id : id;
      return `send_alert → #${label}`;
    }
    case 3:
      return `timeout ${meta.duration_seconds ?? '?'}s`;
    case 4:
      return 'block_member_interaction';
    default:
      return `unknown action type ${action.type}`;
  }
}

function ruleLine(rule: RawAutoModRule): string {
  const actions = rule.actions ?? [];
  const trigger = TRIGGER_TYPE_NAMES[rule.trigger_type] ?? String(rule.trigger_type);
  const detail = describeTriggerDetail(rule);
  return (
    `${rule.name} (id ${rule.id}, trigger ${trigger}, ` +
    `${rule.enabled ? 'enabled' : 'disabled'}, ${actions.length} action${actions.length === 1 ? '' : 's'})` +
    (detail ? ` — ${detail}` : '')
  );
}

/**
 * AutoMod rule tools (all raw REST; the bot needs Manage Guild).
 * Returns the number of tools registered.
 */
export function registerAutomodTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  reg.tool('list_automod_rules', {
    description: 'List the server\u2019s AutoMod rules with their triggers and actions. Requires Manage Guild.',
    inputSchema: {
      guildId: guildIdParam,
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const rules = (await ctx.client.rest.get(
        `/guilds/${guild.id}/auto-moderation/rules`,
      )) as RawAutoModRule[];
      if (!Array.isArray(rules) || !rules.length) return 'No AutoMod rules configured.';
      return truncate(rules.map(ruleLine).join('\n'));
    },
  });

  reg.tool('get_automod_rule', {
    description: 'Get one AutoMod rule\u2019s full details (trigger, actions, exemptions). Requires Manage Guild.',
    inputSchema: {
      guildId: guildIdParam,
      ruleId: snowflakeId('AutoMod rule ID'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const ruleId = assertSnowflake('ruleId', args.ruleId);
      const rule = (await ctx.client.rest.get(
        `/guilds/${guild.id}/auto-moderation/rules/${ruleId}`,
      )) as RawAutoModRule;
      const lines: string[] = [
        `${rule.name} (id ${rule.id}, ${rule.enabled ? 'enabled' : 'disabled'})`,
        `trigger: ${TRIGGER_TYPE_NAMES[rule.trigger_type] ?? rule.trigger_type}` +
          (describeTriggerDetail(rule) ? ` — ${describeTriggerDetail(rule)}` : ''),
        'actions:',
      ];
      const nameOf = (id: string) => guild.channels.cache.get(id)?.name;
      for (const action of rule.actions ?? []) lines.push(`- ${describeAction(action, nameOf)}`);
      const roles = (rule.exempt_roles ?? []).map(
        (id) => `@${guild.roles.cache.get(id)?.name ?? id}`,
      );
      const channels = (rule.exempt_channels ?? []).map(
        (id) => `#${guild.channels.cache.get(id)?.name ?? id}`,
      );
      lines.push(`exempt roles: ${roles.length ? roles.join(', ') : 'none'}`);
      lines.push(`exempt channels: ${channels.length ? channels.join(', ') : 'none'}`);
      return truncate(lines.join('\n'));
    },
  });

  reg.tool('create_automod_rule', {
    description:
      'Create an AutoMod rule (keyword/spam/preset/mention/profile trigger with block/alert/timeout actions). ' +
      'Requires Manage Guild.',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).describe('Rule name'),
      triggerType: triggerTypeParam,
      ...triggerFieldsShape,
      actionsJson: z
        .string()
        .describe(
          'Actions as a JSON array: [{"type":1,"customMessage?":"..."} (block), {"type":2,"channelId":"..."} ' +
          '(alert), {"type":3,"durationSeconds":604800} (timeout), {"type":4} (block member interaction)]',
        ),
      enabled: booleanParam('Whether the rule starts enabled (default true)'),
      exemptRoleIds: optionalIdListParam('Role IDs exempt from the rule'),
      exemptChannelIds: optionalIdListParam('Channel IDs exempt from the rule'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const actions = parseActions('actionsJson', args.actionsJson);
      const triggerMetadata = buildTriggerMetadata(args as TriggerParams, args.triggerType);
      const body = {
        name: args.name,
        event_type: 1,
        trigger_type: args.triggerType,
        trigger_metadata: triggerMetadata,
        actions,
        enabled: args.enabled ?? true,
        exempt_roles: parseIdList('exemptRoleIds', args.exemptRoleIds),
        exempt_channels: parseIdList('exemptChannelIds', args.exemptChannelIds),
      };
      const rule = (await ctx.client.rest.post(`/guilds/${guild.id}/auto-moderation/rules`, {
        body,
        reason: args.reason,
      })) as RawAutoModRule;
      const trigger = TRIGGER_TYPE_NAMES[rule.trigger_type] ?? rule.trigger_type;
      return (
        `AutoMod rule "${rule.name}" created (id ${rule.id}, trigger ${trigger}, ` +
        `${rule.enabled ? 'enabled' : 'disabled'}, ${actions.length} action${actions.length === 1 ? '' : 's'})`
      );
    },
  });

  reg.tool('edit_automod_rule', {
    description: 'Edit an AutoMod rule — only provided fields change. Requires Manage Guild.',
    inputSchema: {
      guildId: guildIdParam,
      ruleId: snowflakeId('AutoMod rule ID'),
      name: z.string().min(1).optional().describe('New rule name'),
      triggerType: triggerTypeParam.optional(),
      ...triggerFieldsShape,
      actionsJson: jsonParam(
        'Actions',
        'Array: [{type:1, customMessage?}, {type:2, channelId}, {type:3, durationSeconds}, {type:4}] — replaces all actions',
      ),
      enabled: booleanParam('Whether the rule is enabled'),
      exemptRoleIds: optionalIdListParam('Role IDs exempt from the rule (empty string clears)'),
      exemptChannelIds: optionalIdListParam('Channel IDs exempt from the rule (empty string clears)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const ruleId = assertSnowflake('ruleId', args.ruleId);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.triggerType !== undefined) body.trigger_type = args.triggerType;
      const meta = buildTriggerMetadata(args as TriggerParams, args.triggerType);
      if (Object.keys(meta).length) body.trigger_metadata = meta;
      if (args.actionsJson !== undefined && args.actionsJson !== '') {
        body.actions = parseActions('actionsJson', args.actionsJson);
      }
      if (args.enabled !== undefined) body.enabled = args.enabled;
      if (args.exemptRoleIds !== undefined) {
        body.exempt_roles = parseIdList('exemptRoleIds', args.exemptRoleIds);
      }
      if (args.exemptChannelIds !== undefined) {
        body.exempt_channels = parseIdList('exemptChannelIds', args.exemptChannelIds);
      }
      if (!Object.keys(body).length) {
        throw new ValidationError('nothing to edit: provide at least one field to change');
      }
      const rule = (await ctx.client.rest.patch(
        `/guilds/${guild.id}/auto-moderation/rules/${ruleId}`,
        { body, reason: args.reason },
      )) as RawAutoModRule;
      return `AutoMod rule "${rule.name}" (id ${rule.id}) updated`;
    },
  });

  reg.tool('delete_automod_rule', {
    description: 'Delete an AutoMod rule. Requires Manage Guild.',
    inputSchema: {
      guildId: guildIdParam,
      ruleId: snowflakeId('AutoMod rule ID'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const ruleId = assertSnowflake('ruleId', args.ruleId);
      const deleted = (await ctx.client.rest.delete(
        `/guilds/${guild.id}/auto-moderation/rules/${ruleId}`,
        { reason: args.reason },
      )) as RawAutoModRule;
      return `AutoMod rule "${deleted?.name ?? ruleId}" (id ${ruleId}) deleted`;
    },
  });

  return reg.count;
}
