# Tool reference

All 168 tools exposed by discord-mcp. For setup and configuration see the [README](../README.md).

## Conventions (what tool consumers rely on)

- Every ID is a **string** (snowflakes overflow JS numbers).
- Every guild-scoped tool takes an optional `guildId` that falls back to
  `DISCORD_GUILD_ID`.
- Structured payloads (`embedsJson`, `componentsJson`, `pollJson`,
  `filesJson`, ...) are **JSON strings**, validated with field-level errors.
- Tool results are short plain text (confirmations, one line per message,
  jump URLs). Errors come back as MCP tool errors with readable messages —
  `Discord API error 50013 (HTTP 403): Missing Access — ... role is at/above
  its highest role`.
- Every mutating tool takes an optional `reason` for the audit log.
- List tools cap output around 6 KB to stay within common tool-result budgets.

### Rich message parameters

`send_message`, `send_private_message`, `send_webhook_message` and
`create_forum_post` accept:

| Param | Shape |
|---|---|
| `message` | Plain text content (≤ 2000 chars). Optional when embeds/components/poll/files are present. |
| `embedsJson` | `[{title, description, url, timestamp, color, footer:{text, icon_url}, image:{url}, thumbnail:{url}, author:{name, url, icon_url}, fields:[{name, value, inline}]}]` — max 10, 6000 chars total. |
| `componentsJson` | Raw Discord component JSON: action rows (type 1) with buttons (2) / selects (3, 5, 6, 7, 8), or V2 types (9 section, 10 text display, 11 thumbnail, 12 media gallery, 13 file, 14 separator, 17 container). |
| `componentsV2` | Send as Components V2 — components only (no content/embeds/stickers/poll). |
| `pollJson` | `{question:{text}, answers:[{poll_media:{text, emoji?}}] (≤10), duration (hours 1–768), allow_multiselect}`. Polls can't be edited. |
| `filesJson` | `[{url, filename?, description?, spoiler?}` or `{base64, filename, description?, spoiler?}]` — `attachment://filename` works in embeds. |
| `replyToMessageId` | Reply to a message. |
| `stickerIds` | Up to 3 sticker IDs. |
| `allowedMentions` | `users` (default) / `users_roles` / `all` / `none`. |
| `silent` / `suppressEmbeds` | Notification suppression / hide embeds. |

### Built-in interactive components

Non-link buttons/selects must be acknowledged within 3 s — this server handles
them, encoded in `custom_id` so nothing is lost on restart:

| `custom_id` | Behaviour |
|---|---|
| `mcp:role:<roleId>` | Toggle that role on the clicker + ephemeral confirmation. Refuses managed/dangerous roles and roles at/above the bot's top role (checked at menu creation *and* click time). |
| `mcp:roleselect` | Role select menu: selected roles added, deselected removed (same safety checks). |
| `mcp:reply:<base64>` | Ephemeral canned reply (≤ 80 chars). |
| anything else | Acknowledged (deferUpdate) and recorded. |

`create_role_menu` posts embed+components menus in one call;
`list_interactions` shows who clicked what (last 200, in memory).

## Tools

### Messages

`| Tool | Key params | Requester permission |` — requester permission is what the calling Discord user (not the bot) needs, useful if you gate these tools behind per-user permission checks. Optional params are marked with `?`.

| Tool | Key params | Requester permission |
|---|---|---|
| send_message | channelId, message?, embedsJson?, componentsJson?, componentsV2?, pollJson?, replyToMessageId?, stickerIds?, filesJson?, allowedMentions?, silent?, suppressEmbeds? | send_messages |
| edit_message | channelId, messageId, newMessage?, embedsJson?, componentsJson?, componentsV2?, keepAttachments?, suppressEmbeds? | manage_messages |
| delete_message | channelId, messageId | manage_messages |
| read_messages | channelId, count?, before?, after?, around? | read_message_history |
| add_reaction | channelId, messageId, emoji | add_reactions |
| remove_reaction | channelId, messageId, emoji | manage_messages |
| get_attachment | channelId, messageId, attachmentId? | read_message_history |
| forward_message | channelId, messageId, targetChannelId | send_messages |
| get_message | channelId, messageId | read_message_history |
| search_messages | guildId?, content?, authorId?, channelId?, mentionsUserId?, has?, before?, after?, limit? | read_message_history |
| pin_message | channelId, messageId, reason? | manage_messages |
| unpin_message | channelId, messageId, reason? | manage_messages |
| list_pins | channelId | read_message_history |
| bulk_delete_messages | channelId, messageIds?, count?, reason? | manage_messages |
| crosspost_message | channelId, messageId | manage_messages |
| list_reactions | channelId, messageId, emoji, limit? | read_message_history |
| clear_reactions | channelId, messageId, emoji? | manage_messages |
| remove_user_reaction | channelId, messageId, emoji, userId | manage_messages |
| end_poll | channelId, messageId | manage_messages |
| get_poll_voters | channelId, messageId, answerId, limit? | read_message_history |
| send_typing | channelId | send_messages |

