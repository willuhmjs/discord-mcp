import { DiscordAPIError, DiscordjsError, HTTPError } from 'discord.js';

/** A validation failure caused by bad tool input. Message already names the offending field. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when a required intent is not enabled. */
export class IntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentError';
  }
}

const CODE_HINTS: Record<number, string> = {
  10001: 'Unknown Account: the user no longer exists.',
  10002: 'Unknown Channel: the channel does not exist, was deleted, or the bot cannot see it.',
  10003: 'Unknown Guild: the bot is not in that server (or the ID is wrong).',
  10004: 'Unknown Member: that user is not a member of this server.',
  10005: 'Unknown Role: the role does not exist.',
  10006: 'Unknown Invite: the invite code is invalid or expired.',
  10008: 'Unknown Message: the message was deleted, is too old, or is in a channel the bot cannot see.',
  10009: 'Unknown Ban: that user is not banned.',
  10011: 'Unknown Emoji: the emoji does not exist on this server.',
  10012: 'Unknown Sticker: the sticker does not exist.',
  10015: 'Unknown Webhook: the webhook does not exist or was deleted.',
  10062: 'Unknown Guild Scheduled Event: the event does not exist.',
  20012: 'Not authorized: only the server owner can perform this action.',
  30007: 'Too many pinned messages in that channel.',
  50001: 'Missing Access: the bot lacks access to that channel or server (View Channel permission).',
  50005: 'Cannot edit a message authored by another user. The bot can only edit its own messages.',
  50006: 'Empty message: Discord rejected it (missing content, embeds, files or components).',
  50007: 'Cannot send a message to that user: they have DMs closed or blocked the bot.',
  50013:
    'Missing Permissions: the bot lacks the required permission, or the target is at/above its highest role. ' +
    'Check the bot\'s role position and permissions.',
  50014: 'Invalid authentication token.',
  50021: 'Cannot execute that action on a non-text channel.',
  50023: 'Cannot execute action on a system channel message type.',
  50033: 'This message cannot be edited (it is not editable).',
  50035: 'Invalid Form Body',
  50041: 'Invalid guild: you cannot perform this action on that server.',
  50045: 'Request too old: bulk actions require messages younger than 14 days.',
  50074: 'Cannot convert that value: check the argument format.',
  130000: 'That integration cannot be modified.',
  220001: 'Message blocked by AutoMod.',
  500143: 'Invalid Form Body (asset).',
};

function describeApiError(err: DiscordAPIError): string {
  const code = err.code as number | undefined;
  const hint = code !== undefined ? CODE_HINTS[code] : undefined;
  let detail = err.message;
  if (code === 50035) {
    detail = describeFormBody((err as unknown as { body?: unknown }).body);
  }
  const parts = [`Discord API error ${code ?? '?'} (HTTP ${err.status}): ${detail}`];
  if (hint && hint !== 'Invalid Form Body') parts.push(hint);
  return parts.join(' — ');
}

function describeFormBody(body: unknown, prefix = ''): string {
  // 50035 bodies look like { _errors: [{code, message}] } or { field: {...} }
  const lines: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, path ? `${path}[${i}]` : `[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const errs = obj._errors;
      if (Array.isArray(errs)) {
        for (const e of errs) {
          const msg = e && typeof e === 'object' && 'message' in e ? String((e as {message: unknown}).message) : JSON.stringify(e);
          lines.push(`${path || 'body'}: ${msg}`);
        }
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key !== '_errors') walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(body, prefix);
  return lines.length ? lines.slice(0, 8).join('; ') : 'request body rejected';
}

/** Map any thrown value to a readable one-line-ish error string for MCP tool results. */
export function formatError(err: unknown): string {
  if (err instanceof ValidationError || err instanceof IntentError) {
    return err.message;
  }
  if (err instanceof DiscordAPIError) {
    return describeApiError(err);
  }
  if (err instanceof DiscordjsError) {
    return `Discord error ${err.code}: ${err.message}`;
  }
  if (err instanceof HTTPError) {
    return `Network error talking to Discord: ${err.message} (HTTP ${err.status})`;
  }
  if (err instanceof Error) {
    const msg = err.message || String(err);
    if (err.stack && process.env.DEBUG) return `${msg}\n${err.stack}`;
    return msg;
  }
  return String(err);
}
