import { describe, expect, it } from 'vitest';
import { formatMessageLine, normalizeApiMessage, truncate } from '../src/lib/format.js';

const BASE = {
  id: '100000000000000001',
  authorId: '100000000000000002',
  authorName: 'Will',
  content: 'hello world',
  createdTimestamp: Date.parse('2026-10-01T12:00:00.000Z'),
  attachments: [],
  embeds: [],
  components: [],
  reference: null,
  poll: null,
  stickers: [],
};

describe('formatMessageLine', () => {
  it('formats a plain message', () => {
    const line = formatMessageLine(BASE);
    expect(line).toBe(
      '[2026-10-01T12:00:00.000Z] Will (id 100000000000000002) [msg 100000000000000001]: hello world',
    );
  });

  it('appends an embed marker with truncated description', () => {
    const line = formatMessageLine({
      ...BASE,
      embeds: [{ title: 'News', description: 'x'.repeat(200) }],
    });
    expect(line).toMatch(/\[embed: News — x{100}…\]$/);
  });

  it('uses the embed marker as content when the message is empty', () => {
    const line = formatMessageLine({ ...BASE, content: '', embeds: [{ title: 'T', description: 'D' }] });
    expect(line.endsWith(': [embed: T — D]')).toBe(true);
  });

  it('counts buttons and selects across nested components', () => {
    const components = [
      {
        type: 1,
        components: [
          { type: 2, label: 'a', style: 1, custom_id: 'a' },
          { type: 2, label: 'b', style: 1, custom_id: 'b' },
        ],
      },
      { type: 1, components: [{ type: 3, custom_id: 's', options: [] }] },
      { type: 17, components: [{ type: 1, components: [{ type: 2, label: 'c', style: 2, custom_id: 'c' }] }] },
    ];
    const line = formatMessageLine({ ...BASE, components });
    expect(line).toMatch(/\[components: 3 buttons, 1 select\]/);
  });

  it('marks polls with vote counts', () => {
    const line = formatMessageLine({
      ...BASE,
      poll: { question: 'Lunch?', votes: 7, answers: 3 },
    });
    expect(line).toMatch(/\[poll: Lunch\? \(7 votes\)\]/);
  });

  it('lists attachments', () => {
    const line = formatMessageLine({
      ...BASE,
      attachments: [{ name: 'cat.png', url: 'https://cdn.example.com/cat.png' }],
    });
    expect(line).toMatch(/\[attachment: cat\.png https:\/\/cdn\.example\.com\/cat\.png\]/);
  });

  it('marks replies and forwards distinctly', () => {
    const reply = formatMessageLine({ ...BASE, reference: { messageId: '999', type: 0 } });
    expect(reply).toMatch(/\[reply to 999\]/);
    const fwd = formatMessageLine({ ...BASE, reference: { messageId: '999', type: 1 } });
    expect(fwd).toMatch(/\[forwarded\]/);
  });

  it('marks stickers', () => {
    const line = formatMessageLine({ ...BASE, stickers: ['Wave'] });
    expect(line).toMatch(/\[sticker: Wave\]/);
  });
});

describe('normalizeApiMessage', () => {
  it('converts raw REST search results', () => {
    const raw = {
      id: '111',
      author: { id: '222', username: 'alice', global_name: 'Alice' },
      content: 'hi',
      timestamp: '2026-10-01T10:00:00.000Z',
      attachments: [{ filename: 'f.txt', url: 'https://x/f.txt', size: 10, content_type: 'text/plain' }],
      embeds: [{ title: 'E' }],
      components: [],
      message_reference: { message_id: '333', type: 0 },
      sticker_items: [{ name: 'S' }],
      poll: { question: { text: 'Q?' }, answers: [{ count: 4 }, { count: 6 }] },
    };
    const m = normalizeApiMessage(raw);
    expect(m.authorName).toBe('Alice');
    expect(m.poll?.votes).toBe(10);
    expect(m.reference?.messageId).toBe('333');
    expect(m.stickers).toEqual(['S']);
    expect(m.attachments[0]?.name).toBe('f.txt');
    const line = formatMessageLine(m);
    expect(line).toContain('hi');
    expect(line).toContain('[poll: Q? (10 votes)]');
    expect(line).toContain('[sticker: S]');
  });
});

describe('truncate', () => {
  it('passes short text through', () => {
    expect(truncate('short', 6000)).toBe('short');
  });
  it('truncates long text with a marker', () => {
    const out = truncate('x'.repeat(7000), 6000);
    expect(out.length).toBeLessThanOrEqual(6000);
    expect(out).toMatch(/…\(truncated\)$/);
  });
});
