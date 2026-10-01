import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ValidationError } from './errors.js';

export interface FetchedFile {
  data: Buffer;
  contentType: string;
  /** The final URL after redirects. */
  url: string;
}

const MAX_BYTES_DEFAULT = 25 * 1024 * 1024; // 25 MiB, matches Discord's message request cap
const TIMEOUT_MS_DEFAULT = 15_000;
const MAX_REDIRECTS = 5;

// IPv4 CIDRs to block: unspecified, loopback, RFC1918, CGNAT (covers cloud metadata),
// link-local (covers 169.254.169.254), and private-use ranges.
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

function ipv4ToNum(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr4(ip: string, cidr: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNum(ip) & mask) === (ipv4ToNum(cidr) & mask);
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Expand :: shorthand, then parse eight 16-bit groups.
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves[1] !== undefined && halves.length === 2 ? halves[1].split(':').filter(Boolean) : [];
  const groups = [...head, ...tail];
  const missing = 8 - groups.length;
  const all: number[] = [];
  for (const g of head) all.push(Number.parseInt(g, 16));
  if (halves.length === 2) for (let i = 0; i < missing; i++) all.push(0);
  for (const g of tail) all.push(Number.parseInt(g, 16));
  if (all.length !== 8 || all.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return all.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

function inCidr6(ip: string, cidr: string, bits: number): boolean {
  const ipNum = ipv6ToBigInt(ip);
  const cidrNum = ipv6ToBigInt(cidr);
  if (ipNum === null || cidrNum === null) return false;
  const mask = bits === 0 ? 0n : (0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn << BigInt(128 - bits)) & 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn;
  return (ipNum & mask) === (cidrNum & mask);
}

/** True when the IP is loopback/private/metadata/link-local and must not be fetched. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return BLOCKED_V4.some(([cidr, bits]) => inCidr4(ip, cidr, bits));
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded IPv4 too.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]!);
    if (lower === '::1' || lower === '::') return true; // loopback, unspecified
    if (inCidr6(lower, 'fc00::', 7)) return true; // unique local addresses
    if (inCidr6(lower, 'fe80::', 10)) return true; // link-local
    if (inCidr6(lower, '::ffff:0:0', 96)) return true; // all v4-mapped
    return false;
  }
  return true; // not an IP at all — treat as blocked (we only allow resolved hosts)
}

export interface GuardedFetchOptions {
  /** Max response body size (default 25 MiB). */
  maxBytes?: number;
  /** Overall deadline in ms (default 15s). */
  timeoutMs?: number;
  /** Allowed Content-Types (exact match, charset ignored). Omit to allow any. */
  allowedTypes?: string[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver for tests; returns the addresses a hostname resolves to. */
  resolve?: (host: string) => Promise<string[]>;
}

async function resolveHost(host: string, opts: GuardedFetchOptions): Promise<void> {
  const resolve = opts.resolve ?? (async (h) => (await lookup(h, { all: true })).map((a) => a.address));
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new ValidationError(`url: host "${host}" could not be resolved (DNS failure)`);
  }
  if (!addresses.length) throw new ValidationError(`url: host "${host}" has no DNS records`);
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new ValidationError(
        `url: host "${host}" resolves to ${addr}, a private/loopback/metadata address — blocked`,
      );
    }
  }
}

async function assertUrlAllowed(url: string, opts: GuardedFetchOptions): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`url: "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`url: only http(s) URLs are allowed, got ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new ValidationError(`url: ${host} is a private/loopback/metadata address — blocked`);
    }
  } else {
    await resolveHost(host, opts);
  }
}

/**
 * The single URL fetcher used by every tool. Blocks SSRF targets, follows
 * redirects manually (re-validating each hop), caps size and time, and checks
 * the Content-Type against a per-use allowlist.
 */
export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions = {}): Promise<FetchedFile> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES_DEFAULT;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS_DEFAULT;
  const doFetch = opts.fetchImpl ?? fetch;

  let url = rawUrl.trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertUrlAllowed(url, opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, { redirect: 'manual', signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error && err.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : String((err as Error)?.message ?? err);
      throw new ValidationError(`url: fetch of ${url} failed (${msg})`);
    }
    // Manual redirect handling: re-validate scheme + DNS before following.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      clearTimeout(timer);
      if (!location) throw new ValidationError(`url: ${url} returned a redirect without a Location`);
      if (hop === MAX_REDIRECTS) throw new ValidationError(`url: too many redirects (> ${MAX_REDIRECTS})`);
      url = new URL(location, url).toString();
      continue;
    }
    try {
      if (!response.ok) {
        throw new ValidationError(`url: ${url} returned HTTP ${response.status}`);
      }
      const contentType = (response.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
      if (opts.allowedTypes && !opts.allowedTypes.includes(contentType)) {
        throw new ValidationError(
          `url: ${url} has content-type "${contentType || 'unknown'}", allowed: ${opts.allowedTypes.join(', ')}`,
        );
      }
      if (!response.body) {
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length > maxBytes) throw tooLarge(maxBytes);
        return { data: buf, contentType: contentType || 'application/octet-stream', url };
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw tooLarge(maxBytes);
        }
        chunks.push(Buffer.from(chunk));
      }
      return { data: Buffer.concat(chunks), contentType: contentType || 'application/octet-stream', url };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ValidationError('url: redirect loop');

  function tooLarge(max: number): ValidationError {
    return new ValidationError(`url: response larger than ${Math.round(max / (1024 * 1024))} MiB limit`);
  }
}

/** Content-type allowlists per use. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
export const STICKER_TYPES = ['image/png', 'image/gif', 'application/json']; // json = lottie
export const SOUND_TYPES = ['audio/mpeg', 'audio/ogg', 'application/ogg'];
export const FILE_TYPES = [
  ...IMAGE_TYPES,
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
  'application/json',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/octet-stream',
];
