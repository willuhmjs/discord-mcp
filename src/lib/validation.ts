import { ValidationError } from './errors.js';
import { assertSnowflake } from './context.js';

/** Parse a JSON-string tool parameter, naming the parameter on failure. */
export function parseJsonParam<T = unknown>(name: string, value: string | undefined | null): T | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${name}: empty JSON string`);
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new ValidationError(`${name}: invalid JSON — ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Embeds
// ---------------------------------------------------------------------------

export interface EmbedFieldInput {
  name?: unknown;
  value?: unknown;
  inline?: unknown;
}

export interface EmbedInput {
  title?: unknown;
  description?: unknown;
  url?: unknown;
  timestamp?: unknown;
  color?: unknown;
  footer?: { text?: unknown; icon_url?: unknown; [k: string]: unknown };
  image?: { url?: unknown; [k: string]: unknown };
  thumbnail?: { url?: unknown; [k: string]: unknown };
  author?: { name?: unknown; url?: unknown; icon_url?: unknown; [k: string]: unknown };
  fields?: unknown;
  [k: string]: unknown;
}

export interface NormalizedEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

const EMBED_TOTAL_LIMIT = 6000;

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return String(value);
}

function checkLen(path: string, value: string, max: number): string {
  if (value.length > max) throw new ValidationError(`${path}: ${value.length} chars > ${max}`);
  return value;
}

/** Parse a color given as an integer or "#RRGGBB" string. */
export function normalizeColor(path: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 0 || value > 0xffffff) throw new ValidationError(`${path}: ${value} is outside 0–16777215`);
    return value;
  }
  if (typeof value === 'string') {
    const m = value.trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) throw new ValidationError(`${path}: "${value}" is not an integer or #RRGGBB color`);
    return Number.parseInt(m[1]!, 16);
  }
  throw new ValidationError(`${path}: must be an integer or #RRGGBB string`);
}

function normalizeTimestamp(path: string, value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError(`${path}: must be an ISO 8601 string or "now"`);
  if (value.trim().toLowerCase() === 'now') return new Date().toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${path}: "${value}" is not a valid ISO 8601 date`);
  return d.toISOString();
}

/** Validate + normalize one embed object (shape: raw Discord API embed). */
export function normalizeEmbed(value: unknown, path: string): NormalizedEmbed {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${path}: must be a JSON object`);
  }
  const raw = value as EmbedInput;
  const out: NormalizedEmbed = {};
  if (raw.title !== undefined) out.title = checkLen(`${path}.title`, str(raw.title) ?? '', 256);
  if (raw.description !== undefined) out.description = checkLen(`${path}.description`, str(raw.description) ?? '', 4096);
  if (raw.url !== undefined) {
    const u = str(raw.url);
    if (!u || !/^https?:\/\//.test(u)) throw new ValidationError(`${path}.url: must be an http(s) URL`);
    out.url = u;
  }
  if (raw.timestamp !== undefined) out.timestamp = normalizeTimestamp(`${path}.timestamp`, raw.timestamp);
  if (raw.color !== undefined) out.color = normalizeColor(`${path}.color`, raw.color);
  if (raw.footer !== undefined) {
    if (typeof raw.footer !== 'object') throw new ValidationError(`${path}.footer: must be an object {text, icon_url?}`);
    const text = str(raw.footer.text);
    if (text === undefined) throw new ValidationError(`${path}.footer.text: required`);
    checkLen(`${path}.footer.text`, text, 2048);
    const footer: { text: string; icon_url?: string } = { text };
    const icon = str(raw.footer.icon_url);
    if (icon !== undefined) footer.icon_url = icon;
    out.footer = footer;
  }
  if (raw.image !== undefined) {
    const url = str((raw.image as { url?: unknown })?.url);
    if (url === undefined) throw new ValidationError(`${path}.image.url: required`);
    out.image = { url };
  }
  if (raw.thumbnail !== undefined) {
    const url = str((raw.thumbnail as { url?: unknown })?.url);
    if (url === undefined) throw new ValidationError(`${path}.thumbnail.url: required`);
    out.thumbnail = { url };
  }
  if (raw.author !== undefined) {
    if (typeof raw.author !== 'object') throw new ValidationError(`${path}.author: must be an object {name, url?, icon_url?}`);
    const name = str(raw.author.name);
    if (name === undefined) throw new ValidationError(`${path}.author.name: required`);
    checkLen(`${path}.author.name`, name, 256);
    const author: { name: string; url?: string; icon_url?: string } = { name };
    const au = str(raw.author.url); if (au !== undefined) author.url = au;
    const ai = str(raw.author.icon_url); if (ai !== undefined) author.icon_url = ai;
    out.author = author;
  }
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) throw new ValidationError(`${path}.fields: must be an array`);
    if (raw.fields.length > 25) throw new ValidationError(`${path}.fields: ${raw.fields.length} fields > 25`);
    out.fields = raw.fields.map((f, i) => {
      const field = f as EmbedFieldInput;
      const name = str(field?.name);
      const val = str(field?.value);
      if (name === undefined || val === undefined) {
        throw new ValidationError(`${path}.fields[${i}]: both name and value are required`);
      }
      return {
        name: checkLen(`${path}.fields[${i}].name`, name, 256),
        value: checkLen(`${path}.fields[${i}].value`, val, 1024),
        ...(typeof field.inline === 'boolean' ? { inline: field.inline } : {}),
      };
    });
  }
  return out;
}

