import type { Frame as ChordFrame, Link } from '@earendil-works/chord';

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

export type Frame = { hello: string } | { close: true } | Uint8Array;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parse(chunk: Uint8Array): ChordFrame {
  const frame = JSON.parse(decoder.decode(chunk)) as { t?: unknown } | null;
  if (frame === null || typeof frame !== 'object' || typeof frame.t !== 'string')
    throw new TypeError('not a chord frame');
  return frame as ChordFrame;
}

export class PortLink implements Link {
  readonly hello: Promise<string>;
  readonly ended: Promise<Error | undefined>;
  readonly #endpoint: PortEndpoint;
  readonly #queue: Uint8Array[] = [];
  readonly #closers = new Set<(reason: string) => void>();
  #handler: ((frame: ChordFrame) => void) | undefined;
  #closed = false;
  #greet!: (hello: string) => void;
  #refuse!: (error: Error) => void;
  #finish!: (reason: Error | undefined) => void;

  constructor(endpoint: PortEndpoint) {
    this.#endpoint = endpoint;
    this.hello = new Promise((greet, refuse) => {
      this.#greet = greet;
      this.#refuse = refuse;
    });
    this.hello.catch(() => undefined);
    this.ended = new Promise((finish) => {
      this.#finish = finish;
    });
    endpoint.addEventListener('message', ({ data }) => this.#receive(data as Frame));
    const failed = (event: Event) => this.#end(`agent port ${event.type}`, true);
    endpoint.addEventListener('messageerror', failed);
    endpoint.addEventListener('error', failed);
    endpoint.addEventListener('close', () => this.#end('peer closed', false));
    endpoint.start?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  greet(serverId: string): void {
    this.#endpoint.postMessage({ hello: serverId } satisfies Frame);
  }

  send(frame: ChordFrame): void {
    if (this.#closed) return;
    const bytes = encoder.encode(JSON.stringify(frame));
    this.#endpoint.postMessage(bytes, [bytes.buffer]);
  }

  receive(handler: (frame: ChordFrame) => void): void {
    this.#handler = handler;
    for (const chunk of this.#queue.splice(0)) this.#deliver(chunk);
  }

  onClose(handler: (reason: string) => void): void {
    if (this.#closed) handler('closed');
    else this.#closers.add(handler);
  }

  close(reason = 'closed'): void {
    if (this.#closed) return;
    this.send({ t: 'bye', reason });
    this.#endpoint.postMessage({ close: true } satisfies Frame);
    this.#end(reason, false);
  }

  #receive(frame: Frame): void {
    if (this.#closed) return;
    if (frame instanceof Uint8Array) {
      if (this.#handler) this.#deliver(frame);
      else this.#queue.push(frame);
    } else if ('hello' in frame) this.#greet(frame.hello);
    else this.#end('peer closed', false);
  }

  #deliver(chunk: Uint8Array): void {
    let frame: ChordFrame;
    try {
      frame = parse(chunk);
    } catch {
      this.close('protocol error');
      return;
    }
    if (frame.t === 'bye') this.#end(frame.reason ?? 'peer closed', false);
    else this.#handler?.(frame);
  }

  #end(reason: string, failed: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#endpoint.close?.();
    const error = new Error(reason);
    this.#refuse(new Error(`agent port closed before hello: ${reason}`));
    this.#finish(failed ? error : undefined);
    for (const handler of [...this.#closers]) handler(reason);
    this.#closers.clear();
  }
}
