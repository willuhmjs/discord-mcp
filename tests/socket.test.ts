import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpHttpServer, listenOnSocket, removeSocket } from '../src/http.js';

function newServer() {
  return createMcpHttpServer({
    newMcpServer: () => new McpServer({ name: 'test', version: '0.0.0' }),
    isReady: () => true,
    log: () => {},
  });
}

/** One HTTP request over a Unix socket; resolves to the status code and body. */
function viaSocket(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let dir: string;
const servers: ReturnType<typeof newServer>[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dmcp-'));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('listenOnSocket', () => {
  it('serves HTTP over the socket and creates it owner-only (mode 600)', async () => {
    const path = join(dir, 's');
    const server = newServer();
    servers.push(server);
    await listenOnSocket(server, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await viaSocket(path, '/health')).toEqual({ status: 200, body: 'ok' });
  });

  it('restores the process umask afterwards', async () => {
    const before = process.umask();
    const server = newServer();
    servers.push(server);
    await listenOnSocket(server, join(dir, 's'));
    expect(process.umask()).toBe(before);
  });

  it('refuses to replace a regular file', async () => {
    const path = join(dir, 'precious');
    writeFileSync(path, 'data');
    await expect(listenOnSocket(newServer(), path)).rejects.toThrow(/not a socket/);
    expect(statSync(path).isFile()).toBe(true);
  });

  it('refuses to take over a socket that is still being served', async () => {
    const path = join(dir, 's');
    const first = newServer();
    servers.push(first);
    await listenOnSocket(first, path);
    await expect(listenOnSocket(newServer(), path)).rejects.toThrow(/already being served/);
    expect((await viaSocket(path, '/health')).status).toBe(200);
  });

  it('replaces a socket left behind by a crashed run', async () => {
    const path = join(dir, 's');
    // A real process listens on the socket and is killed hard, which leaves the socket file behind.
    const child = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    expect(statSync(path).isSocket()).toBe(true); // stale: nobody is serving it

    const fresh = newServer();
    servers.push(fresh);
    await listenOnSocket(fresh, path);
    expect((await viaSocket(path, '/health')).status).toBe(200);
  });

  it('removeSocket ignores a missing file', () => {
    expect(() => removeSocket(join(dir, 'nope'))).not.toThrow();
  });
});
