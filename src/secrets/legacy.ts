import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type Harness } from '@earendil-works/pi-durable';
import { deltasOnly } from '../checkpoints.ts';
import type { VaultRecords } from './records.ts';
import type { Vault } from './vault.ts';

export const LEGACY_DATABASE = 'slicc-agent-credentials';

export type MovedAccount =
  | { kind: 'model'; provider: string; label: string }
  | { kind: 'mcp'; server: string; label: string };

export type MovedState = {
  accounts: MovedAccount[];
  dismissed: boolean;
};

export const MovedDoc = defineDoc<MovedState>({
  kind: 'slicc.keys-moved',
  checkpointWhen: deltasOnly,
  version: 1,
  scope: 'session',
  initial: () => ({ accounts: [], dismissed: false }),
});

const NAMES: Record<string, string> = { adobe: 'Adobe', 'amazon-bedrock': 'Bedrock' };

function accountId(account: MovedAccount): string {
  return account.kind === 'mcp' ? `mcp:${account.server}` : account.provider;
}

export function movedAccount(key: string): MovedAccount {
  if (key.startsWith('mcp:')) {
    const server = key.slice(4).split('|')[0] as string;
    return { kind: 'mcp', server, label: server };
  }
  return { kind: 'model', provider: key, label: NAMES[key] ?? key };
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

async function legacyKeys(factory: IDBFactory): Promise<string[]> {
  const db = await request(factory.open(LEGACY_DATABASE));
  try {
    if (!db.objectStoreNames.contains('credentials')) return [];
    const store = db.transaction('credentials', 'readonly').objectStore('credentials');
    return ((await request(store.getAllKeys())) as IDBValidKey[]).map(String);
  } finally {
    db.close();
  }
}

function deleted(factory: IDBFactory): Promise<boolean> {
  return new Promise((resolve) => {
    const deleting = factory.deleteDatabase(LEGACY_DATABASE);
    deleting.onsuccess = () => resolve(true);
    deleting.onerror = () => resolve(false);
  });
}

export const WIPE_WAIT_MS = 3000;

export interface Wiped {
  now: MovedAccount[];
  later: Promise<MovedAccount[]>;
}

const nothing = (): Wiped => ({ now: [], later: Promise.resolve([]) });

export async function wipeLegacy(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  wait = WIPE_WAIT_MS
): Promise<Wiped> {
  if (!factory) return nothing();
  const listed = await factory.databases().catch(() => []);
  if (!listed.some((database) => database.name === LEGACY_DATABASE)) return nothing();
  const keys = await legacyKeys(factory).catch(() => []);
  const found = new Map(keys.map(movedAccount).map((account) => [accountId(account), account]));
  const done = deleted(factory).then((ok) => (ok ? [...found.values()] : []));
  const { promise: bound, resolve } = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => resolve(undefined), wait);
  const first = await Promise.race([done, bound]);
  clearTimeout(timer);
  return first ? { now: first, later: Promise.resolve([]) } : { now: [], later: done };
}

export type MovedName = { kind: 'model' | 'mcp'; label: string };

export interface KeysMoved {
  readonly state: ReplicatedState<MovedName[]>;
  dismiss(context: Context): Promise<void>;
}

type Records = Pick<VaultRecords, 'state' | 'model' | 'mcp' | 'refresh'>;

export async function keysMoved(
  harness: Pick<Harness, 'commit'>,
  sources: { records: Records; vault: Pick<Vault, 'connected'> },
  wiped: Wiped,
  context: Context = BACKGROUND_CONTEXT
): Promise<KeysMoved> {
  const { records, vault } = sources;
  const add = (accounts: readonly MovedAccount[], using: Context) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(MovedDoc);
      const known = new Set(doc.accounts.map(accountId));
      for (const account of accounts)
        if (!known.has(accountId(account))) doc.accounts.push(account);
      return JSON.parse(JSON.stringify(doc)) as MovedState;
    }, using);
  let saved = await add(wiped.now, context);
  let read = false;
  const missing = (account: MovedAccount) =>
    account.kind === 'mcp' ? !records.mcp(account.server) : !records.model(account.provider);
  const pending = () =>
    read && !saved.dismissed
      ? saved.accounts.filter(missing).map(({ kind, label }) => ({ kind, label }))
      : [];
  const state = replicatedState<MovedName[]>(pending());
  const update = (using: Context) => {
    const next = pending();
    if (JSON.stringify(next) !== JSON.stringify(state.value)) state.replace(using, next);
  };
  const mark = (using: Context) => {
    if (vault.connected) read = true;
    update(using);
  };
  records.state.subscribe((_value, using) => mark(using));
  wiped.later
    .then(async (late) => {
      if (!late.length) return;
      saved = await add(late, context);
      update(context);
    })
    .catch(() => undefined);
  void records.refresh(context).then(
    () => mark(context),
    () => undefined
  );
  return {
    state,
    async dismiss(using) {
      saved = await harness.commit(async (tx) => {
        const doc = await tx.doc(MovedDoc);
        doc.dismissed = true;
        return JSON.parse(JSON.stringify(doc)) as MovedState;
      }, using);
      update(using);
    },
  };
}
