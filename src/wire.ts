import type { Link } from '@earendil-works/chord';

export interface PortEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(
    type: 'close' | 'messageerror' | 'error',
    listener: (event: Event) => void
  ): void;
  start?(): void;
  close?(): void;
}

export const WIRE = 2;

export const CHORD_PROTOCOL = 1;

export interface Hello {
  wire: number;
  chord: number;
  contracts?: string;
  server?: string;
}

export type Frame = { hello: unknown } | { close: true; reason?: string } | Uint8Array;

export const VERSION = 'version';

export const SEAT = 'seat';

export const OTHER_VERSION =
  "That SLICC runs another version of the agent, so this tab can't follow it. Update both SLICCs, then reload this page.";

export const otherVersion = (cause?: unknown): Error =>
  Object.assign(new Error(OTHER_VERSION, cause === undefined ? undefined : { cause }), {
    code: 'EVERSION',
  });

export const otherService = (service: string, cause?: unknown): Error =>
  Object.assign(
    new Error(
      `That SLICC runs another version of the agent's ${service} service, so this tab can't use it. Update both SLICCs, then reload this page.`,
      cause === undefined ? undefined : { cause }
    ),
    { code: 'EVERSION', service }
  );

export class Refused extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`the agent refused the link: ${reason}`);
    this.reason = reason;
  }
}

const HELLO_TEXT = 4096;

const bounded = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && value.length <= HELLO_TEXT);

const greeting = (mine: Hello, theirs: unknown): Hello | undefined => {
  if (typeof theirs !== 'object' || theirs === null) return undefined;
  const { wire, chord, contracts, server } = theirs as Record<string, unknown>;
  if (wire !== mine.wire || chord !== mine.chord || !bounded(contracts) || !bounded(server))
    return undefined;
  return { wire: mine.wire, chord: mine.chord, ...(server === undefined ? {} : { server }) };
};

const owned = (bytes: Uint8Array): Uint8Array =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();

export function refuse(endpoint: PortEndpoint, reason: string): void {
  endpoint.postMessage({ close: true, reason } satisfies Frame);
  endpoint.close?.();
}

export class PortLink implements Link {
  readonly peer: Promise<Hello>;
  readonly ended: Promise<Error | undefined>;
  readonly #endpoint: PortEndpoint;
  readonly #mine: Hello;
  readonly #answers: boolean;
  readonly #outgoing: Uint8Array[] = [];
  readonly #incoming: Uint8Array[] = [];
  #listener: ((message: Uint8Array) => void) | undefined;
  #closer: (() => void) | undefined;
  #heard = false;
  #closed = false;
  #welcome!: (hello: Hello) => void;
  #unwelcome!: (error: Error) => void;
  #finish!: (reason: Error | undefined) => void;

  constructor(endpoint: PortEndpoint, mine: Hello, answers = false) {
    this.#endpoint = endpoint;
    this.#mine = mine;
    this.#answers = answers;
    this.peer = new Promise((welcome, unwelcome) => {
      this.#welcome = welcome;
      this.#unwelcome = unwelcome;
    });
    this.peer.catch(() => undefined);
    this.ended = new Promise((finish) => {
      this.#finish = finish;
    });
    endpoint.addEventListener('message', ({ data }) => this.#receive(data as Frame));
    const failed = (event: Event) => this.#end(new Error(`agent port ${event.type}`));
    endpoint.addEventListener('messageerror', failed);
    endpoint.addEventListener('error', failed);
    endpoint.addEventListener('close', () => this.#end(undefined));
    endpoint.start?.();
    if (!answers) endpoint.postMessage({ hello: mine } satisfies Frame);
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(message: Uint8Array): void {
    if (this.#closed) return;
    const bytes = owned(message);
    if (this.#heard) this.#endpoint.postMessage(bytes, [bytes.buffer as ArrayBuffer]);
    else this.#outgoing.push(bytes);
  }

  onMessage(listener: (message: Uint8Array) => void): void {
    if (this.#closed) return;
    this.#listener = listener;
    for (const message of this.#incoming.splice(0)) listener(message);
  }

  onClose(listener: () => void): void {
    if (this.#closed) listener();
    else this.#closer = listener;
  }

  close(): void {
    if (this.#closed) return;
    this.#endpoint.postMessage({ close: true } satisfies Frame);
    this.#end(undefined);
  }

  #receive(frame: Frame): void {
    if (this.#closed) return;
    if (frame instanceof Uint8Array) this.#chord(frame);
    else if (frame !== null && typeof frame === 'object' && 'hello' in frame)
      this.#hello(frame.hello);
    else this.#closing((frame as { reason?: unknown } | null)?.reason);
  }

  #chord(message: Uint8Array): void {
    if (!this.#heard) this.#mismatch();
    else if (this.#listener) this.#listener(message);
    else this.#incoming.push(message);
  }

  #hello(frame: unknown): void {
    const hello = this.#heard ? undefined : greeting(this.#mine, frame);
    if (!hello) {
      this.#mismatch();
      return;
    }
    this.#heard = true;
    if (this.#answers) this.#endpoint.postMessage({ hello: this.#mine } satisfies Frame);
    this.#welcome(hello);
    for (const bytes of this.#outgoing.splice(0))
      this.#endpoint.postMessage(bytes, [bytes.buffer as ArrayBuffer]);
  }

  #closing(reason: unknown): void {
    if (this.#heard) this.#end(undefined);
    else if (reason === VERSION) this.#end(otherVersion());
    else this.#end(new Refused(typeof reason === 'string' ? reason : 'closed'));
  }

  #mismatch(): void {
    this.#endpoint.postMessage({ close: true, reason: VERSION } satisfies Frame);
    this.#end(otherVersion());
  }

  #end(reason: Error | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outgoing.length = 0;
    this.#incoming.length = 0;
    this.#listener = undefined;
    this.#endpoint.close?.();
    this.#unwelcome(reason ?? new Refused('closed'));
    const closer = this.#closer;
    this.#closer = undefined;
    closer?.();
    this.#finish(reason);
  }
}
