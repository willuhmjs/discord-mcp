# Interactions

Self-service role menus (handled automatically via `mcp:` custom ids — no state, survives restarts) and the interaction log.

| Tool | Key params | Requester permission |
| --- | --- | --- |
| `create_role_menu` | `channelId`, `roles` (JSON array `[{roleId, label, emoji?, description?}]`, 1–25 entries) or `roleIds` (comma-separated), `style` (`buttons` \| `select`), `title?`, `description?`, `embedColor?` | Manage Roles |
| `list_interactions` | `channelId?`, `sinceMinutes?` (1–1440, default 30) | — (read-only, `readOnlyHint` annotation) |
