import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));

// The release workflow publishes server.json to the MCP Registry, which rejects invalid files
// only after the npm package is already out, so catch the problems here.
describe('server.json', () => {
  const server = read('server.json');
  const pkg = read('package.json');

  it('fits the MCP Registry description limit', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('matches package.json', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
  });
});
