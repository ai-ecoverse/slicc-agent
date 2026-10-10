import type { Context } from '@earendil-works/chord';
import type {
  Agent,
  Registry,
  ToolExecutionApi,
  ToolRegistration,
} from '@earendil-works/pi-durable';
import { type CodemodeExtra, McpCatalog } from './catalog.ts';
import { attachMcp, type McpAttach, type McpRuntime } from './runtime.ts';

export {
  allows,
  type CodemodeExtra,
  MCP_EXTENSION,
  MCP_SECTION,
  McpAllowDoc,
  mcpEntries,
  serverAllowed,
} from './catalog.ts';
export {
  configPath,
  logPath,
  type McpAttach,
  type McpRuntime,
  type ServerStatus,
} from './runtime.ts';

export interface McpSetup {
  catalog: McpCatalog;
  direct(names: readonly string[]): ToolRegistration[];
  codemode(api: ToolExecutionApi, agent: Agent, context: Context): Promise<CodemodeExtra>;
  attach(options: McpAttach, context: Context): Promise<McpRuntime>;
}

export function setupMcp(registry: Registry): McpSetup {
  const catalog = new McpCatalog(registry);
  return {
    catalog,
    direct: (names) => catalog.direct(names),
    codemode: (api, agent, context) => catalog.codemode(api, agent, context),
    attach: (options, context) => attachMcp(catalog, options, context),
  };
}
