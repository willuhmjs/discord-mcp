import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatError } from './errors.js';

/**
 * Tool handlers receive the parsed arguments matching the tool's inputSchema.
 * The zod shape is the source of truth; `args` is loosely typed here so
 * handlers can destructure it directly (the SDK validates against the schema).
 */
export type ToolHandler = (args: any) => Promise<string>;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec {
  description: string;
  /** Zod shape (plain object of zod validators), NOT z.object(). */
  inputSchema: z.ZodRawShape;
  annotations?: ToolAnnotations;
  handler: ToolHandler;
}

export interface Registrar {
  /** Register one tool; errors thrown by the handler become isError tool results. */
  tool(name: string, spec: ToolSpec): void;
  /** Number of tools registered so far. */
  readonly count: number;
}

/**
 * Wrap handlers so thrown errors map to readable `isError: true` tool results
 * and successful handlers only need to return plain text.
 */
export function createRegistrar(server: McpServer): Registrar {
  let count = 0;
  const registrar: Registrar = {
    get count() {
      return count;
    },
    tool(name, spec) {
      server.registerTool(
        name,
        {
          title: spec.annotations?.title,
          description: spec.description,
          inputSchema: spec.inputSchema as z.ZodRawShape,
          annotations: spec.annotations,
        },
        async (rawArgs) => {
          try {
            const text = await spec.handler(rawArgs);
            return { content: [{ type: 'text' as const, text: text || '(done)' }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: formatError(err) }], isError: true };
          }
        },
      );
      count++;
    },
  };
  return registrar;
}

// ---------------------------------------------------------------------------
// Shared input-schema params. Keep every ID a string (snowflakes overflow JS
// numbers), and keep guildId optional everywhere (clients commonly force-fill it).
// ---------------------------------------------------------------------------

export const snowflakeId = (desc: string) => z.string().describe(desc);

export const guildIdParam = z
  .string()
  .optional()
  .describe('Discord server ID (optional; defaults to DISCORD_GUILD_ID)');

export const reasonParam = z.string().max(512).optional().describe('Reason for the audit log');

export const limitParam = (def: number, max = 1000) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Max results (default ${def}, max ${max})`);

export const channelIdParam = snowflakeId('Discord channel ID');

export const userIdParam = snowflakeId('Discord user ID');

export const roleIdParam = snowflakeId('Discord role ID');

export const jsonParam = (name: string, shape: string) =>
  z
    .string()
    .optional()
    .describe(`${name} as a JSON string. ${shape}`);

export const booleanParam = (desc: string) => z.boolean().optional().describe(desc);

export const optionalIdListParam = (name: string) =>
  z
    .string()
    .optional()
    .describe(`Comma-separated ${name} (e.g. "123,456")`);