### Direct Messages Users

These tools act as the bot itself, in a DM or against Discord's user directory, so no server permission
applies to them; they are listed as "—". Decide yourself who may call them (for example, restrict the DM
tools to administrators). Optional params are marked with `?`.

| Tool | Key params | Requester permission |
|---|---|---|
| send_private_message | userId, message?, embedsJson?, componentsJson?, componentsV2?, pollJson?, replyToMessageId?, stickerIds?, filesJson?, allowedMentions?, silent?, suppressEmbeds? | — (DMs as the bot) |
| edit_private_message | userId, messageId, newMessage?, embedsJson?, componentsJson?, componentsV2?, keepAttachments?, suppressEmbeds? | — (only messages the bot sent) |
| delete_private_message | userId, messageId | — (only messages the bot sent) |
| read_private_messages | userId, count?, before?, after?, around? | — (reads the bot's private DM history) |
| get_user_id_by_name | username, guildId? | — (read-only) |
| get_user | userId | — (read-only; works for users outside the server) |

### Channels

All tools in `src/tools/channels.ts`. Every Discord ID is a string. Core tool
names keep their classic parameter names; boolean/number params accept both
native JSON values and their string spellings.

| Tool | Key params | Requester permission |
| --- | --- | --- |
| create_text_channel | guildId?, name, categoryId?, topic?, nsfw?, slowmode?, position?, reason? | Manage Channels |
| edit_text_channel | guildId?, channelId, name?, topic?, nsfw?, slowmode?, categoryId?, position?, reason? | Manage Channels |
| delete_channel | guildId?, channelId, reason? | Manage Channels |
| find_channel | guildId?, channelName | — (read-only) |
| list_channels | guildId? | — (read-only) |
| get_channel_info | guildId?, channelId | — (read-only) |
| move_channel | guildId?, channelId, categoryId?, position?, reason? | Manage Channels |
| create_category | guildId?, name, reason? | Manage Channels |
| edit_category | guildId?, categoryId, name?, position?, reason? | Manage Channels |
| delete_category | guildId?, categoryId, reason? | Manage Channels |
| find_category | guildId?, categoryName | — (read-only) |
| list_channels_in_category | guildId?, categoryId | — (read-only) |
| list_channel_permission_overwrites | guildId?, channelId | — (read-only) |
| upsert_role_channel_permissions | guildId?, channelId, roleId, allowRaw?, denyRaw?, allowPermissions?, denyPermissions?, reason? | Manage Channels |
| upsert_member_channel_permissions | guildId?, channelId, userId, allowRaw?, denyRaw?, allowPermissions?, denyPermissions?, reason? | Manage Channels |
| delete_channel_permission_overwrite | guildId?, channelId, targetType, targetId, reason? | Manage Channels |
| create_channel | guildId?, name, type, topic?, nsfw?, slowmodeSeconds?, bitrate?, userLimit?, parentId?, position?, overwritesJson?, defaultAutoArchiveMinutes?, defaultReactionEmoji?, availableTagsJson?, defaultSortOrder?, defaultForumLayout?, defaultThreadSlowmode?, rtcRegion?, videoQualityMode?, reason? | Manage Channels |
| edit_channel | channelId, name?, topic?, nsfw?, slowmodeSeconds?, bitrate?, userLimit?, parentId?, position?, overwritesJson?, defaultAutoArchiveMinutes?, defaultReactionEmoji?, availableTagsJson?, defaultSortOrder?, defaultForumLayout?, defaultThreadSlowmode?, rtcRegion?, videoQualityMode?, lockPermissions?, reason? | Manage Channels |
| follow_announcement_channel | channelId, targetChannelId | Manage Webhooks (on the target channel) |
| list_channel_invites | channelId | — (read-only) |

### Voice Forums

Every guild-scoped tool also takes an optional `guildId` (defaults to `DISCORD_GUILD_ID`);
`edit_voice_channel` and the tag tools are channel-scoped and skip it. `reason` is an optional
audit-log parameter on every mutating tool.

## Voice & Stage

| Tool | Key params | Requester permission |
| --- | --- | --- |
| create_voice_channel | name, categoryId?, userLimit?, bitrate? | Manage Channels |
| create_stage_channel | name, categoryId?, bitrate? | Manage Channels |
| edit_voice_channel | channelId, name?, bitrate?, userLimit?, rtcRegion? (empty = automatic) | Manage Channels |
| move_member | userId, channelId (member must be in voice) | Move Members |
| disconnect_member | userId (member must be in voice) | Move Members |
| modify_voice_state | userId, mute?, deafen? (at least one required) | Mute Members, Deafen Members |
| set_voice_channel_status | channelId, status (up to 500 chars; empty clears) | Manage Channels (Any) |
| create_stage_instance | channelId, topic, privacyLevel? (1 public / 2 guild-only), notify? | Mute Members, Move Members |
| edit_stage_instance | channelId, topic?, privacyLevel? | Mute Members, Move Members |
| delete_stage_instance | channelId | Mute Members, Move Members |

## Forums

| Tool | Key params | Requester permission |
| --- | --- | --- |
| create_forum_channel | name, categoryId?, topic?, nsfw?, slowmode?, position? | Manage Channels |
| edit_forum_channel | channelId, name?, topic?, nsfw?, slowmode?, categoryId?, position?, defaultSort?, defaultLayout? | Manage Channels |
| list_forum_channels | — | — |
| get_forum_channel_info | channelId | — |
| list_forum_tags | channelId | — |
| create_forum_post | channelId, title, message/embeds (rich send), tagIds? | Send Messages |
| list_forum_posts | channelId | — |
| modify_forum_post | postId, locked?, archived?, pinned?, tagIds? (empty clears) | Manage Threads |
| create_forum_tag | channelId, name, emoji?, moderated? | Manage Threads |
| edit_forum_tag | channelId, tagId, name?, emoji?, moderated? | Manage Threads |
| delete_forum_tag | channelId, tagId | Manage Threads |

### Threads Members

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

### Roles Server

Requester permission = what the bot (the MCP caller) needs on the target server.
`guildId` is optional everywhere and defaults to `DISCORD_GUILD_ID`; `reason` is an optional
audit-log reason on every mutating tool where Discord supports one.

## Roles

| Tool | Key params | Requester permission |
|---|---|---|
| list_roles | guildId? | — |
| create_role | guildId?, name, color?, hoist?, mentionable?, permissions?, reason? | Manage Roles |
| edit_role | guildId?, roleId, name?, color?, hoist?, mentionable?, permissions?, iconUrl?, unicodeEmoji?, secondaryColor?, tertiaryColor?, reason? | Manage Roles |
| delete_role | guildId?, roleId, reason? | Manage Roles |
| assign_role | guildId?, userId, roleId, reason? | Manage Roles |
| remove_role | guildId?, userId, roleId, reason? | Manage Roles |
| reorder_roles | guildId?, positionsJson, reason? | Manage Roles |
| get_role_member_counts | guildId? | — |
| get_role | guildId?, roleId | — |
| list_role_members | guildId?, roleId, limit? | — (requires the GuildMembers intent) |

For every role mutation the bot's highest role must also sit above the target role
(Discord enforces role hierarchy); assigning or deleting @everyone/@managed roles is not possible.

## Server

| Tool | Key params | Requester permission |
|---|---|---|
| get_server_info | guildId? | — |
| edit_server | guildId?, name?, description?, iconUrl?, bannerUrl?, verificationLevel?, defaultNotifications?, explicitContentFilter?, afkChannelId?, afkTimeout?, systemChannelId?, systemChannelFlags?, rulesChannelId?, publicUpdatesChannelId?, preferredLocale?, reason? | Manage Guild |
| get_welcome_screen | guildId? | Manage Guild |
| edit_welcome_screen | guildId?, enabled?, description?, channelsJson?, reason? | Manage Guild |
| get_onboarding | guildId? | Manage Guild |
| edit_onboarding | guildId?, promptsJson?, defaultChannelIds?, enabled?, mode?, reason? | Manage Guild + Manage Roles |
| set_incident_actions | guildId?, invitesDisabledUntil?, dmsDisabledUntil? | Manage Guild |
| get_widget | guildId? | Manage Guild (settings; the widget.json data itself is public) |
| edit_widget | guildId?, enabled?, channelId?, reason? | Manage Guild |
| get_vanity_url | guildId? | Manage Guild |
| list_integrations | guildId? | Manage Guild |
| delete_integration | guildId?, integrationId, reason? | Manage Guild |
| list_voice_regions | (none) | — |
| list_guild_templates | guildId? | Manage Guild |
| create_guild_template | guildId?, name, description?, reason? | Manage Guild |
| sync_guild_template | guildId?, templateCode, reason? | Manage Guild |
| edit_guild_template | guildId?, templateCode, name?, description?, reason? | Manage Guild |
| delete_guild_template | guildId?, templateCode, reason? | Manage Guild |
| get_audit_log | guildId?, userId?, actionType?, before?, limit? | View Audit Log |

Notes:

- Welcome screen, onboarding, templates, and incident actions only work on community servers
  (onboarding edits additionally need Manage Roles, not just Manage Guild).
- Icon/banner/role-icon images are fetched by the MCP server from `iconUrl`/`bannerUrl`/`iconUrl`
  (SSRF-guarded, image content-types only, 256KB for guild images / 512KB for role icons) and are
  uploaded to Discord as base64 data URIs; raw URLs are never passed through.
- `list_voice_regions` is not guild-scoped and takes no parameters.

### Automod Events Invites

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

### Webhooks Expressions

`guildId` is optional everywhere it appears (defaults to `DISCORD_GUILD_ID`). All IDs are strings.
Webhook URLs/tokens are send credentials: list/get tools never show them; only `create_webhook` returns the URL (once).

## Webhooks

| Tool | Key params | Requester permission |
| --- | --- | --- |
| create_webhook | channelId, name, avatarUrl?, reason? | Manage Webhooks |
| delete_webhook | webhookId, reason? | Manage Webhooks |
| list_webhooks | channelId | Manage Webhooks |
| send_webhook_message | webhookUrl, message, embedsJson?, componentsJson?, username?, avatarUrl?, threadId?, threadName?, filesJson?, allowedMentions? | Manage Webhooks |
| get_webhook | webhookId | Manage Webhooks |
| edit_webhook | webhookId, name?, avatarUrl?, channelId?, reason? | Manage Webhooks |
| list_guild_webhooks | guildId? | Manage Webhooks |
| get_webhook_message | webhookId, messageId, threadId? | Manage Webhooks |
| edit_webhook_message | webhookId, messageId, newMessage?, embedsJson?, componentsJson?, threadId? | Manage Webhooks |
| delete_webhook_message | webhookId, messageId, threadId? | Manage Webhooks |

Notes: `send_webhook_message` authenticates with the webhook URL itself (the token in the URL is the credential), but viewing/managing webhooks requires **Manage Webhooks**. `threadName` creates a forum post when the webhook targets a forum channel. `get/edit/delete_webhook_message` only work for webhooks the bot manages (they need the webhook token).

## Expressions

| Tool | Key params | Requester permission |
| --- | --- | --- |
| list_emojis | guildId? | — |
| get_emoji_details | guildId?, emojiId | — |
| create_emoji | guildId?, name, image? / imageUrl?, roles? | Manage Expressions |
| edit_emoji | guildId?, emojiId, name?, roles? | Manage Expressions |
| delete_emoji | guildId?, emojiId, reason? | Manage Expressions |
| list_app_emojis | — | — |
| create_app_emoji | name, image? / imageUrl? | — |
| delete_app_emoji | emojiId | — |
| list_guild_stickers | guildId? | — |
| get_guild_sticker | guildId?, stickerId | — |
| create_guild_sticker | guildId?, name, tags, fileUrl? / fileBase64?, description?, reason? | Manage Expressions |
| edit_guild_sticker | guildId?, stickerId, name?, description?, tags?, reason? | Manage Expressions |
| delete_guild_sticker | guildId?, stickerId, reason? | Manage Expressions |
| list_sticker_packs | — | — |
| list_default_sounds | — | — |
| list_guild_sounds | guildId? | — |
| get_guild_sound | guildId?, soundId | — |
| create_guild_sound | guildId?, name, fileUrl? / fileBase64?, volume?, emojiId? / emojiName?, reason? | Manage Expressions |
| edit_guild_sound | guildId?, soundId, name?, volume?, emojiId? / emojiName?, reason? | Manage Expressions |
| delete_guild_sound | guildId?, soundId, reason? | Manage Expressions |

Notes: pairs marked `a? / b?` are mutually exclusive — provide exactly one. Application emojis are owned by the bot's application (no server permission needed; the application owner controls them). Sticker files must be PNG/APNG/GIF (≤512KB, animated ≤5s) or Lottie JSON; soundboard sounds must be mp3/ogg (≤512KB, ≤5.2s). `edit_emoji` roles: empty string = unrestrict for everyone. `edit_guild_sound`: empty-string emojiId/emojiName clears the emoji.

### Interactions

Self-service role menus (handled automatically via `mcp:` custom ids — no state, survives restarts) and the interaction log.

| Tool | Key params | Requester permission |
| --- | --- | --- |
| `create_role_menu` | `channelId`, `roles` (JSON array `[{roleId, label, emoji?, description?}]`, 1–25 entries) or `roleIds` (comma-separated), `style` (`buttons` \| `select`), `title?`, `description?`, `embedColor?` | Manage Roles |
| `list_interactions` | `channelId?`, `sinceMinutes?` (1–1440, default 30) | — (read-only, `readOnlyHint` annotation) |
