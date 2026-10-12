import { type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Scrub, Scrubbable, ScrubStream } from './scrub.ts';

export type ScrubPair = { needed: boolean; version: number };
export type Locked = 'no' | 'scrubbing' | 'passkey';

export interface VaultState {
  port: 'none' | 'ready' | 'waiting';
  needed: boolean;
  version: number;
  locked: Locked;
  held: number;
}

export const WAITING_MS = 2000;
export const WAITING = 'waiting for the vault';

type Message = Record<string, unknown> & { id: number; op: string };

interface Pending {
  message: Message;
  at: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type Answer = {
  id?: unknown;
  ok?: unknown;
  error?: { message?: string };
  scrub?: unknown;
  locked?: unknown;
};

const LOCKS: readonly unknown[] = ['no', 'scrubbing', 'passkey'];

const EMPTY = new Uint8Array();

function pairOf(value: unknown): ScrubPair | undefined {
  const pair = value as Partial<ScrubPair> | null;
  if (pair === null) return { needed: false, version: 0 };
  if (typeof pair?.needed !== 'boolean' || typeof pair.version !== 'number') return undefined;
  return { needed: pair.needed, version: pair.version };
}

export class Vault implements Scrub {
  readonly state: MutableReplicatedState<VaultState>;
  readonly #pending = new Map<number, Pending>();
  readonly #streams = new Set<number>();
  readonly #waiters = new Set<() => void>();
  readonly #now: () => number;
  #port: MessagePort | undefined;
  #pair: ScrubPair = { needed: false, version: 0 };
  #locked: Locked = 'no';
  #seen = 0;
  #serial = 0;
  #streamSerial = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.state = replicatedState<VaultState>(this.#snapshot());
  }

  get needed(): boolean {
    return this.#pair.needed || this.#seen > this.#pair.version;
  }

  connect(port: MessagePort | undefined, scrub: unknown): void {
    const pair = scrub === undefined ? undefined : pairOf(scrub);
    if (pair) this.#pair = pair;
    if (port && port !== this.#port) {
      if (this.#port) this.#port.onmessage = null;
      this.#port = port;
      port.onmessage = (event) => this.#answer(event.data as Answer);
      port.start?.();
      const opening = new Set(
        [...this.#pending.values()]
          .filter((item) => item.message.op === 'redactStream')
          .map((item) => item.message.stream)
      );
      for (const stream of this.#streams)
        if (!opening.has(stream)) void this.#call('redactStream', { stream });
      for (const item of this.#pending.values()) port.postMessage(item.message);
    }
    this.#refresh();
  }

  ready(): Promise<void> {
    if (!this.#holding()) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.add(resolve));
  }

  async texts<T extends Scrubbable>(texts: readonly T[]): Promise<T[]> {
    if (!this.needed) return [...texts];
    const answer = (await this.#call('redact', { texts: [...texts] })) as {
      texts: T[];
      version?: number;
    };
    return answer.texts;
  }

  stream(): ScrubStream {
    let stream: number | undefined;
    return {
      push: (chunk) => {
        if (stream === undefined && !this.needed) return Promise.resolve(chunk);
        if (stream === undefined) {
          stream = ++this.#streamSerial;
          this.#streams.add(stream);
          void this.#call('redactStream', { stream });
        }
        return this.#call('push', { stream, chunk }) as Promise<Uint8Array>;
      },
      end: async () => {
        if (stream === undefined) return EMPTY;
        const tail = (await this.#call('end', { stream })) as Uint8Array;
        this.#streams.delete(stream);
        return tail;
      },
      drop: () => {
        if (stream === undefined) return;
        const dropped = stream;
        this.#streams.delete(dropped);
        for (const [id, item] of this.#pending)
          if (item.message.stream === dropped && item.message.op !== 'redactStream') {
            this.#pending.delete(id);
            item.resolve(EMPTY);
          }
        void this.#call('drop', { stream: dropped });
      },
    };
  }

  #call(op: string, fields: Record<string, unknown>): Promise<unknown> {
    const message: Message = { id: ++this.#serial, op, ...fields };
    const result = new Promise((resolve, reject) => {
      this.#pending.set(message.id, { message, at: this.#now(), resolve, reject });
    });
    this.#port?.postMessage(message);
    setTimeout(() => this.#refresh(), WAITING_MS);
    this.#refresh();
    return result;
  }

  #answer(data: Answer): void {
    if (!data || typeof data !== 'object') return;
    const pair = 'scrub' in data ? pairOf(data.scrub) : undefined;
    if (pair) this.#pair = pair;
    if (LOCKS.includes(data.locked)) this.#locked = data.locked as Locked;
    const item = typeof data.id === 'number' ? this.#pending.get(data.id) : undefined;
    if (item) {
      this.#pending.delete(data.id as number);
      const version = (data.ok as { version?: unknown } | undefined)?.version;
      if (typeof version === 'number') this.#seen = Math.max(this.#seen, version);
      if (data.error) item.reject(new Error(data.error.message ?? 'the vault refused'));
      else item.resolve(data.ok);
    }
    this.#refresh();
  }

  #waiting(): boolean {
    const now = this.#now();
    return [...this.#pending.values()].some((item) => now - item.at >= WAITING_MS);
  }

  #holding(): boolean {
    return this.needed && (!this.#port || this.#waiting() || this.#locked === 'passkey');
  }

  #snapshot(): VaultState {
    return {
      port: !this.#port ? 'none' : this.#waiting() ? 'waiting' : 'ready',
      needed: this.needed,
      version: this.#pair.version,
      locked: this.#locked,
      held: this.#pending.size,
    };
  }

  #refresh(): void {
    const next = this.#snapshot();
    const before = this.state.value;
    if (Object.entries(next).some(([key, value]) => before[key as keyof VaultState] !== value))
      this.state.replace(BACKGROUND_CONTEXT, next);
    if (this.#holding()) return;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}

export function holdText(state: VaultState): string | undefined {
  if (!state.needed) return undefined;
  if (state.locked === 'passkey') return 'unlock the vault to continue';
  return state.port === 'ready' ? undefined : WAITING;
}

export function listenVault(
  scope: { addEventListener(type: 'message', listener: (event: MessageEvent) => void): void },
  vault: Vault
): void {
  scope.addEventListener('message', ({ data }) => {
    const message = data as { vault?: MessagePort; scrub?: unknown } | null;
    if (!message || typeof message !== 'object' || !('vault' in message || 'scrub' in message))
      return;
    vault.connect(message.vault, message.scrub);
  });
}
