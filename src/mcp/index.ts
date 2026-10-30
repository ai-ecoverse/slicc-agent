import type { Context } from '@earendil-works/chord';
import type {
  Agent,
  Registry,
  ToolExecutionApi,
  ToolRegistration,
} from '@earendil-works/pi-durable';
import type { CodemodeExtra } from './allow.ts';
import type { McpCatalog } from './catalog.ts';
import { parseMcpConfig } from './config.ts';
import { configPath, shown } from './paths.ts';
import type { McpAttach, McpRuntime } from './runtime.ts';

export { allows, type CodemodeExtra, McpAllowDoc, mcpEntries, serverAllowed } from './allow.ts';
export type { McpAccounts, McpAttach, McpRuntime, ServerStatus } from './runtime.ts';

export type McpLoader = () => Promise<typeof import('./runtime.ts')>;

export const loadRuntime: McpLoader = () => import('./runtime.ts');

export interface McpSetup {
  catalog(): McpCatalog | undefined;
  direct(names: readonly string[]): ToolRegistration[];
  codemode(api: ToolExecutionApi, agent: Agent, context: Context): Promise<CodemodeExtra>;
  attach(options: McpAttach, context: Context): Promise<McpRuntime>;
}

const NOT_LOADED = { ok: false as const, reason: "the MCP client didn't load: update SLICC" };

const idle: McpRuntime = {
  accounts: async () => [],
  signIn: async (id) => {
    throw new Error(`${id} is not an MCP server that signs in`);
  },
  connect: async (id) => {
    throw new Error(`${id} is not an MCP server that takes a token`);
  },
  disconnect: async () => undefined,
  serverUrl: async () => null,
  addServer: async () => NOT_LOADED,
  removeServer: async () => NOT_LOADED,
  onChange: () => () => undefined,
  status: () => [],
  reload: async () => undefined,
  close: async () => undefined,
};

async function unavailable(options: McpAttach, error: unknown, context: Context) {
  const file = configPath(options.home, options.agentDir);
  const named = shown(file, options.home);
  const read = await options.env.readTextFile(file, context);
  if (!parseMcpConfig(read.ok ? read.value : undefined).servers.length) return;
  await options.licks
    .deliver(
      {
        channel: 'fswatch',
        source: `mcp:${named}`,
        title: "MCP servers can't start in this SLICC",
        text: error instanceof Error ? error.message : String(error),
        body: `The MCP client didn't load, so the servers in ${named} stay off until SLICC is updated.`,
        target: 'cone',
        severity: 'warn',
        eventId: 'mcp\nunavailable',
      },
      context
    )
    .catch(() => undefined);
}

export function setupMcp(registry: Registry, load: McpLoader = loadRuntime): McpSetup {
  let catalog: McpCatalog | undefined;
  return {
    catalog: () => catalog,
    direct: (names) => catalog?.direct(names) ?? [],
    codemode: async (api, agent, context) =>
      catalog ? catalog.codemode(api, agent, context) : { tools: [], globals: [] },
    async attach(options, context) {
      let started: Awaited<ReturnType<Awaited<ReturnType<McpLoader>>['startMcp']>>;
      try {
        started = await (await load()).startMcp(registry, options, context);
      } catch (error) {
        await unavailable(options, error, context);
        return idle;
      }
      catalog = started.catalog;
      return started.runtime;
    },
  };
}