function embedCharCount(e: NormalizedEmbed): number {
  let n = 0;
  if (e.title) n += e.title.length;
  if (e.description) n += e.description.length;
  if (e.footer) n += e.footer.text.length;
  if (e.author) n += e.author.name.length;
  for (const f of e.fields ?? []) n += f.name.length + f.value.length;
  return n;
}

/** Validate an array of embeds: max 10, per-field limits, 6000 total chars. */
export function normalizeEmbeds(value: unknown, path = 'embedsJson'): NormalizedEmbed[] {
  if (!Array.isArray(value)) throw new ValidationError(`${path}: must be a JSON array of embed objects`);
  if (value.length > 10) throw new ValidationError(`${path}: ${value.length} embeds > 10`);
  if (!value.length) throw new ValidationError(`${path}: at least one embed required`);
  const embeds = value.map((e, i) => normalizeEmbed(e, `${path}[${i}]`));
  const total = embeds.reduce((acc, e) => acc + embedCharCount(e), 0);
  if (total > EMBED_TOTAL_LIMIT) {
    throw new ValidationError(`${path}: ${total} chars total > ${EMBED_TOTAL_LIMIT} across all embeds`);
  }
  return embeds;
}

// ---------------------------------------------------------------------------
// Components (V1 action rows + V2)
// ---------------------------------------------------------------------------

const VALID_COMPONENT_TYPES = new Set([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]);
const V1_TOP_LEVEL = new Set([1, 17]); // action row, container
const V1_CHILDREN = new Set([2, 3, 5, 6, 7, 8]); // button, string/user/role/mentionable/channel select

