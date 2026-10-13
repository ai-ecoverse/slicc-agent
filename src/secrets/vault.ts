import type {
  AgentRecord,
  ErrorCode,
  McpServerEntry,
  ModelEndpoint,
  OAuthConfig,
  OutgoingRequest,
} from '@ai-ecoverse/slicc-vault';
import { type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Scrub, Scrubbable, ScrubStream } from './scrub.ts';
import { vaultHold } from './view.ts';

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

type Message = Record<string, unknown> & { v: 1; id: number; op: string };

export class VaultRefusal extends Error {
  readonly code: ErrorCode | undefined;

  constructor(code: ErrorCode | undefined, message: string) {
    super(message);
    this.name = 'VaultRefusal';
    this.code = code;
  }
}

export type RefreshTarget = { server: string } | { provider: string };

export interface Granted {
  response: string | Uint8Array;
  records: { kind: string; name: string; placeholder: string }[];
  expiresAt?: number;
}

export interface EndpointSet {
  model: ModelEndpoint[];
  mcp: McpServerEntry[];
}

interface Pending {
  message: Message;
  at: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type Answer = Record<string, unknown> & {
  id?: unknown;
  error?: { code?: ErrorCode; message?: string };
  scrub?: unknown;
  locked?: unknown;
  version?: unknown;
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
  readonly #streams = new Set<string>();
  readonly #waiters = new Set<() => void>();
  readonly #now: () => number;
  #port: MessagePort | undefined;
  #pair: ScrubPair = { needed: false, version: 0 };
  #locked: Locked = 'no';
  #seen = 0;
  #serial = 0;
  #streamSerial = 0;
  readonly #tag = Math.random().toString(36).slice(2, 10);

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.state = replicatedState<VaultState>(this.#snapshot());
  }

  get needed(): boolean {
    return this.#pair.needed || this.#seen > this.#pair.version;
  }

  get connected(): boolean {
    return this.#port !== undefined;
  }

  connect(port: MessagePort | undefined, scrub: unknown): void {
    const pair = scrub === undefined ? undefined : pairOf(scrub);
    if (pair) this.#pair = pair;
    if (port && port !== this.#port) {
      if (this.#port) this.#port.onmessage = null;
      this.#port = port;
      port.onmessage = (event) => this.#answer(event.data as Answer);
      port.start?.();
      const resend = [...this.#pending.values()];
      const opening = new Set(
        resend
          .filter((item) => item.message.op === 'redactStream')
          .map((item) => item.message.stream)
      );
      for (const stream of this.#streams)
        if (!opening.has(stream)) void this.#call('redactStream', { stream });
      for (const item of resend) port.postMessage(item.message);
    }
    this.#refresh();
  }

  ready(): Promise<void> {
    if (!this.#holding()) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.add(resolve));
  }

  async texts<T extends Scrubbable>(texts: readonly T[]): Promise<T[]> {
    if (!this.needed) return [...texts];
    const answer = (await this.#call('redact', { texts: [...texts] })) as { texts: T[] };
    return answer.texts;
  }

  async model(provider: string | undefined, request: OutgoingRequest): Promise<OutgoingRequest> {
    const fields = provider === undefined ? { request } : { provider, request };
    return ((await this.#call('model', fields)) as { request: OutgoingRequest }).request;
  }

  async mcp(server: string, request: OutgoingRequest): Promise<OutgoingRequest> {
    return ((await this.#call('mcp', { server, request })) as { request: OutgoingRequest }).request;
  }

  async records(): Promise<AgentRecord[]> {
    return ((await this.#call('records', {})) as { records: AgentRecord[] }).records;
  }

  async grant(
    server: string,
    response: string | Uint8Array,
    oauth: OAuthConfig,
    name?: string
  ): Promise<Granted> {
    const fields = { server, response, oauth, ...(name === undefined ? {} : { name }) };
    const { response: shown, records, expiresAt } = (await this.#call('grant', fields)) as Granted;
    return { response: shown, records, ...(expiresAt === undefined ? {} : { expiresAt }) };
  }

  async refresh(target: RefreshTarget, name?: string): Promise<string> {
    const fields = { ...target, ...(name === undefined ? {} : { name }) };
    return ((await this.#call('refresh', fields)) as { state: string }).state;
  }

  async endpoints(set: EndpointSet): Promise<void> {
    await this.#call('endpoints', { model: set.model, mcp: set.mcp });
  }

  stream(): ScrubStream {
    let stream: string | undefined;
    return {
      push: (chunk) => {
        if (stream === undefined && !this.needed) return Promise.resolve(chunk);
        if (stream === undefined) {
          stream = `${this.#tag}-${++this.#streamSerial}`;
          this.#streams.add(stream);
          void this.#call('redactStream', { stream });
        }
        return this.#call('push', { stream, chunk }).then(
          (answer) => (answer as { chunk: Uint8Array }).chunk
        );
      },
      end: async () => {
        if (stream === undefined) return EMPTY;
        const { chunk: tail } = (await this.#call('end', { stream })) as { chunk: Uint8Array };
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
            item.resolve({ chunk: EMPTY });
          }
        void this.#call('drop', { stream: dropped });
      },
    };
  }

  #call(op: string, fields: Record<string, unknown>): Promise<unknown> {
    const message: Message = { v: 1, id: ++this.#serial, op, ...fields };
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
    if (data.op === 'welcome') this.#welcome(data.status);
    const item = typeof data.id === 'number' ? this.#pending.get(data.id) : undefined;
    if (item) {
      this.#pending.delete(data.id as number);
      if (typeof data.version === 'number') this.#seen = Math.max(this.#seen, data.version);
      if (data.error)
        item.reject(new VaultRefusal(data.error.code, data.error.message ?? 'the vault refused'));
      else item.resolve(data);
    }
    this.#refresh();
  }

  #welcome(status: unknown): void {
    const given = status as { scrub?: unknown; locked?: unknown } | null;
    const pair = given?.scrub ? pairOf(given.scrub) : undefined;
    if (pair) this.#pair = pair;
    if (typeof given?.locked === 'boolean') this.#locked = given.locked ? 'passkey' : 'no';
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
  const hold = vaultHold(state);
  if (!hold) return undefined;
  return hold.reason === 'locked' ? 'unlock the vault to continue' : WAITING;
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
