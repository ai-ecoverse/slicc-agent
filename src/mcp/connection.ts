import {
  type CallToolResult,
  JSON_RPC_ERROR_CODES,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpHttpError,
  type McpRequestOptions,
  McpSessionExpiredError,
  type Tool as McpTool,
  type McpTransport,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
} from '@earendil-works/pi-mcp';
import { DEFAULT_TIMEOUT_SECONDS, type McpServerEntry } from './config.ts';

export type ServerState =
  | 'connecting'
  | 'connected'
  | 'needs-auth'
  | 'needs-secret'
  | 'failed'
  | 'closed';

export type TransportFactory = (
  entry: McpServerEntry
) => Promise<{ transport: McpTransport; secrets: string[] } | { missing: string[] }>;

export const CONNECT_RETRY_DELAYS_MS = [250, 1_000];
export const CLIENT_NAME = 'slicc';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransient(error: unknown): boolean {
  if (error instanceof McpHttpError)
    return (
      error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)
    );
  return error instanceof TypeError;
}

export function isMcpApp(item: { uri?: string; uriTemplate?: string; mimeType?: string }): boolean {
  const uri = item.uri ?? item.uriTemplate ?? '';
  return uri.startsWith('ui://') || /;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? '');
}

async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound)
      return empty;
    throw error;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

export interface ConnectionOptions {
  entry: McpServerEntry;
  version: string;
  transport: TransportFactory;
  onTools: (connection: McpServerConnection) => void;
  onChange?: (connection: McpServerConnection) => void;
  onLog?: (connection: McpServerConnection, params: unknown) => void;
}

