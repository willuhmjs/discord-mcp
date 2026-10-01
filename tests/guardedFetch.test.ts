import { describe, expect, it } from 'vitest';
import { guardedFetch, isBlockedIp } from '../src/lib/fetch.js';

function jsonResponse(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

const PUBLIC = '93.184.216.34';
const resolvePublic = async () => [PUBLIC];

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.100.100.200',
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1', '64:ff9b::1'])(
    'allows %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe('guardedFetch', () => {
  it('blocks literal private-IP URLs before any request', async () => {
    let called = false;
    const fetchImpl = async (): Promise<Response> => {
      called = true;
      return jsonResponse('x');
    };
    await expect(
      guardedFetch('http://169.254.169.254/latest/meta-data', { fetchImpl, resolve: resolvePublic }),
    ).rejects.toThrow(/private\/loopback\/metadata address/);
    expect(called).toBe(false);
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    await expect(
      guardedFetch('http://internal.example.com/x', {
        fetchImpl: async () => jsonResponse('x'),
        resolve: async () => ['10.1.2.3'],
      }),
    ).rejects.toThrow(/internal\.example\.com" resolves to 10\.1\.2\.3/);
  });

  it('blocks non-http schemes', async () => {
    await expect(
      guardedFetch('file:///etc/passwd', { fetchImpl: async () => jsonResponse('x'), resolve: resolvePublic }),
    ).rejects.toThrow(/only http\(s\)/);
  });

  it('blocks DNS failures with a readable error', async () => {
    await expect(
      guardedFetch('http://nope.example.com/x', {
        fetchImpl: async () => jsonResponse('x'),
        resolve: async () => {
          throw new Error('NXDOMAIN');
        },
      }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it('returns the body for an allowed fetch', async () => {
    const out = await guardedFetch('https://example.com/a.png', {
      fetchImpl: async () => jsonResponse('hello', { 'content-type': 'image/png' }),
      resolve: resolvePublic,
      allowedTypes: ['image/png'],
    });
    expect(out.data.toString()).toBe('hello');
    expect(out.contentType).toBe('image/png');
  });

  it('rejects disallowed content types', async () => {
    await expect(
      guardedFetch('https://example.com/a.exe', {
        fetchImpl: async () => jsonResponse('x', { 'content-type': 'application/octet-stream' }),
        resolve: resolvePublic,
        allowedTypes: ['image/png'],
      }),
    ).rejects.toThrow(/content-type .* allowed: image\/png/);
  });

  it('re-checks after redirects: redirect to a private IP is blocked', async () => {
    let calls = 0;
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      calls++;
      if (String(url).includes('public.example.com')) {
        return redirectResponse('http://127.0.0.1/evil');
      }
      return jsonResponse('evil');
    };
    await expect(
      guardedFetch('https://public.example.com/redirect', { fetchImpl, resolve: resolvePublic }),
    ).rejects.toThrow(/blocked/);
    expect(calls).toBe(1);
  });

  it('follows safe redirects', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes('step1')) return redirectResponse('https://cdn.example.com/step2');
      return jsonResponse('done', { 'content-type': 'text/plain' });
    };
    const out = await guardedFetch('https://example.com/step1', { fetchImpl, resolve: resolvePublic });
    expect(out.data.toString()).toBe('done');
    expect(out.url).toBe('https://cdn.example.com/step2');
  });

  it('enforces the size cap', async () => {
    const big = 'x'.repeat(1024 * 1024);
    await expect(
      guardedFetch('https://example.com/big', {
        fetchImpl: async () => jsonResponse(big),
        resolve: resolvePublic,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/larger than/);
  });

  it('rejects non-2xx responses', async () => {
    await expect(
      guardedFetch('https://example.com/missing', {
        fetchImpl: async () => new Response('nope', { status: 404 }),
        resolve: resolvePublic,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('rejects redirect chains longer than 5 hops', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const n = Number(String(url).match(/hop(\d)/)?.[1] ?? 0);
      return redirectResponse(`https://example.com/hop${n + 1}`);
    };
    await expect(
      guardedFetch('https://example.com/hop0', { fetchImpl, resolve: resolvePublic }),
    ).rejects.toThrow(/too many redirects/);
  });
});
