import type { AgentRecord } from '@ai-ecoverse/slicc-vault';
import { type Context, type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import type { Vault } from './vault.ts';

export type { AgentRecord } from '@ai-ecoverse/slicc-vault';

export interface VaultRecords {
  readonly state: MutableReplicatedState<AgentRecord[]>;
  refresh(context: Context): Promise<void>;
  model(provider: string): AgentRecord | undefined;
  mcp(server: string, name?: string): AgentRecord | undefined;
  close(): void;
}

type Source = Pick<Vault, 'state' | 'records' | 'connected' | 'needed'>;

export function vaultRecords(vault: Source): VaultRecords {
  const state = replicatedState<AgentRecord[]>([]);
  let version = vault.state.value.version;
  let port = vault.state.value.port;
  let lock: Promise<unknown> = Promise.resolve();
  const read = async () => (vault.connected || vault.needed ? vault.records() : []);
  const refresh = (context: Context) => {
    const run = lock.then(async () => state.replace(context, await read()));
    lock = run.catch(() => undefined);
    return run;
  };
  const off = vault.state.subscribe((value, context) => {
    const bumped = value.version !== version || (port === 'none' && value.port !== 'none');
    version = value.version;
    port = value.port;
    if (bumped) void refresh(context).catch(() => undefined);
  });
  const of = (kind: AgentRecord['kind']) => state.value.filter((record) => record.kind === kind);
  return {
    state,
    refresh,
    model: (provider) => of('model').find((record) => record.provider === provider),
    mcp: (server, name) => {
      const own = of('mcp').filter((record) => record.server === server);
      if (name === undefined) return own[0];
      return (
        own.find((record) => record.name === name) ??
        of('mcp').find((record) => record.server === undefined && record.name === name)
      );
    },
    close: off,
  };
}
