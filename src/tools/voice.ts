import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChannelType, type StageChannel, type VoiceChannel } from 'discord.js';
import { z } from 'zod';
import { assertSnowflake, fetchChannel, fetchGuild, type ToolContext } from '../lib/context.js';
import { ValidationError } from '../lib/errors.js';
import { booleanParam, channelIdParam, createRegistrar, guildIdParam, reasonParam, userIdParam } from '../lib/register.js';

/**
 * Voice & stage tools: legacy channel/member management plus the newer
 * voice-channel status and stage-instance operations. Returns the number of
 * tools registered.
 */
export function registerVoiceTools(server: McpServer, ctx: ToolContext): number {
  const reg = createRegistrar(server);

  async function fetchVoiceLikeChannel(channelId: string): Promise<VoiceChannel | StageChannel> {
    const channel = await fetchChannel<VoiceChannel | StageChannel>(ctx, channelId);
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      throw new ValidationError(`channelId: ${channelId} is not a voice or stage channel`);
    }
    return channel;
  }

  async function fetchStageChannel(channelId: string): Promise<StageChannel> {
    const channel = await fetchChannel<StageChannel>(ctx, channelId);
    if (channel.type !== ChannelType.GuildStageVoice) {
      throw new ValidationError(`channelId: ${channelId} is not a stage channel`);
    }
    return channel;
  }

  /** Fetch a member and assert they are connected to a voice channel. */
  async function voiceMember(guildId: string | undefined, userId: string) {
    const guild = await fetchGuild(ctx, guildId);
    const id = assertSnowflake('userId', userId);
    const member = await guild.members.fetch(id);
    if (!member.voice.channelId) {
      throw new ValidationError('userId: member is not connected to a voice channel');
    }
    return member;
  }

  reg.tool('create_voice_channel', {
    description: 'Create a new voice channel in a guild',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).max(100).describe('Channel name'),
      categoryId: z.string().optional().describe('Category ID'),
      userLimit: z
        .number()
        .int()
        .min(0)
        .max(99)
        .optional()
        .describe('Max users (0 = unlimited, max 99)'),
      bitrate: z
        .number()
        .int()
        .min(8000)
        .max(384000)
        .optional()
        .describe('Audio bitrate in bits/s (e.g. 64000). Max depends on server boost level'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const channel = await guild.channels.create({
        name: args.name,
        type: ChannelType.GuildVoice,
        ...(args.categoryId ? { parent: assertSnowflake('categoryId', args.categoryId) } : {}),
        ...(args.userLimit !== undefined ? { userLimit: args.userLimit } : {}),
        ...(args.bitrate !== undefined ? { bitrate: args.bitrate } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Voice channel "${channel.name}" created (id ${channel.id})`;
    },
  });

  reg.tool('create_stage_channel', {
    description: 'Create a new stage channel for audio events in a guild',
    inputSchema: {
      guildId: guildIdParam,
      name: z.string().min(1).max(100).describe('Channel name'),
      categoryId: z.string().optional().describe('Category ID'),
      bitrate: z
        .number()
        .int()
        .min(8000)
        .max(384000)
        .optional()
        .describe('Audio bitrate in bits/s (e.g. 64000)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const guild = await fetchGuild(ctx, args.guildId);
      const channel = await guild.channels.create({
        name: args.name,
        type: ChannelType.GuildStageVoice,
        ...(args.categoryId ? { parent: assertSnowflake('categoryId', args.categoryId) } : {}),
        ...(args.bitrate !== undefined ? { bitrate: args.bitrate } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Stage channel "${channel.name}" created (id ${channel.id})`;
    },
  });

  reg.tool('edit_voice_channel', {
    description: 'Edit settings of a voice or stage channel (name, bitrate, user limit, region)',
    inputSchema: {
      channelId: channelIdParam,
      name: z.string().min(1).max(100).optional().describe('New channel name'),
      bitrate: z.number().int().min(8000).max(384000).optional().describe('New bitrate in bits/s'),
      userLimit: z.number().int().min(0).max(99).optional().describe('New user limit (0 = unlimited)'),
      rtcRegion: z
        .string()
        .optional()
        .describe("Voice region (e.g. 'rotterdam', 'us-east'). Empty for automatic"),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchVoiceLikeChannel(args.channelId);
      if (
        args.name === undefined &&
        args.bitrate === undefined &&
        args.userLimit === undefined &&
        args.rtcRegion === undefined
      ) {
        throw new ValidationError('provide at least one of name, bitrate, userLimit, rtcRegion');
      }
      await channel.edit({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.bitrate !== undefined ? { bitrate: args.bitrate } : {}),
        ...(args.userLimit !== undefined ? { userLimit: args.userLimit } : {}),
        ...(args.rtcRegion !== undefined
          ? { rtcRegion: args.rtcRegion === '' ? null : args.rtcRegion }
          : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      });
      return `Voice channel "${channel.name}" (id ${channel.id}) updated`;
    },
  });

  reg.tool('move_member', {
    description: 'Move a member to another voice channel. The member must already be connected to a voice channel.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      channelId: channelIdParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const targetId = assertSnowflake('channelId', args.channelId);
      const member = await voiceMember(args.guildId, args.userId);
      await member.voice.setChannel(targetId, args.reason);
      return `Moved ${member.user.username} (id ${member.id}) to voice channel ${targetId}`;
    },
  });

  reg.tool('disconnect_member', {
    description: 'Disconnect a member from their current voice channel',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const member = await voiceMember(args.guildId, args.userId);
      const from = member.voice.channelId;
      await member.voice.setChannel(null, args.reason);
      return `Disconnected ${member.user.username} (id ${member.id}) from voice channel ${from}`;
    },
  });

  reg.tool('modify_voice_state', {
    description: 'Server mute or deafen a member across all voice channels. The member must be in a voice channel.',
    inputSchema: {
      guildId: guildIdParam,
      userId: userIdParam,
      mute: booleanParam('Whether to server-mute the user\u2019s microphone'),
      deafen: booleanParam('Whether to server-deafen the user\u2019s audio'),
      reason: reasonParam,
    },
    handler: async (args) => {
      if (args.mute === undefined && args.deafen === undefined) {
        throw new ValidationError('provide at least one of mute, deafen');
      }
      const member = await voiceMember(args.guildId, args.userId);
      const changes: string[] = [];
      if (args.mute !== undefined) {
        await member.voice.setMute(args.mute, args.reason);
        changes.push(args.mute ? 'server-muted' : 'server-unmuted');
      }
      if (args.deafen !== undefined) {
        await member.voice.setDeaf(args.deafen, args.reason);
        changes.push(args.deafen ? 'server-deafened' : 'server-undeafened');
      }
      return `${member.user.username} (id ${member.id}) ${changes.join(' and ')}`;
    },
  });

  reg.tool('set_voice_channel_status', {
    description: 'Set (or clear) the status text shown on a voice channel.',
    inputSchema: {
      channelId: channelIdParam,
      status: z
        .string()
        .max(500)
        .describe('New status text (up to 500 chars; empty string clears the status)'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channelId = assertSnowflake('channelId', args.channelId);
      // No discord.js wrapper yet — raw REST (PUT /channels/{id}/voice-status).
      await ctx.client.rest.put(`/channels/${channelId}/voice-status`, {
        body: { status: args.status },
        reason: args.reason,
      });
      return args.status
        ? `Voice channel ${channelId} status set to "${args.status}"`
        : `Voice channel ${channelId} status cleared`;
    },
  });

  reg.tool('create_stage_instance', {
    description: 'Start a stage instance (live topic) on a stage channel.',
    inputSchema: {
      channelId: channelIdParam,
      topic: z.string().min(1).max(120).describe('Stage topic (1-120 chars)'),
      privacyLevel: z
        .number()
        .int()
        .min(1)
        .max(2)
        .optional()
        .describe('1 = public, 2 = guild only (default 2)'),
      notify: booleanParam('Notify @everyone that the stage instance started'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchStageChannel(args.channelId);
      await ctx.client.rest.post('/stage-instances', {
        body: {
          channel_id: channel.id,
          topic: args.topic,
          privacy_level: args.privacyLevel ?? 2,
          ...(args.notify !== undefined ? { notify_everyone_stage_instance: args.notify } : {}),
        },
        reason: args.reason,
      });
      const privacy = (args.privacyLevel ?? 2) === 1 ? 'public' : 'guild only';
      return `Stage instance started in "${channel.name}" (id ${channel.id}): "${args.topic}" (${privacy}` +
        `${args.notify ? ', @everyone notified' : ''})`;
    },
  });

  reg.tool('edit_stage_instance', {
    description: 'Edit the stage instance running on a stage channel (topic, privacy).',
    inputSchema: {
      channelId: channelIdParam,
      topic: z.string().min(1).max(120).optional().describe('New stage topic'),
      privacyLevel: z.number().int().min(1).max(2).optional().describe('1 = public, 2 = guild only'),
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchStageChannel(args.channelId);
      if (args.topic === undefined && args.privacyLevel === undefined) {
        throw new ValidationError('provide at least one of topic, privacyLevel');
      }
      await ctx.client.rest.patch(`/stage-instances/${channel.id}`, {
        body: {
          ...(args.topic !== undefined ? { topic: args.topic } : {}),
          ...(args.privacyLevel !== undefined ? { privacy_level: args.privacyLevel } : {}),
        },
        reason: args.reason,
      });
      return `Stage instance for "${channel.name}" (id ${channel.id}) updated`;
    },
  });

  reg.tool('delete_stage_instance', {
    description: 'End the stage instance running on a stage channel.',
    inputSchema: {
      channelId: channelIdParam,
      reason: reasonParam,
    },
    handler: async (args) => {
      const channel = await fetchStageChannel(args.channelId);
      await ctx.client.rest.delete(`/stage-instances/${channel.id}`, { reason: args.reason });
      return `Stage instance for "${channel.name}" (id ${channel.id}) ended`;
    },
  });

  return reg.count;
}
