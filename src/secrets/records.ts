import type { AgentRecord } from '@ai-ecoverse/slicc-vault';
import { type Context, type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Vault } from './vault.ts';

export type { AgentRecord } from '@ai-ecoverse/slicc-vault';

export interface VaultRecords {
  readonly state: MutableReplicatedState<AgentRecord[]>;
  refresh(context: Context): Promise<void>;
  model(provider: string): AgentRecord | undefined;
  mcp(server: string, name?: string): AgentRecord | undefined;
  rejecting(provider: string): () => void;
  close(): void;
}

type Source = Pick<Vault, 'state' | 'records' | 'connected' | 'needed'>;

const MAX_DELAY = 2 ** 31 - 1;

export function lapsed(record: Pick<AgentRecord, 'state' | 'expiresAt'>, now: number): boolean {
  if (record.state === 'refreshing') return false;
  return record.state !== 'ready' || (record.expiresAt !== undefined && record.expiresAt <= now);
}

const keyOf = (record: AgentRecord) =>
  JSON.stringify([record.kind, record.name, record.placeholder, record.expiresAt ?? null]);

export function vaultRecords(vault: Source, now: () => number = Date.now): VaultRecords {
  const state = replicatedState<AgentRecord[]>([]);
  let version = vault.state.value.version;
  let port = vault.state.value.port;
  let lock: Promise<unknown> = Promise.resolve();
  let raw: AgentRecord[] = [];
  let refused = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const derive = (records: AgentRecord[]) => {
    const at = now();
    return records.map((record) =>
      record.state !== 'expired' && (lapsed(record, at) || refused.has(keyOf(record)))
        ? { ...record, state: 'expired' as const }
        : record
    );
  };
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const at = now();
    const due = state.value
      .filter((record) => record.state === 'ready' && record.expiresAt !== undefined)
      .map((record) => record.expiresAt as number);
    if (!due.length) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        apply(BACKGROUND_CONTEXT);
        void refresh(BACKGROUND_CONTEXT).catch(() => undefined);
      },
      Math.min(MAX_DELAY, Math.max(0, Math.min(...due) - at))
    );
    (timer as { unref?: () => void }).unref?.();
  };
  const apply = (context: Context) => {
    state.replace(context, derive(raw));
    arm();
  };
  const read = async () => (vault.connected || vault.needed ? vault.records() : []);
  const refresh = (context: Context) => {
    const run = lock.then(async () => {
      raw = await read();
      const held = new Set(raw.map(keyOf));
      refused = new Map([...refused].filter(([key, seen]) => held.has(key) && seen === version));
      apply(context);
    });
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
  const model = (provider: string) => of('model').find((record) => record.provider === provider);
  return {
    state,
    refresh,
    model,
    mcp: (server, name) => {
      const own = of('mcp').filter((record) => record.server === server);
      if (name === undefined) return own[0];
      return (
        own.find((record) => record.name === name) ??
        of('mcp').find((record) => record.server === undefined && record.name === name)
      );
    },
    rejecting(provider) {
      const seen = version;
      const record = raw.find((item) => item.kind === 'model' && item.provider === provider);
      const key = record && keyOf(record);
      return () => {
        if (!key || version !== seen || refused.has(key)) return;
        if (!raw.some((item) => keyOf(item) === key)) return;
        refused.set(key, seen);
        apply(BACKGROUND_CONTEXT);
      };
    },
    close() {
      off();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
