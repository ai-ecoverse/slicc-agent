import type { Context } from '@earendil-works/chord';
import type { CodemodeTool } from '@earendil-works/pi-codemode';
import {
  type Agent,
  type ConversationId,
  type DocumentReader,
  defineDoc,
  defineExtension,
  type Extension,
  type Registry,
  section,
  type ToolExecutionApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import {
  type McpExposure,
  mcpNamespace,
  mcpToolName,
  nameMatcher,
  toolExposure,
} from './config.ts';
import type { McpServerConnection } from './connection.ts';
import { type Listing, renderSection } from './section.ts';
import {
  apiSaver,
  directTool,
  discoveryGlobals,
  type McpToolEntry,
  type Namespace,
  type ResourceServer,
  resourceScriptTools,
  resourceTools,
  scriptTool,
} from './tools.ts';

export const MCP_EXTENSION = 'slicc-mcp';
export const MCP_SECTION = 'mcp_servers';
export const DIRECT_WAIT_MS = 10_000;
const RESOURCE_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

export const McpAllowDoc = defineDoc<{ allow: string[] | null }>({
  kind: 'slicc.mcp',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ allow: null }),
});

export interface CodemodeExtra {
  tools: CodemodeTool[];
  globals: CodemodeTool[];
}

export function mcpEntries(names: readonly string[] | undefined): string[] | null {
  if (!names) return null;
  return names.filter((name) => name.startsWith('mcp__') || RESOURCE_NAMES.has(name));
}

export function allows(allow: readonly string[] | null, name: string): boolean {
  return allow === null || nameMatcher(allow)(name);
}

export function serverAllowed(allow: readonly string[] | null, server: string): boolean {
  if (allow === null) return true;
  const prefix = `${mcpNamespace(server)}__`;
  return allow.some((entry) => {
    if (entry.startsWith(prefix) || RESOURCE_NAMES.has(entry)) return true;
    if (!entry.includes('*')) return false;
    return prefix.startsWith(entry.slice(0, entry.indexOf('*')));
  });
}

export function effective(exposure: McpExposure, codemode: boolean): McpExposure {
  const indirect = exposure === 'deferred' ? 'codemode' : exposure;
  return indirect === 'codemode' && !codemode ? 'direct' : indirect;
}

export async function allowOf(
  read: DocumentReader,
  conversationId: ConversationId,
  context: Context
): Promise<string[] | null> {
  const doc = await read.snapshot(McpAllowDoc, conversationId, context).catch(() => undefined);
  return doc?.allow ?? null;
}

