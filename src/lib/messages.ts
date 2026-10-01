import { AttachmentBuilder, MessageFlags, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import { z } from 'zod';
import { ValidationError } from './errors.js';
import { guardedFetch, FILE_TYPES, type GuardedFetchOptions } from './fetch.js';
import { booleanParam, jsonParam } from './register.js';
import {
  normalizeEmbeds,
  normalizeAllowedMentions,
  parseJsonParam,
  validateComponents,
  validateFileSpecs,
  validatePoll,
  validateStickerIds,
  type FileSpec,
  type NormalizedEmbed,
} from './validation.js';

const CONTENT_LIMIT = 2000;
const REQUEST_LIMIT = 25 * 1024 * 1024;

/** Shared input shape for every posting tool's rich-message params. */
export const richSendShape = {
  message: z.string().optional().describe('Message text content (max 2000 chars)'),
  embedsJson: jsonParam(
    'Embeds',
    'Array: [{title, description, url, timestamp, color, footer:{text,icon_url}, image:{url}, thumbnail:{url}, author:{name,url,icon_url}, fields:[{name,value,inline}]}]. Max 10 embeds, 6000 chars total.',
  ),
  componentsJson: jsonParam(
    'Components',
    'Array of raw Discord component JSON: action rows (type 1) holding buttons (type 2) or selects (3/5/6/7/8), or Components V2 types (9 section, 10 text display, 11 thumbnail, 12 media gallery, 13 file, 14 separator, 17 container).',
  ),
  componentsV2: booleanParam('Send as a Components V2 message (components only; no content/embeds/stickers/poll)'),
  pollJson: jsonParam(
    'Poll',
    '{question:{text}, answers:[{poll_media:{text, emoji?}}] (max 10), duration (hours 1-768, default 24), allow_multiselect}. Polls cannot be edited later.',
  ),
  replyToMessageId: z
    .string()
    .optional()
    .describe('Message ID to reply to'),
  stickerIds: z.array(z.string()).optional().describe('Up to 3 sticker IDs to send with the message'),
  filesJson: jsonParam(
    'Files',
    'Array: [{url, filename?, description?, spoiler?} or {base64, filename, description?, spoiler?}]. attachment://filename can be referenced from embeds.',
  ),
  allowedMentions: z
    .enum(['users', 'users_roles', 'all', 'none'])
    .optional()
    .describe('Who this message may ping (default "users")'),
  silent: booleanParam('Suppress notification for this message'),
  suppressEmbeds: booleanParam('Hide embed link previews on this message'),
};

/** Shared input shape for edit tools' rich params. */
export const richEditShape = {
  newMessage: z.string().optional().describe('New message text content'),
  embedsJson: richSendShape.embedsJson,
  componentsJson: richSendShape.componentsJson,
  componentsV2: richSendShape.componentsV2,
  keepAttachments: booleanParam('Keep the message\u2019s existing attachments'),
  suppressEmbeds: richSendShape.suppressEmbeds,
};

export interface RichSendParams {
  /** Message text content. */
  message?: string;
  embedsJson?: string;
  componentsJson?: string;
  /** Send as a Components V2 message (components only). */
  componentsV2?: boolean;
  pollJson?: string;
  replyToMessageId?: string;
  stickerIds?: string[];
  filesJson?: string;
  allowedMentions?: string;
  silent?: boolean;
  suppressEmbeds?: boolean;
}

/** discord.js-ready send options; the raw JSON shapes were validated above. */
export type BuiltSendOptions = MessageCreateOptions;

/** Total payload size guard (Discord caps the whole request at 25 MiB). */
function assertRequestSize(files: AttachmentBuilder[]): void {
  let total = 0;
  for (const f of files) {
    const attachment = f.attachment as Buffer | string;
    if (Buffer.isBuffer(attachment)) total += attachment.byteLength;
  }
  if (total > REQUEST_LIMIT) {
    throw new ValidationError(
      `filesJson: ${(total / 1024 / 1024).toFixed(1)} MiB of files exceeds the 25 MiB total request limit`,
    );
  }
}

async function filesFromSpecs(specs: FileSpec[]): Promise<AttachmentBuilder[]> {
  const out: AttachmentBuilder[] = [];
  for (const spec of specs) {
    let buffer: Buffer;
    let name: string;
    if (spec.url) {
      const fetched = await guardedFetch(spec.url, {
        allowedTypes: FILE_TYPES,
        maxBytes: REQUEST_LIMIT,
      } satisfies GuardedFetchOptions);
      buffer = fetched.data;
      const fromUrl = new URL(fetched.url).pathname.split('/').pop() || 'file';
      name = spec.filename || decodeURIComponent(fromUrl).slice(0, 120) || 'file';
    } else {
      const raw = spec.base64!.replace(/^data:[^;]+;base64,/, '');
      try {
        buffer = Buffer.from(raw, 'base64');
      } catch {
        throw new ValidationError('filesJson: invalid base64 data');
      }
      name = spec.filename!;
    }
    const builder = new AttachmentBuilder(buffer, {
      name: spec.spoiler ? `SPOILER_${name}` : name,
      description: spec.description,
    });
    out.push(builder);
  }
  return out;
}

function buildFlags(params: RichSendParams, isV2: boolean): number {
  let flags = 0;
  if (isV2) flags |= MessageFlags.IsComponentsV2;
  if (params.silent) flags |= MessageFlags.SuppressNotifications;
  if (params.suppressEmbeds) flags |= MessageFlags.SuppressEmbeds;
  return flags;
}

/**
 * Shared validation + payload construction for every posting tool
 * (send_message, send_private_message, send_webhook_message, create_forum_post).
 * Rejects invalid input before anything reaches Discord.
 */
export async function buildSendOptions(params: RichSendParams): Promise<BuiltSendOptions> {
  const content = params.message !== undefined && params.message !== '' ? params.message : undefined;
  if (content && content.length > CONTENT_LIMIT) {
    throw new ValidationError(`message: ${content.length} chars > ${CONTENT_LIMIT}`);
  }

  const embeds = params.embedsJson ? normalizeEmbeds(parseJsonParam('embedsJson', params.embedsJson)) : undefined;
  const components = params.componentsJson
    ? validateComponents(parseJsonParam('componentsJson', params.componentsJson))
    : undefined;
  const poll = params.pollJson ? validatePoll(parseJsonParam('pollJson', params.pollJson)) : undefined;
  const stickers = validateStickerIds(params.stickerIds);
  const fileSpecs = params.filesJson ? validateFileSpecs(parseJsonParam('filesJson', params.filesJson)) : undefined;
  const files = fileSpecs ? await filesFromSpecs(fileSpecs) : undefined;

  const isV2 = Boolean(params.componentsV2);
  if (isV2) {
    if (!components || !components.length) {
      throw new ValidationError('componentsV2: componentsJson with at least one container is required');
    }
    if (content || embeds || stickers.length || poll) {
      throw new ValidationError(
        'componentsV2: a Components V2 message may contain only components — ' +
          'remove message, embedsJson, stickerIds and pollJson',
      );
    }
  } else if (!content && !embeds && !components && !poll && !stickers.length && !files?.length) {
    throw new ValidationError(
      'empty message: provide at least one of message, embedsJson, componentsJson, pollJson, stickerIds, filesJson',
    );
  }

  if (files?.length) assertRequestSize(files);

  const options: BuiltSendOptions = {
    allowedMentions: normalizeAllowedMentions(params.allowedMentions),
  };
  if (content) options.content = content;
  if (embeds) options.embeds = embeds;
  if (components) options.components = components as unknown as NonNullable<MessageCreateOptions['components']>;
  if (poll) options.poll = poll as unknown as NonNullable<MessageCreateOptions['poll']>;
  if (stickers.length) options.stickers = stickers;
  if (files?.length) options.files = files;
  if (params.replyToMessageId) {
    if (!/^\d{15,21}$/.test(params.replyToMessageId)) {
      throw new ValidationError('replyToMessageId: not a valid message ID');
    }
    options.reply = { messageReference: params.replyToMessageId, failIfNotExists: false };
  }
  const flags = buildFlags(params, isV2);
  if (flags) options.flags = flags as MessageCreateOptions['flags'];
  return options;
}

export interface RichEditParams {
  newMessage?: string;
  embedsJson?: string;
  componentsJson?: string;
  componentsV2?: boolean;
  keepAttachments?: boolean;
  suppressEmbeds?: boolean;
}

export interface ExistingAttachment {
  id: string;
  filename: string;
  description?: string | null;
}

export interface BuiltEditOptions extends MessageEditOptions {}

/**
 * Shared validation for edit_message / edit_private_message. Pass the message's
 * current attachments when keepAttachments is set so they survive the edit.
 */
export async function buildEditOptions(
  params: RichEditParams,
  existingAttachments?: ExistingAttachment[],
): Promise<BuiltEditOptions> {
  const content = params.newMessage !== undefined && params.newMessage !== '' ? params.newMessage : undefined;
  if (content && content.length > CONTENT_LIMIT) {
    throw new ValidationError(`newMessage: ${content.length} chars > ${CONTENT_LIMIT}`);
  }
  const embeds = params.embedsJson ? normalizeEmbeds(parseJsonParam('embedsJson', params.embedsJson)) : undefined;
  const components = params.componentsJson
    ? validateComponents(parseJsonParam('componentsJson', params.componentsJson))
    : undefined;

  const isV2 = Boolean(params.componentsV2);
  if (isV2 && !components) {
    throw new ValidationError('componentsV2: componentsJson is required');
  }

  if (!content && !embeds && !components && !params.keepAttachments) {
    throw new ValidationError(
      'empty edit: provide at least one of newMessage, embedsJson, componentsJson, keepAttachments',
    );
  }

  const options: BuiltEditOptions = {
    allowedMentions: normalizeAllowedMentions(undefined),
  };
  if (content) options.content = content;
  if (embeds) options.embeds = embeds;
  if (components) {
    options.components = components as unknown as NonNullable<MessageEditOptions['components']>;
  }
  if (params.keepAttachments && existingAttachments) {
    options.attachments = existingAttachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      ...(a.description ? { description: a.description } : {}),
    }));
  }
  const flags = buildFlags({ suppressEmbeds: params.suppressEmbeds }, isV2);
  if (flags) options.flags = flags as MessageEditOptions["flags"];
  return options;
}
