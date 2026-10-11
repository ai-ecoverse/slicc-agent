import type { CredentialStore } from '@earendil-works/pi-ai';
import type { McpFetch } from '@earendil-works/pi-mcp';
import type { AccountState } from '../services.ts';
import type { McpCatalog } from './catalog.ts';
import type { McpServerEntry } from './config.ts';
import type { McpServerConnection } from './connection.ts';
import { credentialKey, secretNames } from './credentials.ts';
import { MCP_ACCOUNT } from './label.ts';
import { beginSignIn, finishSignIn, type McpSignIn, type StoredOAuth } from './oauth.ts';

export interface McpAccounts {
  accounts(): Promise<AccountState[]>;
  signIn(id: string): Promise<McpSignIn>;
  connect(id: string, secret: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

export interface AccountSources {
  credentials: CredentialStore;
  oauth: (entry: McpServerEntry) => StoredOAuth;
  fetch: McpFetch;
}

type Kind = 'token' | 'oauth';

function kindOf(connection: McpServerConnection): Kind {
  return secretNames(connection.entry.config).length ? 'token' : 'oauth';
}

function row(connection: McpServerConnection, kind: Kind, stored: boolean): AccountState {
  const rejected = connection.state === 'needs-auth';
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
    ...(kind === 'token' ? { secret: 'token' as const } : {}),
  };
}

export function mcpAccounts(
  catalog: McpCatalog,
  sources: AccountSources,
  restart: (connection: McpServerConnection) => void,
  listeners: Set<() => void>
): McpAccounts {
  const { credentials } = sources;
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
  const keyOf = (connection: McpServerConnection) =>
    credentialKey(connection.name, connection.entry.config.url);
  return {
    async accounts() {
      const rows: AccountState[] = [];
      for (const connection of catalog.connections.values()) {
        const kind = kindOf(connection);
        const stored =
          kind === 'token'
            ? (await credentials.read(await keyOf(connection))) !== undefined
            : await sources.oauth(connection.entry).signedIn();
        if (kind === 'oauth' && !stored && connection.state !== 'needs-auth') continue;
        rows.push(row(connection, kind, stored));
      }
      return rows;
    },
    async signIn(id) {
      const { connection } = find(id, 'oauth');
      return beginSignIn(sources.oauth(connection.entry), connection.entry, {
        fetch: sources.fetch,
      });
    },
    async connect(id, secret) {
      const { connection, kind } = find(id);
      if (kind === 'oauth')
        await finishSignIn(
          sources.oauth(connection.entry),
          connection.entry,
          secret,
          sources.fetch
        );
      else
        await credentials.modify(await keyOf(connection), async () => ({
          type: 'api_key',
          key: secret,
        }));
      restart(connection);
    },
    async disconnect(id) {
      const { connection } = find(id);
      await credentials.delete(await keyOf(connection));
      restart(connection);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
