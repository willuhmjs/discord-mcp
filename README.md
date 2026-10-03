# discord-mcp

[![npm](https://img.shields.io/npm/v/@willuhmjs/discord-mcp)](https://www.npmjs.com/package/@willuhmjs/discord-mcp)
[![CI](https://github.com/willuhmjs/discord-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/willuhmjs/discord-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An MCP server that lets an LLM run a Discord server: **168 tools** for messages, moderation, channels,
roles, threads, events, invites, webhooks, AutoMod and more. Works with Claude, Cursor, VS Code, or any
MCP client.

- **Rich messages**: embeds, Components V2, polls, files, replies — validated before they reach Discord,
  with errors that name the bad field.
- **Interactions**: role menus that survive restarts, plus a log of who clicked what.
- **Secure by default**: binds to `127.0.0.1`, SSRF-guarded URL fetching, webhook tokens never echoed.

## Quick start

1. Create a bot in the [developer portal](https://discord.com/developers/applications), invite it to your
   server, and enable the **Message Content** intent (*Bot → Privileged Gateway Intents*).
2. Add this to your MCP client's config (`mcp.json`, `claude_desktop_config.json`, `.cursor/mcp.json`, ...):

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "@willuhmjs/discord-mcp", "--stdio"],
      "env": {
        "DISCORD_TOKEN": "your-bot-token",
        "DISCORD_GUILD_ID": "your-server-id"
      }
    }
  }
}
```

VS Code uses `"servers"` instead of `"mcpServers"`. On Windows, if the client can't find `npx`, use
`"command": "cmd"` with `"args": ["/c", "npx", "-y", "@willuhmjs/discord-mcp", "--stdio"]`.

**Claude Code** — one command:

```bash
claude mcp add discord -e DISCORD_TOKEN=... -e DISCORD_GUILD_ID=... -- npx -y @willuhmjs/discord-mcp --stdio
```

**Docker** — a long-running HTTP server at `http://127.0.0.1:8085/mcp`:

```bash
docker run --rm -e DISCORD_TOKEN=... -p 127.0.0.1:8085:8085 ghcr.io/willuhmjs/discord-mcp
```

Requires Node.js 22+ for `npx`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | — (required) | Bot token. |
| `DISCORD_GUILD_ID` | — | Default server for tools when `guildId` is omitted. |
| `ENABLE_MEMBERS_INTENT` | off | Enables the privileged Server Members intent (also enable it in the portal). Member-list tools need it. |
| `MCP_TRANSPORT` | `http` | `stdio` for stdin/stdout. The `--stdio` flag does the same. |
| `HOST` / `PORT` | `127.0.0.1` / `8085` | HTTP bind address and port. |
| `MCP_SOCKET` | — | Listen on a Unix socket instead of `HOST:PORT` (HTTP mode only). |

In HTTP mode, `POST /mcp` serves MCP (stateful sessions via `Mcp-Session-Id`) and `GET /health` returns
`200` once the bot is connected.

## Keeping the HTTP endpoint private

The HTTP endpoint has **no authentication**: anyone who can reach it can use every tool as the bot. Keep it
on loopback or a private network. On a shared machine, other accounts can still reach a loopback port, so
use a Unix socket that only you can open:

```bash
mkdir -m 700 ~/.mcp
MCP_SOCKET=~/.mcp/discord.sock DISCORD_TOKEN=... npx @willuhmjs/discord-mcp
curl --unix-socket ~/.mcp/discord.sock http://localhost/health
```

The socket is created with mode 600. Avoid network file systems such as NFS. The Docker image binds
`0.0.0.0`, so keep that container on an internal network. `stdio` mode has no network exposure at all.

## Tools

Every tool, with its parameters and the Discord permission it needs, is listed in
**[docs/TOOLS.md](https://github.com/willuhmjs/discord-mcp/blob/main/docs/TOOLS.md)**, along with the
conventions (string IDs, JSON-string payloads, `reason` for the audit log) and message/component formats.

## Security

- Every URL a tool fetches (emoji, stickers, files, avatars) goes through one guarded fetcher: http/https
  only, private/loopback/metadata IPs blocked before the request and after every redirect, size and
  time limits.
- Webhook tokens are credentials: `create_webhook` returns the URL once, and no list/get tool shows it.
- No tool reads the server's filesystem.

## Development

```bash
npm ci
npm run build       # tsc -> dist/
npm test            # vitest, no Discord token needed
npm run typecheck
```

A contract test locks every tool name and parameter set against `tests/fixtures/tool-contract.json`.
`TESTING.md` is the manual checklist for a run in a real test server.

Releases are automated: commits on `main` using [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `feat!:`) feed a release PR; merging it publishes to npm, the MCP Registry and GHCR.

## License

MIT