export class McpCatalog {
  readonly connections = new Map<string, McpServerConnection>();
  entries: McpToolEntry[] = [];
  codemodeOn = true;
  current: Extension;
  readonly #registry: Registry;
  readonly #section = section(MCP_SECTION, async (input, context) =>
    renderSection(this.listings(await allowOf(input.read, input.conversationId, context)))
  );

  constructor(registry: Registry) {
    this.#registry = registry;
    this.current = defineExtension({ name: MCP_EXTENSION });
  }

  connected(): McpServerConnection[] {
    return [...this.connections.values()].filter((connection) => connection.state === 'connected');
  }

  resourceServers(allow: readonly string[] | null): ResourceServer[] {
    return this.connected()
      .filter((connection) => connection.hasResources && serverAllowed(allow, connection.name))
      .map((connection) => ({ name: connection.name, connection }));
  }

  resourceExposure(): McpExposure | undefined {
    let widest: McpExposure | undefined;
    for (const connection of this.connected()) {
      if (!connection.hasResources) continue;
      const exposure = effective(connection.entry.config.exposure ?? 'codemode', this.codemodeOn);
      if (exposure === 'direct') return 'direct';
      if (exposure === 'codemode') widest = 'codemode';
    }
    return widest;
  }

  listings(allow: readonly string[] | null): Listing[] {
    return [...this.connections.values()]
      .filter((connection) => {
        if (!serverAllowed(allow, connection.name)) return false;
        const { config } = connection.entry;
        const exposures = [
          config.exposure ?? 'codemode',
          ...Object.values(config.toolExposure ?? {}),
        ];
        return exposures.some((exposure) => effective(exposure, this.codemodeOn) === 'codemode');
      })
      .map((connection) => ({
        name: connection.name,
        ...(connection.entry.config.description
          ? { description: connection.entry.config.description }
          : {}),
        ...(connection.instructions ? { instructions: connection.instructions } : {}),
      }));
  }

  install(): void {
    const readable = this.resourceExposure() !== undefined;
    const direct = this.entries
      .filter((entry) => entry.exposure === 'direct')
      .map((entry) => directTool(entry, () => readable && entry.connection.hasResources));
    const resources =
      this.resourceExposure() === 'direct' ? resourceTools(() => this.resourceServers(null)) : [];
    this.current = defineExtension({
      name: MCP_EXTENSION,
      tools: [...direct, ...resources],
      sections: [this.#section],
    });
    this.#registry.install(this.current);
  }

  rebuild(): void {
    const taken = new Set<string>();
    const next: McpToolEntry[] = [];
    for (const connection of this.connected()) {
      for (const tool of connection.tools) {
        const exposure = effective(
          toolExposure(connection.entry.config, tool.name),
          this.codemodeOn
        );
        if (exposure === 'hidden') continue;
        const name = mcpToolName(connection.name, tool.name, (candidate) => taken.has(candidate));
        taken.add(name);
        next.push({ server: connection.name, name, exposure, tool, connection });
      }
    }
    this.entries = next;
    this.install();
  }

  direct(names: readonly string[]): ToolRegistration[] {
    const match = nameMatcher([...names]);
    return ((this.current.tools ?? []) as ToolRegistration[]).filter((tool) => match(tool.name));
  }

  async waitFor(allow: readonly string[] | null): Promise<void> {
    const pending = [...this.connections.values()].filter(
      (connection) => connection.state === 'connecting' && serverAllowed(allow, connection.name)
    );
    if (!pending.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending.map((connection) => connection.getClient())),
      new Promise((resolve) => {
        timer = setTimeout(resolve, DIRECT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  #namespaces(): Map<string, Namespace> {
    const spaces = new Map<string, Namespace>();
    for (const entry of this.entries) {
      const { config } = entry.connection.entry;
      spaces.set(entry.name, {
        name: mcpNamespace(entry.server),
        ...(config.description ? { description: config.description } : {}),
        ...(entry.connection.instructions ? { instructions: entry.connection.instructions } : {}),
      });
    }
    return spaces;
  }

  async codemode(api: ToolExecutionApi, agent: Agent, context: Context): Promise<CodemodeExtra> {
    if (!agent.extensions.some((extension) => extension.name === MCP_EXTENSION))
      return { tools: [], globals: [] };
    const allow = await allowOf(api, api.conversationId, context);
    await this.waitFor(allow);
    const signal = context.abortSignal as AbortSignal | undefined;
    const offered = new Set(agent.tools.map((tool) => tool.name));
    const tools = this.entries
      .filter(
        (entry) =>
          allows(allow, entry.name) && (entry.exposure !== 'direct' || offered.has(entry.name))
      )
      .map((entry) => scriptTool(entry, signal));
    const save = apiSaver(api, 'r', context);
    const resources =
      this.resourceExposure() === 'codemode' && this.resourceServers(allow).length
        ? resourceScriptTools(() => this.resourceServers(allow), signal, save).filter((tool) =>
            allows(allow, tool.name)
          )
        : [];
    const all = [...tools, ...resources];
    const spaces = this.#namespaces();
    return {
      tools: all,
      globals: all.length ? discoveryGlobals(all, (name) => spaces.get(name)) : [],
    };
  }
}