/** Light validation on raw component JSON — discord.js/Discord validates the rest. */
export function validateComponents(value: unknown, path = 'componentsJson'): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${path}: must be a JSON array of components`);
  const flatCount = countComponents(value);
  if (flatCount > 40) throw new ValidationError(`${path}: ${flatCount} components total > 40`);
  validateComponentNodes(value, path, true);
  return value;
}

function countComponents(nodes: unknown[]): number {
  let n = 0;
  for (const node of nodes) {
    n++;
    const children = childrenOf(node);
    if (children.length) n += countComponents(children);
  }
  return n;
}

function childrenOf(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.components)) return obj.components;
  return [];
}

function validateComponentNodes(nodes: unknown[], path: string, top: boolean): void {
  nodes.forEach((node, i) => {
    const here = `${path}[${i}]`;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new ValidationError(`${here}: must be a component object`);
    }
    const obj = node as Record<string, unknown>;
    const type = obj.type;
    if (typeof type !== 'number' || !VALID_COMPONENT_TYPES.has(type)) {
      throw new ValidationError(
        `${here}.type: ${JSON.stringify(type)} is not a valid component type ` +
          '(1 action row, 2 button, 3/5/6/7/8 selects, 9 section, 10 text display, 11 thumbnail, ' +
          '12 media gallery, 13 file, 14 separator, 17 container)',
      );
    }
    if (top && !V1_TOP_LEVEL.has(type)) {
      throw new ValidationError(`${here}.type: top-level components must be action rows (1) or containers (17), got ${type}`);
    }
    if (type === 1) {
      const children = childrenOf(node);
      if (children.length > 5) throw new ValidationError(`${here}: action rows hold at most 5 components`);
      if (children.length !== 1 && children.some((c) => typeof c === 'object' && c !== null && ![2].includes((c as {type?: unknown}).type as number))) {
        throw new ValidationError(`${here}: buttons can share a row, but a select menu must be alone`);
      }
      validateComponentNodes(children, `${here}.components`, false);
    }
    if (type === 2) {
      const style = obj.style;
      if (typeof style !== 'number' || style < 1 || style > 5) {
        throw new ValidationError(`${here}.style: button style must be 1–5`);
      }
      if (style === 5 && typeof obj.url !== 'string') throw new ValidationError(`${here}.url: link buttons (style 5) need a url`);
      if (style !== 5 && typeof obj.custom_id !== 'string') {
        throw new ValidationError(`${here}.custom_id: interactive buttons need a custom_id`);
      }
      const label = obj.label;
      if (label !== undefined && typeof label === 'string' && label.length > 80) {
        throw new ValidationError(`${here}.label: ${label.length} chars > 80`);
      }
      if (typeof obj.custom_id === 'string' && obj.custom_id.length > 100) {
        throw new ValidationError(`${here}.custom_id: ${String(obj.custom_id).length} chars > 100`);
      }
    }
    if (type === 17 && obj.accent_color !== undefined) {
      normalizeColor(`${here}.accent_color`, obj.accent_color);
    }
    const children = childrenOf(node);
    if (children.length) validateComponentNodes(children, `${here}.components`, false);
  });
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export interface PollAnswerInput {
  poll_media?: { text?: unknown; emoji?: unknown };
}

export interface NormalizedPoll {
  question: { text: string };
  answers: { poll_media: { text: string; emoji?: unknown } }[];
  duration: number;
  allow_multiselect: boolean;
  layout_type: number;
}

/** Validate pollJson: {question:{text}, answers:[{poll_media:{text, emoji?}}], duration, allow_multiselect, layout_type}. */
export function validatePoll(value: unknown, path = 'pollJson'): NormalizedPoll {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${path}: must be a JSON object`);
  }
  const raw = value as Record<string, unknown>;
  const question = raw.question as { text?: unknown } | undefined;
  const qtext = str(question?.text);
  if (qtext === undefined || !qtext.trim()) throw new ValidationError(`${path}.question.text: required`);
  if (qtext.length > 300) throw new ValidationError(`${path}.question.text: ${qtext.length} chars > 300`);

  const answers = raw.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new ValidationError(`${path}.answers: at least one answer required`);
  }
  if (answers.length > 10) throw new ValidationError(`${path}.answers: ${answers.length} answers > 10`);

  const normalizedAnswers = answers.map((a, i) => {
    const media = (a as PollAnswerInput)?.poll_media;
    const text = str(media?.text) ?? '';
    if (text.length > 55) throw new ValidationError(`${path}.answers[${i}].poll_media.text: ${text.length} chars > 55`);
    const out: { poll_media: { text: string; emoji?: unknown } } = { poll_media: { text } };
    if (media && 'emoji' in media) out.poll_media.emoji = media.emoji;
    return out;
  });

  let duration = 24;
  if (raw.duration !== undefined) {
    if (typeof raw.duration !== 'number' || !Number.isInteger(raw.duration) || raw.duration < 1 || raw.duration > 768) {
      throw new ValidationError(`${path}.duration: must be whole hours between 1 and 768`);
    }
    duration = raw.duration;
  }
  const multiselect = raw.allow_multiselect === undefined ? false : Boolean(raw.allow_multiselect);
  const layout = raw.layout_type === undefined ? 1 : Number(raw.layout_type);

  return {
    question: { text: qtext },
    answers: normalizedAnswers,
    duration,
    allow_multiselect: multiselect,
    layout_type: layout,
  };
}

