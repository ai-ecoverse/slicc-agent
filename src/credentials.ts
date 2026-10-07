import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

export const CREDENTIALS_DATABASE = 'slicc-agent-credentials';

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function open(name: string): Promise<IDBDatabase> {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('keys');
    opening.result.createObjectStore('credentials');
  };
  return request(opening);
}

async function sealingKey(db: IDBDatabase): Promise<CryptoKey> {
  const keys = db.transaction('keys', 'readonly').objectStore('keys');
  const existing = (await request(keys.get('aes'))) as CryptoKey | undefined;
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const store = db.transaction('keys', 'readwrite').objectStore('keys');
  await request(store.add(key, 'aes')).catch(() => undefined);
  return (await request(
    db.transaction('keys', 'readonly').objectStore('keys').get('aes')
  )) as CryptoKey;
}

export class EncryptedCredentialStore implements CredentialStore {
  readonly #db: IDBDatabase;
  readonly #key: CryptoKey;
  readonly #chains = new Map<string, Promise<unknown>>();

  private constructor(db: IDBDatabase, key: CryptoKey) {
    this.#db = db;
    this.#key = key;
  }

  static async open(name = CREDENTIALS_DATABASE): Promise<EncryptedCredentialStore> {
    const db = await open(name);
    return new EncryptedCredentialStore(db, await sealingKey(db));
  }

  #store(mode: IDBTransactionMode): IDBObjectStore {
    return this.#db.transaction('credentials', mode).objectStore('credentials');
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const sealed = (await request(this.#store('readonly').get(providerId))) as Sealed | undefined;
    if (!sealed) return undefined;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv },
      this.#key,
      sealed.data
    );
    return JSON.parse(new TextDecoder().decode(plain)) as Credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const ids = (await request(this.#store('readonly').getAllKeys())) as string[];
    const found: CredentialInfo[] = [];
    for (const providerId of ids) {
      const credential = await this.read(providerId);
      if (credential) found.push({ providerId, type: credential.type });
    }
    return found;
  }

  #serial<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(providerId) ?? Promise.resolve()).then(operation);
    this.#chains.set(
      providerId,
      result.catch(() => undefined)
    );
    return result;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.#serial(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        this.#key,
        new TextEncoder().encode(JSON.stringify(next))
      );
      await request(this.#store('readwrite').put({ iv, data } satisfies Sealed, providerId));
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serial(providerId, async () => {
      await request(this.#store('readwrite').delete(providerId));
    });
  }

  close(): void {
    this.#db.close();
  }
}
