# Message tools

`| Tool | Key params | Requester permission |` — requester permission is what the calling Discord user (not the bot) needs, for smartbot's permissions.py. Optional params are marked with `?`.

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
