# Voice, Stage & Forums tools

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
