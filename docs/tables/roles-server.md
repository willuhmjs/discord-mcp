# Roles & Server tools — permissions reference

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
