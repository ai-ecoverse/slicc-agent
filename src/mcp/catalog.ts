import type { Context } from '@earendil-works/chord';
import {
  type Agent,
  type ConversationId,
  type DocumentReader,
  defineExtension,
  type Extension,
  hook,
  type Registry,
  section,
  type ToolExecutionApi,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable';
import { allows, type CodemodeExtra, McpAllowDoc, RESOURCE_NAMES, serverAllowed } from './allow.ts';
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

export function effective(
  exposure: McpExposure,
  codemode: boolean,
  toolSearch = true
): McpExposure {
  if (exposure === 'deferred') {
    if (toolSearch) return 'deferred';
    return codemode ? 'codemode' : 'direct';
  }
  return exposure === 'codemode' && !codemode ? 'direct' : exposure;
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
  toolSearchOn = true;
  current: Extension;
  readonly #registry: Registry;
  readonly #section = section(MCP_SECTION, async (input, context) =>
    renderSection(this.listings(await allowOf(input.read, input.conversationId, context)))
  );

  readonly #guard = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      const name = call.name;
      if (!name.startsWith('mcp__') && !RESOURCE_NAMES.has(name)) return undefined;
      const allow = await allowOf(api, api.conversationId, context);
      if (allows(allow, name)) return undefined;
      return { block: `${name} isn't among the MCP tools this scoop may use` };
    },
  });

  constructor(registry: Registry) {
    this.#registry = registry;
    this.current = defineExtension({ name: MCP_EXTENSION });
  }

  #effective(exposure: McpExposure): McpExposure {
    return effective(exposure, this.codemodeOn, this.toolSearchOn);
  }

  connected(): McpServerConnection[] {
    return [...this.connections.values()].filter((connection) => connection.live);
  }

  #resourceful(): McpServerConnection[] {
    return this.connected().filter((connection) => {
      if (!connection.hasResources) return false;
      const exposure = this.#effective(connection.entry.config.exposure ?? 'codemode');
      return exposure !== 'hidden';
    });
  }

  resourceServers(allow: readonly string[] | null): ResourceServer[] {
    return this.#resourceful()
      .filter((connection) => serverAllowed(allow, connection.name))
      .map((connection) => ({ name: connection.name, connection }));
  }

  resourceExposure(): McpExposure | undefined {
    const exposures = this.#resourceful().map((connection) => {
      return this.#effective(connection.entry.config.exposure ?? 'codemode');
    });
    if (!exposures.length) return undefined;
    if (exposures.includes('direct')) return 'direct';
    if (exposures.includes('codemode')) return 'codemode';
    return exposures.includes('deferred') ? 'deferred' : 'codemode';
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
        return exposures.some((exposure) => this.#effective(exposure) === 'codemode');
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
      .filter((entry) => entry.exposure === 'direct' || entry.exposure === 'deferred')
      .map((entry) =>
        directTool(
          entry,
          () => readable && entry.connection.hasResources,
          entry.exposure === 'deferred'
        )
      );
    const resources =
      this.resourceExposure() === 'direct'
        ? resourceTools(async (api, context) =>
            this.resourceServers(await allowOf(api, api.conversationId, context))
          )
        : [];
    this.current = defineExtension({
      name: MCP_EXTENSION,
      tools: [...direct, ...resources],
      sections: [this.#section],
      hooks: [this.#guard],
    });
    this.#registry.install(this.current);
  }

  rebuild(): void {
    const taken = new Set<string>();
    const next: McpToolEntry[] = [];
    for (const connection of this.connected()) {
      for (const tool of connection.tools) {
        const exposure = this.#effective(toolExposure(connection.entry.config, tool.name));
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
      this.resourceExposure() !== 'direct' && this.resourceServers(allow).length
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
