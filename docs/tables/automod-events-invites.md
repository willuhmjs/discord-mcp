# AutoMod, Scheduled Events & Invites — tool reference

Legend: `?` marks optional params. All IDs are strings.

## AutoMod rules

All AutoMod tools hit the raw REST API (`/guilds/{guildId}/auto-moderation/rules`) and require the bot to hold **Manage Guild**.

| Tool | Key params | Requester permission |
| --- | --- | --- |
| `list_automod_rules` | `guildId?` | Manage Guild |
| `get_automod_rule` | `guildId?`, `ruleId` | Manage Guild |
| `create_automod_rule` | `guildId?`, `name`, `triggerType` (1 keyword, 3 spam, 4 preset, 5 mention spam, 6 member profile), `actionsJson` (required, JSON array), `keywords?`, `regexPatterns?`, `allowList?`, `presets?` (triggerType 4), `mentionTotalLimit?` (triggerType 5), `mentionRaidProtectionEnabled?`, `enabled?` (default true), `exemptRoleIds?`, `exemptChannelIds?`, `reason?` | Manage Guild |
| `edit_automod_rule` | `guildId?`, `ruleId`, plus any of `name`, `triggerType`, `keywords`, `regexPatterns`, `allowList`, `presets`, `mentionTotalLimit`, `mentionRaidProtectionEnabled`, `actionsJson`, `enabled`, `exemptRoleIds` (`""` clears), `exemptChannelIds` (`""` clears), `reason?` | Manage Guild |
| `delete_automod_rule` | `guildId?`, `ruleId`, `reason?` | Manage Guild |

## Scheduled events

All event tools use raw REST (`/guilds/{guildId}/scheduled-events`) for full recurrence-rule support.

| Tool | Key params | Requester permission |
| --- | --- | --- |
| `create_guild_scheduled_event` | `guildId?`, `name`, `scheduledStartTime` (ISO 8601), `entityType` (1 stage / 2 voice → `channelId` required; 3 external → `location` + `scheduledEndTime` required), `description?`, `scheduledEndTime?`, `recurrenceRuleJson?`, `coverImageUrl?`, `reason?` | Manage Events |
| `edit_guild_scheduled_event` | `guildId?`, `eventId`, any of `status` (1 Scheduled, 2 Active/start, 3 Completed, 4 Canceled), `name`, `description`, `scheduledStartTime`, `scheduledEndTime`, `channelId`, `location`, `coverImageUrl`, `recurrenceRuleJson`, `reason?` | Manage Events |
| `delete_guild_scheduled_event` | `guildId?`, `eventId`, `reason?` | Manage Events |
| `list_guild_scheduled_events` | `guildId?`, `withUserCount?` (default true) | — |
| `get_guild_scheduled_event` | `eventId`, `guildId?` | — |
| `get_guild_scheduled_event_users` | `guildId?`, `eventId`, `limit?` (default 100, max 100), `withMember?` (default true) | — |

## Invites

| Tool | Key params | Requester permission |
| --- | --- | --- |
| `create_invite` | `guildId?`, `channelId`, `maxAge?` (seconds, 0 = never, default 86400), `maxUses?` (0 = unlimited), `temporary?`, `unique?`, `targetType?` (1 stream, 2 embedded application), `targetUserId?`, `reason?` | Create Instant Invite |
| `list_invites` | `guildId?` | Manage Guild |
| `delete_invite` | `inviteCode` (code or full URL), `reason?` | Manage Guild |
| `get_invite_details` | `inviteCode` (code or full URL), `withCounts?` (default true) | — |
