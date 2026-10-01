# Webhooks & Expressions tool reference

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
