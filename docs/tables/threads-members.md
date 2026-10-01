# Threads & Members tools

Requester = the bot (permissions are checked server-side against the bot's roles).
Every ID is a string. `guildId` is optional everywhere (defaults to `DISCORD_GUILD_ID`).
Mutating tools take an optional `reason` for the audit log where the Discord API supports one.

## Threads

| Tool | Key params | Requester permission |
| --- | --- | --- |
| list_active_threads | guildId? | Read Message History |
| create_thread | channelId, name, messageId? or private?, autoArchiveMinutes?, invitable?, slowmodeSeconds? | Create Public Threads / Create Private Threads (private threads need Create Private Threads) |
| edit_thread | threadId, name?, archived?, locked?, autoArchiveMinutes?, slowmodeSeconds?, appliedTagIds?, reason? | Manage Threads |
| add_thread_member | threadId, userId | Manage Threads |
| remove_thread_member | threadId, userId | Manage Threads |
| list_thread_members | threadId | Read Message History |
| join_thread | threadId | — |
| leave_thread | threadId | — |
| list_archived_threads | channelId, private?, before?, limit? | Read Message History (private archived also needs Manage Threads) |

## Members & Moderation

| Tool | Key params | Requester permission |
| --- | --- | --- |
| kick_member | guildId?, userId, reason? | Kick Members |
| ban_member | guildId?, userId, deleteMessageSeconds?, reason? | Ban Members |
| unban_member | guildId?, userId, reason? | Ban Members |
| timeout_member | guildId?, userId, durationSeconds, reason? | Moderate Members |
| remove_timeout | guildId?, userId, reason? | Moderate Members |
| set_nickname | guildId?, userId, nick?, reason? | Manage Nicknames |
| get_bans | guildId?, limit? | Ban Members |
| get_member | guildId?, userId | — |
| search_members | guildId?, query, limit? | — |
| list_members | guildId?, limit?, after? | — (needs the privileged GuildMembers intent) |
| edit_member | guildId?, userId, nick?, roleIds?, mute?, deaf?, voiceChannelId?, timeoutUntil?, reason? | depends on fields — nick: Manage Nicknames; roleIds: Manage Roles; timeoutUntil: Moderate Members; mute/deaf/voiceChannelId: Mute Members / Deafen Members / Move Members |
| bulk_ban | guildId?, userIds, deleteMessageSeconds?, reason? | Ban Members |
| get_ban | guildId?, userId | Ban Members |
| prune_members | guildId?, days, includeRoleIds?, dryRun? | Kick Members (dry run changes nothing) |
| set_bot_nickname | guildId?, nick | Manage Nicknames (or Manage Guild — the bot's own nickname) |
