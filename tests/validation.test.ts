import { describe, expect, it } from 'vitest';
import {
  normalizeAllowedMentions,
  normalizeEmbeds,
  parseJsonParam,
  validateComponents,
  validatePoll,
  validateStickerIds,
  validateFileSpecs,
} from '../src/lib/validation.js';
import { buildSendOptions } from '../src/lib/messages.js';
import { ValidationError } from '../src/lib/errors.js';

describe('parseJsonParam', () => {
  it('parses valid JSON', () => {
    expect(parseJsonParam('embedsJson', '[{"title":"hi"}]')).toEqual([{ title: 'hi' }]);
  });
  it('returns undefined for missing', () => {
    expect(parseJsonParam('x', undefined)).toBeUndefined();
  });
  it('names the parameter on bad JSON', () => {
    expect(() => parseJsonParam('embedsJson', '[nope')).toThrow(/embedsJson: invalid JSON/);
  });
});

describe('embeds', () => {
  it('accepts a valid embed and normalizes hex color + "now" timestamp', () => {
    const out = normalizeEmbeds(
      [{ title: 'T', description: 'D', color: '#ff0000', timestamp: 'now', fields: [{ name: 'n', value: 'v', inline: true }] }],
      'embedsJson',
    );
    expect(out[0]!.color).toBe(0xff0000);
    expect(out[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects more than 10 embeds', () => {
    const many = JSON.stringify(Array.from({ length: 11 }, () => ({ title: 'x' })));
    expect(() => normalizeEmbeds(JSON.parse(many), 'embedsJson')).toThrow(/11 embeds > 10/);
  });

  it('rejects an over-long field value with the field path', () => {
    const embeds = [{ fields: [{ name: 'n', value: 'x'.repeat(1100) }] }];
    expect(() => normalizeEmbeds(embeds, 'embedsJson')).toThrow(
      /embedsJson\[0\]\.fields\[0\]\.value: 1100 chars > 1024/,
    );
  });

  it('rejects 26 fields', () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: 'v' }));
    expect(() => normalizeEmbeds([{ fields }], 'embedsJson')).toThrow(/26 fields > 25/);
  });

  it('rejects over 6000 chars total', () => {
    const embeds = Array.from({ length: 2 }, () => ({ description: 'y'.repeat(3100) }));
    expect(() => normalizeEmbeds(embeds, 'embedsJson')).toThrow(/chars total > 6000/);
  });

  it('rejects bad colors', () => {
    expect(() => normalizeEmbeds([{ color: 'nope' }], 'e')).toThrow(/color/);
    expect(() => normalizeEmbeds([{ color: 0x1000000 }], 'e')).toThrow(/color/);
  });

  it('enforces footer and author limits', () => {
    expect(() => normalizeEmbeds([{ footer: { text: 'f'.repeat(2049) } }], 'e')).toThrow(/footer\.text/);
    expect(() => normalizeEmbeds([{ author: { name: 'a'.repeat(257) } }], 'e')).toThrow(/author\.name/);
  });
});

describe('polls', () => {
  const valid = {
    question: { text: 'Best color?' },
    answers: [{ poll_media: { text: 'Red' } }, { poll_media: { text: 'Blue' } }],
    duration: 48,
    allow_multiselect: true,
  };

  it('accepts a valid poll with defaults', () => {
    const out = validatePoll({ question: { text: 'Q' }, answers: [{ poll_media: { text: 'A' } }] });
    expect(out.duration).toBe(24);
    expect(out.allow_multiselect).toBe(false);
  });

  it('passes through explicit values', () => {
    const out = validatePoll(valid);
    expect(out.duration).toBe(48);
    expect(out.allow_multiselect).toBe(true);
    expect(out.answers).toHaveLength(2);
  });

  it('rejects 11 answers', () => {
    const bad = { ...valid, answers: Array.from({ length: 11 }, () => ({ poll_media: { text: 'a' } })) };
    expect(() => validatePoll(bad)).toThrow(/11 answers > 10/);
  });

  it('rejects a long question and long answer text', () => {
    expect(() => validatePoll({ ...valid, question: { text: 'q'.repeat(301) } })).toThrow(/question\.text/);
    expect(() => validatePoll({ ...valid, answers: [{ poll_media: { text: 'a'.repeat(56) } }] })).toThrow(
      /poll_media\.text/,
    );
  });

  it('rejects out-of-range duration', () => {
    expect(() => validatePoll({ ...valid, duration: 800 })).toThrow(/duration/);
    expect(() => validatePoll({ ...valid, duration: 0 })).toThrow(/duration/);
  });
});

