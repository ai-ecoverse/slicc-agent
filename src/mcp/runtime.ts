import type { Context } from '@earendil-works/chord';
import type { CredentialStore } from '@earendil-works/pi-ai';
import type { Registry } from '@earendil-works/pi-durable';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import { StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { LickEvent, Licks } from '../licks/licks.ts';
import type { AccountState } from '../services.ts';
import { McpCatalog } from './catalog.ts';
import {
  type McpConfigProblem,
  type McpServerEntry,
  parseMcpConfig,
  sameConfig,
} from './config.ts';
import { McpServerConnection } from './connection.ts';
import { credentialKey, resolveHeaders, scrub, secretNames } from './credentials.ts';
import { MCP_ACCOUNT } from './label.ts';
import { patchSse } from './sse.ts';

export const MCP_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function configPath(home: string): string {
  return `${home}/.pi/agent/mcp.json`;
}

export function logPath(home: string): string {
  return `${home}/.pi/agent/mcp.log`;
}

export interface McpAttach {
  licks: Licks;
  env: ExecutionEnv;
  home: string;
  credentials: CredentialStore;
  fetch: typeof fetch;
  version: string;
  reloadMs: number;
  codemode: boolean;
  cors: boolean;
}

export interface ServerStatus {
  name: string;
  state: string;
  tools: number;
  error?: string;
}

export interface McpAccounts {
  accounts(): Promise<AccountState[]>;
  connect(id: string, secret: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

export interface McpRuntime extends McpAccounts {
  status(): ServerStatus[];
  reload(context: Context): Promise<void>;
  close(context: Context): Promise<void>;
}

export function problemLick(problem: McpConfigProblem, home: string): LickEvent {
  const file = `~${configPath(home).slice(home.length)}`;
  const where = problem.server ? `server "${problem.server}"` : file;
  const field = problem.field ? `, field ${problem.field}` : '';
  return {
    channel: 'fswatch',
    source: `mcp:${file}`,
    title: `MCP config problem: ${where}${field}`,
    text: problem.message,
    body: `${file}: the entry is skipped until it is fixed. The format is in the slicc-agent README.`,
    target: 'cone',
    severity: 'warn',
    eventId: `${problem.server ?? ''}\n${problem.field ?? ''}\n${problem.message}`,
  };
}

const CORS_ERROR = /failed to fetch|networkerror|load failed|cors/i;

export function stateLick(connection: McpServerConnection, cors: boolean): LickEvent | undefined {
  const name = connection.name;
  const base = { channel: 'fswatch' as const, source: `mcp:${name}`, target: 'cone' as const };
  if (connection.state === 'needs-secret')
    return {
      ...base,
      title: `MCP server "${name}" needs a token`,
      text: `Its headers use ${connection.missing.map((item) => `\${${item}}`).join(', ')}. Add the value in Settings › MCP servers.`,
      severity: 'warn',
      eventId: `${name}\nsecret\n${connection.missing.join(',')}`,
    };
  if (connection.state === 'needs-auth')
    return {
      ...base,
      title: `MCP server "${name}" rejected its token`,
      text: connection.signInMessage(),
      severity: 'warn',
      eventId: `${name}\nauth`,
    };
  if (connection.state !== 'failed') return undefined;
  const error = scrub(connection.error ?? 'unknown error', connection.secrets);
  const blocked = cors && CORS_ERROR.test(error);
  return {
    ...base,
    title: `MCP server "${name}" can't connect`,
    text: blocked
      ? "Seven reaches it with the page's own fetch, and the server sends no CORS headers. Run slicc-node, slicc-swift or the SLICC extension, which fetch without CORS."
      : error,
    severity: 'warn',
    eventId: `${name}\nfailed\n${blocked ? 'cors' : error}`,
  };
}

export function connectedLick(connection: McpServerConnection): LickEvent {
  const count = connection.tools.length;
  return {
    channel: 'fswatch',
    source: `mcp:${connection.name}`,
    title: `MCP server "${connection.name}" connected`,
    text: `${connection.entry.config.url} offers ${count} tool${count === 1 ? '' : 's'}.`,
    target: 'cone',
    eventId: `${connection.name}\nconnected\n${connection.entry.config.url}`,
  };
}

export function logLine(
  server: string,
  params: unknown,
  secrets: readonly string[],
  at: Date
): string {
  const { level, logger, data } = (params ?? {}) as {
    level?: string;
    logger?: string;
    data?: unknown;
  };
  const text = scrub(typeof data === 'string' ? data : (JSON.stringify(data) ?? ''), secrets);
  return `${at.toISOString()} [${server}] ${level ?? 'info'}${logger ? ` ${logger}` : ''}: ${text}\n`;
}

function serverLog(options: McpAttach, context: Context) {
  let logging = Promise.resolve();
  const path = logPath(options.home);
  const { env } = options;
  return {
    write(connection: McpServerConnection, params: unknown) {
      const line = logLine(connection.name, params, connection.secrets, new Date());
      logging = logging.then(async () => {
        const info = await env.fileInfo(path, context);
        if (info.ok && info.value.size > MCP_LOG_MAX_BYTES)
          await env.renameFile(path, `${path}.1`, context);
        await env.appendFile(path, line, context);
      });
    },
    settled: () => logging,
  };
}

export function mcpAccounts(
  catalog: McpCatalog,
  credentials: CredentialStore,
  restart: (connection: McpServerConnection) => void,
  listeners: Set<() => void>
): McpAccounts {
  const find = (id: string) => {
    const connection = catalog.connections.get(id.slice(MCP_ACCOUNT.length));
    if (!id.startsWith(MCP_ACCOUNT) || !connection || !secretNames(connection.entry.config).length)
      throw new Error(`${id} is not an MCP server that takes a token`);
    return connection;
  };
  const keyOf = (connection: McpServerConnection) =>
    credentialKey(connection.name, connection.entry.config.url);
  return {
    async accounts() {
      const rows: AccountState[] = [];
      for (const connection of catalog.connections.values()) {
        if (!secretNames(connection.entry.config).length) continue;
        const stored = (await credentials.read(await keyOf(connection))) !== undefined;
        rows.push({
          id: `${MCP_ACCOUNT}${connection.name}`,
          provider: connection.name,
          identity: new URL(connection.entry.config.url).host,
          status:
            connection.state === 'needs-auth' ? 'expired' : stored ? 'connected' : 'disconnected',
          auth: 'api-key',
          needs: null,
          group: 'mcp',
          secret: 'token',
        });
      }
      return rows;
    },
    async connect(id, secret) {
      const connection = find(id);
      await credentials.modify(await keyOf(connection), async () => ({
        type: 'api_key',
        key: secret,
      }));
      restart(connection);
    },
    async disconnect(id) {
      const connection = find(id);
      await credentials.delete(await keyOf(connection));
      restart(connection);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export async function attachMcp(
  catalog: McpCatalog,
  options: McpAttach,
  context: Context
): Promise<McpRuntime> {
  const { env, home } = options;
  catalog.codemodeOn = options.codemode;
  const reported = new Set<string>();
  const report = async (lick: LickEvent | undefined, using: Context) => {
    if (!lick?.eventId || reported.has(lick.eventId)) return;
    reported.add(lick.eventId);
    await options.licks.deliver(lick, using).catch(() => undefined);
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let initial: Set<string> = new Set();
  let first = true;
  const log = serverLog(options, context);
  const make = (url: string, headers: Record<string, string>) =>
    new StreamableHttpTransport({
      url,
      headers,
      fetch: (input, init) => options.fetch(input, init),
    });
  const transport = async (entry: McpServerEntry) => {
    const resolved = await resolveHeaders(entry.name, entry.config, options.credentials);
    if (!resolved.ok) return { missing: resolved.missing };
    return { transport: make(entry.config.url, resolved.headers), secrets: resolved.secrets };
  };
  const open = (entry: McpServerEntry) => {
    const connection = new McpServerConnection({
      entry,
      version: options.version,
      transport,
      onTools: () => catalog.rebuild(),
      onLog: log.write,
      onChange: (changed) => {
        if (catalog.connections.get(changed.name) !== changed) return;
        if (changed.state === 'connected' && !initial.has(changed.name))
          void report(connectedLick(changed), context);
        void report(stateLick(changed, options.cors), context);
        if (changed.state !== 'connected') catalog.rebuild();
        notify();
      },
    });
    catalog.connections.set(entry.name, connection);
    void connection.getClient().catch(() => undefined);
  };
  const reload = async (using: Context) => {
    const read = await env.readTextFile(configPath(home), using);
    const parsed = parseMcpConfig(read.ok ? read.value : undefined);
    for (const problem of parsed.problems) await report(problemLick(problem, home), using);
    const wanted = new Map(
      parsed.servers
        .filter((entry) => entry.config.enabled !== false)
        .map((entry) => [entry.name, entry])
    );
    const closing: Promise<void>[] = [];
    for (const [name, connection] of [...catalog.connections]) {
      const next = wanted.get(name);
      if (next && sameConfig(next.config, connection.entry.config)) continue;
      catalog.connections.delete(name);
      closing.push(connection.close());
    }
    if (first) initial = new Set(wanted.keys());
    first = false;
    for (const [name, entry] of wanted) if (!catalog.connections.has(name)) open(entry);
    catalog.rebuild();
    notify();
    await Promise.all(closing);
  };
  await reload(context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void reload(context).catch(() => undefined), options.reloadMs);
  };
  const watched = await env.watch([{ path: configPath(home) }], schedule, context);
  const watcher: FileWatcher | undefined = watched.ok ? watched.value : undefined;
  const restart = (connection: McpServerConnection) => {
    catalog.connections.delete(connection.name);
    void connection.close();
    open(connection.entry);
    catalog.rebuild();
  };
  return {
    ...mcpAccounts(catalog, options.credentials, restart, listeners),
    status: () =>
      [...catalog.connections.values()].map((connection) => ({
        name: connection.name,
        state: connection.state,
        tools: connection.tools.length,
        ...(connection.error ? { error: scrub(connection.error, connection.secrets) } : {}),
      })),
    reload,
    async close(using) {
      clearTimeout(timer);
      await watcher?.close(using);
      const all = [...catalog.connections.values()];
      catalog.connections.clear();
      await Promise.all(all.map((connection) => connection.close()));
      catalog.rebuild();
      await log.settled();
    },
  };
}

export async function startMcp(
  registry: Registry,
  options: McpAttach,
  context: Context
): Promise<{ catalog: McpCatalog; runtime: McpRuntime }> {
  patchSse();
  const catalog = new McpCatalog(registry);
  return { catalog, runtime: await attachMcp(catalog, options, context) };
}