export class McpServerConnection {
  readonly entry: McpServerEntry;
  state: ServerState = 'connecting';
  error: string | undefined;
  missing: string[] = [];
  tools: McpTool[] = [];
  hasResources = false;
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  instructions: string | undefined;
  secrets: string[] = [];
  #client: McpClient | undefined;
  #opening: Promise<McpClient> | undefined;
  readonly #shutdown = new AbortController();
  readonly #busy = new Map<McpClient, number>();
  #seen = false;
  readonly #expired = new Set<McpClient>();
  readonly #options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.entry = options.entry;
    this.#options = options;
  }

  get name(): string {
    return this.entry.name;
  }

  get timeoutMs(): number {
    return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  get live(): boolean {
    return this.state === 'connected' || (this.state === 'connecting' && this.#seen);
  }

  get closed(): boolean {
    return this.#shutdown.signal.aborted;
  }

  getClient(): Promise<McpClient> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is shut down`));
    if (this.#client?.connectionState === 'connected') return Promise.resolve(this.#client);
    this.#opening ??= this.#open().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions
  ): Promise<CallToolResult> {
    return this.#with((client) => client.callTool(name, args, options));
  }

  readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
    return this.#with((client) => client.readResource(uri, options), true);
  }

  resourcesPage(
    cursor: string | undefined,
    options: McpRequestOptions
  ): Promise<ListResourcesResult> {
    return this.#with((client) => client.listResourcesPage(cursor, options), true);
  }

  resourceTemplatesPage(
    cursor: string | undefined,
    options: McpRequestOptions
  ): Promise<ListResourceTemplatesResult> {
    return this.#with(
      (client) =>
        withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), {
          resourceTemplates: [],
        }),
      true
    );
  }

  allResources(options: McpRequestOptions): Promise<Resource[]> {
    return this.#with((client) => client.listResources(options), true);
  }

  allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
    return this.#with(
      (client) => withoutTemplates(() => client.listResourceTemplates(options), []),
      true
    );
  }

  async #with<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.getClient();
      this.#busy.set(client, (this.#busy.get(client) ?? 0) + 1);
      try {
        return await run(client);
      } catch (error) {
        if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransient(error)) {
          await sleep(CONNECT_RETRY_DELAYS_MS[0] as number, this.#shutdown.signal);
          continue;
        }
        if (error instanceof McpSessionExpiredError && attempt === 1) {
          if (this.#client === client) {
            this.#client = undefined;
            this.#expired.add(client);
          }
          continue;
        }
        if (!(error instanceof McpAuthRequiredError)) throw error;
        await this.#drop(client);
        this.#mark('needs-auth');
        throw new Error(this.signInMessage());
      } finally {
        this.#release(client);
      }
    }
  }

  #release(client: McpClient): void {
    const left = (this.#busy.get(client) as number) - 1;
    this.#busy.set(client, left);
    if (left > 0 || !this.#expired.delete(client)) return;
    this.#busy.delete(client);
    void this.#drop(client);
  }

  signInMessage(): string {
    return `MCP server "${this.name}" rejected the request as unauthorized (401). Check its token in Settings › Accounts.`;
  }

  #mark(state: ServerState, error?: string): void {
    this.state = state;
    this.error = error;
    this.#options.onChange?.(this);
  }

  async #drop(client: McpClient): Promise<void> {
    if (this.#client === client) this.#client = undefined;
    await client.close().catch(() => undefined);
  }

  async #open(): Promise<McpClient> {
    this.#mark('connecting');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#connectOnce();
      } catch (error) {
        const delay = CONNECT_RETRY_DELAYS_MS[attempt];
        if (this.closed || delay === undefined || !isTransient(error)) throw this.#failed(error);
        await sleep(delay, this.#shutdown.signal);
        if (this.closed) throw this.#failed(error);
      }
    }
  }

  async #connectOnce(): Promise<McpClient> {
    const made = await this.#options.transport(this.entry);
    if ('missing' in made) {
      this.missing = made.missing;
      throw new MissingSecret(made.missing);
    }
    this.secrets = made.secrets;
    const client = new McpClient({
      name: CLIENT_NAME,
      version: this.#options.version,
      requestTimeoutMs: this.timeoutMs,
    });
    const log = this.#options.onLog;
    if (log) client.onNotification('notifications/message', (params) => log(this, params));
    let closing: Promise<void> | undefined;
    const closeClient = () => {
      closing ??= client.close().catch(() => undefined);
      return closing;
    };
    this.#shutdown.signal.addEventListener('abort', closeClient, { once: true });
    try {
      await client.connect(made.transport);
      client.onNotification('notifications/tools/list_changed', () => {
        void this.#refreshTools(client);
      });
      client.onNotification('notifications/resources/list_changed', () => {
        void this.#refreshResources(client);
      });
      const hasResources = client.serverCapabilities?.resources !== undefined;
      const [tools, resources] = await Promise.all([
        client.serverCapabilities?.tools ? client.listTools() : [],
        hasResources ? this.#fetchResources(client) : { resources: [], resourceTemplates: [] },
      ]);
      if (this.closed) throw new Error('shut down while connecting');
      if (client.connectionState !== 'connected') throw new Error('connection closed during setup');
      this.#client = client;
      this.tools = tools;
      this.hasResources = hasResources;
      this.resources = resources.resources;
      this.resourceTemplates = resources.resourceTemplates;
      this.instructions = client.instructions?.trim() || undefined;
      this.missing = [];
      this.#seen = true;
      this.state = 'connected';
      this.error = undefined;
      this.#options.onTools(this);
      this.#options.onChange?.(this);
      return client;
    } catch (error) {
      await closeClient();
      throw error;
    } finally {
      this.#shutdown.signal.removeEventListener('abort', closeClient);
    }
  }

  async #fetchResources(client: McpClient) {
    const [resources, resourceTemplates] = await Promise.all([
      client.listResources().catch(() => [] as Resource[]),
      withoutTemplates(() => client.listResourceTemplates(), [] as ResourceTemplate[]).catch(
        () => [] as ResourceTemplate[]
      ),
    ]);
    return {
      resources: resources.filter((resource) => !isMcpApp(resource)),
      resourceTemplates: resourceTemplates.filter((template) => !isMcpApp(template)),
    };
  }

  #failed(error: unknown): Error {
    if (error instanceof MissingSecret) {
      this.#mark('needs-secret');
      return new Error(error.message);
    }
    if (error instanceof McpAuthRequiredError && !this.closed) {
      this.#mark('needs-auth');
      return new Error(this.signInMessage());
    }
    this.#mark(this.closed ? 'closed' : 'failed', errorMessage(error));
    return new Error(`MCP server "${this.name}" failed to connect: ${this.error}`);
  }

  async #refreshTools(client: McpClient): Promise<void> {
    try {
      const tools = await client.listTools();
      if (this.#client !== client || this.closed) return;
      this.tools = tools;
      this.#options.onTools(this);
    } catch (error) {
      this.error = `Failed to refresh tools: ${errorMessage(error)}`;
    }
    this.#options.onChange?.(this);
  }

  async #refreshResources(client: McpClient): Promise<void> {
    const { resources, resourceTemplates } = await this.#fetchResources(client);
    if (this.#client !== client || this.closed) return;
    this.resources = resources;
    this.resourceTemplates = resourceTemplates;
    this.#options.onTools(this);
    this.#options.onChange?.(this);
  }

  async close(): Promise<void> {
    this.#shutdown.abort();
    this.state = 'closed';
    this.#options.onChange?.(this);
    const client = this.#client;
    this.#client = undefined;
    await Promise.allSettled([client?.close(), this.#opening]);
  }
}

export class MissingSecret extends Error {
  readonly names: string[];

  constructor(names: string[]) {
    super(
      `needs ${names.map((name) => `\${${name}}`).join(', ')}: add the value in Settings › Accounts`
    );
    this.names = names;
  }
}