describe('components', () => {
  const button = { type: 2, style: 1, label: 'Click', custom_id: 'b1' };
  const row = { type: 1, components: [button] };

  it('accepts action rows with buttons', () => {
    expect(() => validateComponents([row])).not.toThrow();
  });

  it('accepts V2 containers', () => {
    const container = { type: 17, accent_color: '#00ff00', components: [{ type: 10, content: 'hi' }] };
    expect(() => validateComponents([container])).not.toThrow();
  });

  it('rejects invalid types', () => {
    expect(() => validateComponents([{ type: 99 }])).toThrow(/not a valid component type/);
  });

  it('rejects top-level buttons', () => {
    expect(() => validateComponents([button])).toThrow(/top-level/);
  });

  it('rejects non-link buttons without custom_id', () => {
    expect(() => validateComponents([{ type: 1, components: [{ type: 2, style: 1, label: 'x' }] }])).toThrow(
      /custom_id/,
    );
  });

  it('rejects link buttons without url', () => {
    expect(() => validateComponents([{ type: 1, components: [{ type: 2, style: 5, label: 'x' }] }])).toThrow(
      /link buttons/,
    );
  });

  it('rejects more than 40 components total (nested count)', () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ type: 10, content: `c${i}` }));
    const container = { type: 17, components: many };
    expect(() => validateComponents([container])).toThrow(/> 40/);
  });
});

describe('buildSendOptions', () => {
  it('accepts plain content', async () => {
    const out = await buildSendOptions({ message: 'hello' });
    expect(out.content).toBe('hello');
  });

  it('rejects content over 2000 chars', async () => {
    await expect(buildSendOptions({ message: 'x'.repeat(2001) })).rejects.toThrow(/2001 chars > 2000/);
  });

  it('rejects an empty message', async () => {
    await expect(buildSendOptions({})).rejects.toThrow(/empty message/);
  });

  it('rejects Components V2 with content or embeds', async () => {
    const components = [{ type: 17, components: [{ type: 10, content: 'x' }] }];
    await expect(
      buildSendOptions({ componentsV2: true, componentsJson: JSON.stringify(components), message: 'no' }),
    ).rejects.toThrow(/only components/);
    await expect(buildSendOptions({ componentsV2: true, message: 'no' })).rejects.toThrow(
      /componentsJson with at least one container/,
    );
  });

  it('builds a Components V2 message', async () => {
    const components = [{ type: 17, components: [{ type: 10, content: 'x' }] }];
    const out = await buildSendOptions({ componentsV2: true, componentsJson: JSON.stringify(components) });
    expect(out.components).toHaveLength(1);
    expect(Number(out.flags)).toBe(1 << 15);
  });

  it('maps allowedMentions modes', async () => {
    expect((await buildSendOptions({ message: 'x', allowedMentions: 'none' })).allowedMentions?.parse).toEqual([]);
    expect((await buildSendOptions({ message: 'x', allowedMentions: 'users_roles' })).allowedMentions?.parse).toEqual([
      'users',
      'roles',
    ]);
    await expect(buildSendOptions({ message: 'x', allowedMentions: 'everyone' })).rejects.toThrow(/allowedMentions/);
  });

  it('rejects more than 3 stickers', async () => {
    const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444'];
    await expect(buildSendOptions({ message: 'x', stickerIds: ids })).rejects.toThrow(/4 stickers > 3/);
  });

  it('wires replyToMessageId into the reply option', async () => {
    const out = await buildSendOptions({ message: 'x', replyToMessageId: '123456789012345678' });
    expect(out.reply).toEqual({ messageReference: '123456789012345678', failIfNotExists: false });
  });
});

describe('misc validators', () => {
  it('validates sticker id snowflakes', () => {
    expect(() => validateStickerIds(['not-an-id'])).toThrow(/stickerIds\[0\]/);
  });

  it('validates file specs: url XOR base64', () => {
    expect(() => validateFileSpecs([{ url: 'https://x/y.png', base64: 'aaa' }])).toThrow(/exactly one/);
    expect(() => validateFileSpecs([{ base64: 'aaa' }])).toThrow(/filename/);
    expect(validateFileSpecs([{ url: 'https://x/y.png' }])).toHaveLength(1);
  });

  it('maps allowed mention modes and rejects unknown ones', () => {
    expect(normalizeAllowedMentions(undefined).parse).toEqual(['users']);
    expect(normalizeAllowedMentions('all').parse).toEqual(['users', 'roles', 'everyone']);
    expect(() => normalizeAllowedMentions('some')).toThrow(/allowedMentions/);
  });
});
