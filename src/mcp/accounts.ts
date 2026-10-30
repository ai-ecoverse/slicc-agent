import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { McpFetch } from '@earendil-works/pi-mcp';
import type { AccountState, McpEdit, McpRefusals, McpServerState } from '../services.ts';
import type { McpCatalog } from './catalog.ts';
import type { McpConfig, McpServerEntry } from './config.ts';
import type { McpServerConnection } from './connection.ts';
import { heldRecords, type McpRecords, resolveHeaders, secretNames } from './credentials.ts';
import type { McpFile } from './file.ts';
import { MCP_ACCOUNT } from './label.ts';
import { beginSignIn, finishSignIn, type McpSignIn, type StoredOAuth } from './oauth.ts';

export const TOKENS_IN_VAULT = "MCP tokens are kept in seven's vault: update seven";

export interface McpAccounts {
  accounts(): Promise<AccountState[]>;
  signIn(id: string): Promise<McpSignIn>;
  connect(id: string, secret: string | null): Promise<void>;
  disconnect(id: string): Promise<void>;
  serverUrl(id: string): Promise<string | null>;
  addServer(name: string, entry: unknown): Promise<McpEdit>;
  removeServer(id: string): Promise<McpEdit>;
  refusals(): Promise<McpRefusals>;
  onChange(listener: () => void): () => void;
}

export interface AccountSources {
  records: McpRecords & { refresh(context: Context): Promise<void> };
  oauth: (entry: McpServerEntry) => StoredOAuth;
  fetch: (server: string) => McpFetch;
  grant: (server: string) => McpFetch;
  register: (server: string, tokenUrl: string) => Promise<void>;
  listed: () => McpConfig;
  file: McpFile;
}

type Kind = 'token' | 'oauth';

function kindOf(connection: McpServerConnection): Kind {
  return secretNames(connection.entry.config).length ? 'token' : 'oauth';
}

export function serverUrl(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

function row(
  connection: McpServerConnection,
  kind: Kind,
  stored: boolean,
  expired: boolean
): AccountState {
  const rejected = connection.state === 'needs-auth' || (stored && expired);
  return {
    id: `${MCP_ACCOUNT}${connection.name}`,
    provider: connection.name,
    identity: new URL(connection.entry.config.url).host,
    status:
      rejected && (kind === 'token' || stored)
        ? 'expired'
        : stored && connection.live
          ? 'connected'
          : 'disconnected',
    auth: kind === 'token' ? 'api-key' : 'oauth',
    needs: null,
    group: 'mcp',
    store: 'vault',
    ...(kind === 'token' ? { secret: 'token' as const } : {}),
    state: connection.state as McpServerState,
  };
}

function plainRow(name: string, host: string, live: boolean, state: McpServerState): AccountState {
  return {
    id: `${MCP_ACCOUNT}${name}`,
    provider: name,
    identity: host,
    status: live ? 'connected' : 'disconnected',
    auth: 'local',
    needs: null,
    group: 'mcp',
    state,
  };
}

export function mcpAccounts(
  catalog: McpCatalog,
  sources: AccountSources,
  restart: (connection: McpServerConnection) => void,
  listeners: Set<() => void>
): McpAccounts {
  const { records } = sources;
  const find = (id: string, want?: Kind) => {
    const connection = id.startsWith(MCP_ACCOUNT)
      ? catalog.connections.get(id.slice(MCP_ACCOUNT.length))
      : undefined;
    const kind = connection && kindOf(connection);
    if (!connection || (want && kind !== want))
      throw new Error(
        `${id} is not an MCP server that ${want === 'oauth' ? 'signs in' : 'takes a token or a sign-in'}`
      );
    return { connection, kind: kind as Kind };
  };
  const reread = () => records.refresh(BACKGROUND_CONTEXT).catch(() => undefined);
  return {
    async accounts() {
      const rows: AccountState[] = [];
      const { servers, refused } = sources.listed();
      for (const { name, config } of servers) {
        const connection = catalog.connections.get(name);
        const host = new URL(config.url).host;
        if (!connection) {
          rows.push(plainRow(name, host, false, 'disabled'));
          continue;
        }
        const kind = kindOf(connection);
        const stored =
          kind === 'token'
            ? resolveHeaders(connection.name, connection.entry.config, records).ok
            : await sources.oauth(connection.entry).signedIn();
        if (kind === 'oauth' && !stored && connection.state !== 'needs-auth') {
          const state = connection.state as McpServerState;
          rows.push(plainRow(name, host, connection.live, state));
          continue;
        }
        const expired = heldRecords(connection.name, connection.entry.config, records).some(
          (record) => record?.state === 'expired'
        );
        rows.push(row(connection, kind, stored, expired));
      }
      for (const { name, host } of refused) rows.push(plainRow(name, host, false, 'refused'));
      return rows;
    },
    async signIn(id) {
      const { connection } = find(id, 'oauth');
      return beginSignIn(sources.oauth(connection.entry), connection.entry, {
        fetch: sources.fetch(connection.name),
        register: (tokenUrl) => sources.register(connection.name, tokenUrl),
      });
    },
    async connect(id, secret) {
      const { connection, kind } = find(id);
      if (kind === 'oauth') {
        if (secret === null) throw new Error(`${id} needs a sign-in`);
        await finishSignIn(
          sources.oauth(connection.entry),
          connection.entry,
          secret,
          sources.grant(connection.name)
        );
      } else if (secret !== null) throw new Error(TOKENS_IN_VAULT);
      await reread();
      restart(connection);
    },
    async disconnect(id) {
      const { connection, kind } = find(id);
      if (kind === 'oauth') await sources.oauth(connection.entry).forget();
      await reread();
      restart(connection);
    },
    async serverUrl(id) {
      const name = id.slice(MCP_ACCOUNT.length);
      const entry = sources.listed().servers.find((server) => server.name === name);
      return entry ? serverUrl(entry.config.url) : null;
    },
    addServer: (name, entry) => sources.file.add(name, entry),
    async removeServer(id) {
      if (!id.startsWith(MCP_ACCOUNT))
        return { ok: false, code: 'not-found', reason: `${id} is not an MCP server` };
      const { removed, ...edit } = await sources.file.remove(id.slice(MCP_ACCOUNT.length));
      if (removed) await sources.oauth(removed).forget();
      return edit as McpEdit;
    },
    async refusals() {
      const { refused } = sources.listed();
      return Object.fromEntries(refused.map(({ name, code, reason }) => [name, { code, reason }]));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
