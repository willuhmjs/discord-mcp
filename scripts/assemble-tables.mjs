#!/usr/bin/env node
// Concatenates docs/tables/*.md into the README's <!-- TOOL TABLES --> slot.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tablesDir = join(root, 'docs', 'tables');
const readmePath = join(root, 'README.md');

const ORDER = [
  'messages.md',
  'direct-messages-users.md',
  'channels.md',
  'voice-forums.md',
  'threads-members.md',
  'roles-server.md',
  'automod-events-invites.md',
  'webhooks-expressions.md',
  'interactions.md',
];

const files = readdirSync(tablesDir).filter((f) => f.endsWith('.md'));
const ordered = [
  ...ORDER.filter((f) => files.includes(f)),
  ...files.filter((f) => !ORDER.includes(f)).sort(),
];

const sections = ordered.map((file) => {
  const raw = readFileSync(join(tablesDir, file), 'utf8').trim();
  // Drop a top-level heading if present; the README supplies section headers.
  const body = raw.replace(/^#.*\n+/, '');
  const title = file.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `### ${title}\n\n${body}\n`;
});

const readme = readFileSync(readmePath, 'utf8');
const marker = '<!-- TOOL TABLES -->';
if (!readme.includes(marker)) {
  console.error('README marker not found');
  process.exit(1);
}
writeFileSync(readmePath, readme.replace(marker, sections.join('\n').trimEnd()));
console.log(`Assembled ${ordered.length} tool tables into README.md`);
