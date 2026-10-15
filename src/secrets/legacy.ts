import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type Harness } from '@earendil-works/pi-durable';
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
    deleting.onblocked = () => resolve(true);
  });
}

export async function wipeLegacy(
  factory: IDBFactory | undefined = globalThis.indexedDB
): Promise<MovedAccount[]> {
  if (!factory) return [];
  const listed = await factory.databases().catch(() => []);
  if (!listed.some((database) => database.name === LEGACY_DATABASE)) return [];
  const keys = await legacyKeys(factory).catch(() => []);
  if (!(await deleted(factory))) return [];
  const found = new Map(keys.map(movedAccount).map((account) => [accountId(account), account]));
  return [...found.values()];
}

export interface KeysMoved {
  readonly state: ReplicatedState<string[]>;
  dismiss(context: Context): Promise<void>;
}

type Records = Pick<VaultRecords, 'state' | 'model' | 'mcp' | 'refresh'>;

export async function keysMoved(
  harness: Pick<Harness, 'commit'>,
  sources: { records: Records; vault: Pick<Vault, 'connected'> },
  wiped: readonly MovedAccount[],
  context: Context = BACKGROUND_CONTEXT
): Promise<KeysMoved> {
  const { records, vault } = sources;
  let saved = await harness.commit(async (tx) => {
    const doc = await tx.doc(MovedDoc);
    const known = new Set(doc.accounts.map(accountId));
    for (const account of wiped) if (!known.has(accountId(account))) doc.accounts.push(account);
    return JSON.parse(JSON.stringify(doc)) as MovedState;
  }, context);
  let read = false;
  const missing = (account: MovedAccount) =>
    account.kind === 'mcp' ? !records.mcp(account.server) : !records.model(account.provider);
  const pending = () =>
    read && !saved.dismissed ? saved.accounts.filter(missing).map((account) => account.label) : [];
  const state = replicatedState<string[]>(pending());
  const update = (using: Context) => {
    const next = pending();
    if (next.join('\n') !== state.value.join('\n')) state.replace(using, next);
  };
  const mark = (using: Context) => {
    if (vault.connected) read = true;
    update(using);
  };
  records.state.subscribe((_value, using) => mark(using));
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
