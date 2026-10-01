# Manual testing checklist

Run through this in a throwaway **test guild** after `npm run build`. The bot
needs: Message Content intent (required), Server Members intent optional
(only if `ENABLE_MEMBERS_INTENT=1`).

Setup:

```bash
DISCORD_TOKEN=... DISCORD_GUILD_ID=<test guild id> node dist/index.js
# watch for: ready as <tag>, N tools
```

## Transport

- [ ] `curl -s localhost:8085/health` → `ok` (503 before the client is ready)
- [ ] smartbot connects unchanged and logs all tools
- [ ] `MCP_TRANSPORT=stdio` mode: `DISCORD_TOKEN=... MCP_TRANSPORT=stdio node dist/index.js` speaks MCP on stdin/stdout (e.g. via `npx @modelcontextprotocol/inspector`)
- [ ] bad token → exits non-zero with a clear 401 message
- [ ] token with intents disabled in the portal → exits non-zero mentioning code 4014 and the developer portal

## P0 rich messages

- [ ] `send_message` with `message` only (legacy path still works)
- [ ] `send_message` with 2 embeds (one with `#RRGGBB` color, one with fields) — verify colors and layout
- [ ] `send_message` with `embedsJson` referencing `attachment://file.png` + `filesJson: [{"url":"..."}]`
- [ ] `send_message` with one link button (`componentsJson` action row, style 5, url) and one interactive button (style 1, custom_id `mcp:reply:<base64>`) — click both; the reply button answers ephemerally; `list_interactions` shows the click
- [ ] `send_message` with `replyToMessageId` — posts as a reply
- [ ] `send_message` with `pollJson` (3 answers, 24h) — vote, then `get_poll_voters`; `end_poll` closes it
- [ ] `send_message` with `componentsV2: true` + a Container (17) with Text Display (10) and a Section (9) — verify no content is sent
- [ ] `send_message` with `componentsV2: true` AND `message` set → rejected with the exclusivity error
- [ ] `send_message` with `silent: true` — no notification is pushed
- [ ] `edit_message` changing text + `embedsJson`, then again with `keepAttachments: true` — attachments survive
- [ ] `forward_message` from one channel to another — shows as forwarded
- [ ] `search_messages` with `content` — returns one line per hit (may take a retry while the index warms)
- [ ] `read_messages` in a thread / forum post / announcement channel (channelId accepts all of them)
- [ ] `pin_message` + `list_pins` + `unpin_message`
- [ ] `bulk_delete_messages` with `count: 5` on spam, then with explicit `messageIds`
- [ ] embed limit rejection: 11 embeds, field value 1100 chars, 6001 total chars — each error names the field

## P1 interactions

- [ ] `create_role_menu` with 3 safe roles, style buttons — every button toggles a role on click, ephemeral confirmation, works after a server restart
- [ ] role menu with a dangerous role (e.g. Administrator) → refused at creation time
- [ ] move the bot's role below a menu role → click refused with the hierarchy error
- [ ] `create_role_menu` style select — selecting adds, deselecting removes
- [ ] click an unknown-custom_id button → no "interaction failed", appears in `list_interactions` as deferred

## P1 threads / members / server

- [ ] `create_thread` from a message and standalone (private too) — post in it via `send_message` with the thread id
- [ ] `edit_thread` (archive, lock, rename), `add_thread_member`, `list_thread_members`, `join_thread`
- [ ] `list_archived_threads` after archiving one
- [ ] `get_member`, `search_members`, `list_members` (with and without `ENABLE_MEMBERS_INTENT`)
- [ ] `edit_member` nickname + `timeoutUntil: "10m"` → timeout applied; `"clear"` removes it
- [ ] `bulk_ban` two users (one invalid id) → reports 1 banned, 1 failed
- [ ] `prune_members` dry run reports a count without kicking anyone
- [ ] `get_audit_log` after a ban — shows the action + reason
- [ ] `edit_server` description → visible in server settings (audit log has the reason)

## P2 areas (spot checks)

- [ ] Channels: `create_channel` type forum with `availableTagsJson`, then `create_forum_tag` + post with tags
- [ ] Overwrites: `upsert_role_channel_permissions` with `allowPermissions: "VIEW_CHANNEL,MESSAGE_SEND"` → verify with `list_channel_permission_overwrites`
- [ ] Voice: `create_voice_channel`, `move_member`, `set_voice_channel_status`
- [ ] Stage: `create_stage_instance` on a stage channel
- [ ] AutoMod: `create_automod_rule` keyword rule with block_message action; post the keyword as a user → blocked; `list_automod_rules`, `edit_automod_rule`, `delete_automod_rule`
- [ ] Server config: `edit_welcome_screen`, `get_onboarding`, `set_incident_actions` with `invitesDisabledUntil: "1h"`
- [ ] Expressions: `create_emoji` from `imageUrl`; `create_guild_sticker` from `fileUrl`; `create_guild_sound` from an mp3 URL; `list_default_sounds`
- [ ] Events: `create_guild_scheduled_event` voice event; `edit_guild_scheduled_event` status 2 (start); `get_guild_scheduled_event_users`
- [ ] Invites: `create_invite` with `temporary: true` → joins as guest; `list_invites`, `get_invite_details`, `delete_invite`
- [ ] Webhooks: `create_webhook` returns the URL once; `send_webhook_message` with `username`/`avatarUrl`/embeds returns a message id; `list_webhooks` does NOT contain tokens; `get_webhook_message`/`edit_webhook_message`/`delete_webhook_message` round-trip

## Security spot checks

- [ ] `create_emoji` with `imageUrl: "http://127.0.0.1/x.png"` → blocked (private address)
- [ ] `create_emoji` with an `imageUrl` that redirects to `169.254.169.254` → blocked after redirect
- [ ] `send_message` with a 30 MiB `filesJson` url → rejected on the size cap
- [ ] server bound to 127.0.0.1 by default (`ss -ltnp | grep 8085`)

## smartbot end-to-end

- [ ] `send_message` with embeds + link button via a chat request; reply with NO_REPLY suppression works
- [ ] posting `@everyone` as a non-moderator → smartbot denies (POSTING_TOOLS guard, unchanged)
- [ ] new tools need `permissions.py` entries — without them smartbot requires administrator by default