// ---------------------------------------------------------------------------
// Stickers, allowed mentions, files
// ---------------------------------------------------------------------------

/** Validate stickerIds: at most 3 snowflakes. */
export function validateStickerIds(ids: string[] | undefined, path = 'stickerIds'): string[] {
  if (!ids || !ids.length) return [];
  if (ids.length > 3) throw new ValidationError(`${path}: ${ids.length} stickers > 3`);
  return ids.map((id, i) => {
    try {
      return assertSnowflake(`${path}[${i}]`, id);
    } catch (err) {
      throw new ValidationError((err as ValidationError).message);
    }
  });
}

export type AllowedMentionsMode = 'users' | 'users_roles' | 'all' | 'none';

export type MentionTarget = 'users' | 'roles' | 'everyone';

/** Map the allowedMentions param to discord.js allowedMentions. */
export function normalizeAllowedMentions(mode: string | undefined): {
  parse: MentionTarget[];
  repliedUser: boolean;
} {
  switch (mode) {
    case undefined:
    case '':
    case 'users':
      return { parse: ['users'], repliedUser: false };
    case 'users_roles':
      return { parse: ['users', 'roles'], repliedUser: false };
    case 'all':
      return { parse: ['users', 'roles', 'everyone'], repliedUser: false };
    case 'none':
      return { parse: [], repliedUser: false };
    default:
      throw new ValidationError(
        `allowedMentions: "${mode}" must be one of users, users_roles, all, none`,
      );
  }
}

export interface FileSpec {
  url?: string;
  base64?: string;
  filename?: string;
  description?: string;
  spoiler?: boolean;
}

/** Validate filesJson entries: [{url} or {base64, filename?, description?, spoiler?}]. */
export function validateFileSpecs(value: unknown, path = 'filesJson'): FileSpec[] {
  if (!Array.isArray(value)) throw new ValidationError(`${path}: must be a JSON array of {url} or {base64, filename} objects`);
  if (!value.length) throw new ValidationError(`${path}: at least one file required`);
  return value.map((f, i) => {
    const here = `${path}[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new ValidationError(`${here}: must be an object`);
    const raw = f as Record<string, unknown>;
    const url = str(raw.url);
    const base64 = str(raw.base64);
    if ((url === undefined) === (base64 === undefined)) {
      throw new ValidationError(`${here}: provide exactly one of url or base64`);
    }
    const filename = str(raw.filename);
    const description = str(raw.description);
    const spoiler = raw.spoiler === undefined ? undefined : Boolean(raw.spoiler);
    if (base64 !== undefined && filename === undefined) {
      throw new ValidationError(`${here}.filename: required when using base64`);
    }
    return {
      ...(url !== undefined ? { url } : { base64 }),
      ...(filename !== undefined ? { filename } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(spoiler !== undefined ? { spoiler } : {}),
    };
  });
}

/** Decode a data-URI or raw base64 image string into a data URI Discord accepts. */
export function imageToDataUri(input: string, path: string): string {
  const value = input.trim();
  if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(value)) return value;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length > 32) {
    return `data:image/png;base64,${value}`;
  }
  throw new ValidationError(`${path}: must be a base64 data URI (data:image/png;base64,...) or raw base64`);
}
