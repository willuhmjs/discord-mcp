# Direct messages & users

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
