import type { Message } from 'discord.js';
import { isoTime } from './context.js';

export interface FormatMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdTimestamp: number;
  attachments: { name: string; url: string; contentType?: string; size?: number }[];
  embeds: Record<string, unknown>[];
  components: Record<string, unknown>[];
  reference: { messageId?: string; type?: number } | null;
  poll: { question: string; votes: number; answers: number } | null;
  stickers: string[];
}

/** Convert a raw REST message object (search/pins) into the formatting shape. */
export function normalizeApiMessage(raw: Record<string, unknown>): FormatMessage {
  const author = (raw.author ?? {}) as Record<string, unknown>;
  const ref = raw.message_reference as { message_id?: string; type?: number } | undefined;
  const pollRaw = raw.poll as Record<string, unknown> | undefined;
  let poll: FormatMessage['poll'] = null;
  if (pollRaw) {
    const question = (pollRaw.question as { text?: string })?.text ?? '';
    const answers = (pollRaw.answers as Array<Record<string, unknown>>) ?? [];
    let votes = 0;
    for (const a of answers) votes += Number(a.count ?? 0);
    poll = { question, votes, answers: answers.length };
  }
  return {
    id: String(raw.id ?? ''),
    authorId: String(author.id ?? '?'),
    authorName: String(author.global_name ?? author.username ?? 'unknown'),
    content: String(raw.content ?? ''),
    createdTimestamp: Date.parse(String(raw.timestamp ?? '')) || 0,
    attachments: ((raw.attachments as Array<Record<string, unknown>>) ?? []).map((a) => ({
      name: String(a.filename ?? a.name ?? 'file'),
      url: String(a.url ?? ''),
      contentType: a.content_type ? String(a.content_type) : undefined,
      size: typeof a.size === 'number' ? a.size : undefined,
    })),
    embeds: (raw.embeds as Array<Record<string, unknown>>) ?? [],
    components: (raw.components as Array<Record<string, unknown>>) ?? [],
    reference: ref ? { messageId: ref.message_id ? String(ref.message_id) : undefined, type: ref.type } : null,
    poll,
    stickers: ((raw.sticker_items as Array<Record<string, unknown>>) ?? []).map((s) => String(s.name ?? '')),
  };
}

/** Convert a discord.js Message into the formatting shape. */
export function fromDiscordMessage(m: Message): FormatMessage {
  let poll: FormatMessage['poll'] = null;
  if (m.poll) {
    const answers = [...(m.poll.answers?.values() ?? [])] as Array<{ count?: number }>;
    poll = {
      question: m.poll.question?.text ?? '',
      votes: answers.reduce((acc, a) => acc + (a.count ?? 0), 0),
      answers: answers.length,
    };
  }
  return {
    id: m.id,
    authorId: m.author.id,
    authorName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
    content: m.content ?? '',
    createdTimestamp: m.createdTimestamp,
    attachments: [...m.attachments.values()].map((a) => ({
      name: a.name,
      url: a.url,
      contentType: a.contentType ?? undefined,
      size: a.size,
    })),
    embeds: m.embeds.map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
    })),
    components: (m.components as unknown as Array<Record<string, unknown>>) ?? [],
    reference: m.reference
      ? { messageId: m.reference.messageId, type: (m.reference as { type?: number }).type }
      : null,
    poll,
    stickers: m.stickers.map((s) => s.name ?? ''),
  };
}

function componentSummary(components: Record<string, unknown>[]): string {
  let buttons = 0;
  let selects = 0;
  const walk = (nodes: Record<string, unknown>[]): void => {
    for (const node of nodes) {
      const type = node.type as number | undefined;
      if (type === 2) buttons++;
      else if (type === 3 || type === 5 || type === 6 || type === 7 || type === 8) selects++;
      const children = node.components as Record<string, unknown>[] | undefined;
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(components);
  const parts: string[] = [];
  if (buttons) parts.push(`${buttons} button${buttons > 1 ? 's' : ''}`);
  if (selects) parts.push(`${selects} select${selects > 1 ? 's' : ''}`);
  return parts.join(', ');
}

function embedSummary(embed: Record<string, unknown>): string {
  const title = typeof embed.title === 'string' ? embed.title : '';
  const desc = typeof embed.description === 'string' ? embed.description : '';
  const descTrimmed = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
  return [title, descTrimmed].filter(Boolean).join(' — ') || '(no title)';
}

/**
 * One line per message:
 * [iso time] Display Name (id 123) [msg 456]: content [embed: ...] [components: ...] ...
 */
export function formatMessageLine(m: FormatMessage): string {
  const markers: string[] = [];
  if (m.embeds.length) markers.push(`[embed: ${embedSummary(m.embeds[0]!)}]`);
  const comp = componentSummary(m.components);
  if (comp) markers.push(`[components: ${comp}]`);
  if (m.poll) markers.push(`[poll: ${m.poll.question} (${m.poll.votes} votes)]`);
  for (const a of m.attachments) markers.push(`[attachment: ${a.name} ${a.url}]`);
  if (m.reference?.type === 1) markers.push('[forwarded]');
  else if (m.reference?.messageId) markers.push(`[reply to ${m.reference.messageId}]`);
  for (const s of m.stickers) markers.push(`[sticker: ${s}]`);
  const content = m.content || markers.shift() || '(empty)';
  const extra = markers.length ? ` ${markers.join(' ')}` : '';
  return `[${isoTime(m.createdTimestamp)}] ${m.authorName} (id ${m.authorId}) [msg ${m.id}]: ${content}${extra}`;
}

/** Truncate to a budget (MCP clients commonly cap tool results at 6000 chars). */
export function truncate(text: string, max = 6000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n…(truncated)`;
}

/** Format a channel for lists. */
export function formatChannelLine(c: {
  id: string;
  name: string;
  type: number;
  topic?: string | null;
  parentId?: string | null;
}): string {
  const topic = c.topic ? ` — ${c.topic.slice(0, 80)}` : '';
  return `#${c.name} (id ${c.id}, type ${c.type})${topic}`;
}

/** Format a role for lists. */
export function formatRoleLine(r: {
  id: string;
  name: string;
  color: number;
  position: number;
  managed?: boolean;
  members?: number;
}): string {
  const attrs: string[] = [`id ${r.id}`, `pos ${r.position}`, `#${r.color.toString(16).padStart(6, '0')}`];
  if (r.managed) attrs.push('managed');
  if (r.members !== undefined) attrs.push(`${r.members} members`);
  return `@${r.name} (${attrs.join(', ')})`;
}

/** Format a member/user for lists. */
export function formatUserLine(u: {
  id: string;
  username: string;
  displayName?: string;
  bot?: boolean;
}): string {
  const name = u.displayName && u.displayName !== u.username ? `${u.displayName} (@${u.username})` : `@${u.username}`;
  return `${name} (id ${u.id}${u.bot ? ', bot' : ''})`;
}

/** Short confirmation footer used by many tools. */
export function jumpLine(label: string, id: string, channelId: string, guildId?: string): string {
  return `${label} https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${id}`;
}
