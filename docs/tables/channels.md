# Channel tools

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
