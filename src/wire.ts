import { type Frame as ChordFrame, type Link, PROTOCOL_VERSION } from '@earendil-works/chord';

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

export const OTHER_VERSION =
  "That SLICC runs another version of the agent, so this tab can't follow it. Update both SLICCs, then reload this page.";

export const otherVersion = (cause?: unknown): Error =>
  Object.assign(new Error(OTHER_VERSION, cause === undefined ? undefined : { cause }), {
    code: 'EVERSION',
  });

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
  #held: Uint8Array[] | undefined;
  #heard = false;
  #legacy = false;
  #mismatch = false;
  #greet!: (hello: string) => void;
  #unwelcome!: (error: Error) => void;
  #finish!: (reason: Error | undefined) => void;

  constructor(endpoint: PortEndpoint) {
    this.#endpoint = endpoint;
    this.hello = new Promise((greet, unwelcome) => {
      this.#greet = greet;
      this.#unwelcome = unwelcome;
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
    this.#held ??= [];
    this.#endpoint.postMessage({ hello: serverId } satisfies Frame);
  }

  mismatched(): void {
    this.#mismatch = true;
  }

  send(frame: ChordFrame): number {
    if (this.#closed) return 0;
    const bytes = encoder.encode(JSON.stringify(frame));
    const size = bytes.byteLength;
    if (this.#held) this.#held.push(bytes);
    else this.#post(bytes);
    return size;
  }

  #post(bytes: Uint8Array): void {
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
    this.#held = undefined;
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
    else if (!this.#heard) this.#hello(frame);
    else if (this.#legacy) this.#refuse(frame);
    else this.#handler?.(frame);
  }

  #hello(frame: ChordFrame): void {
    this.#heard = true;
    const held = this.#held;
    this.#held = undefined;
    if (frame.t !== 'hello' || frame.protocol !== undefined) {
      for (const bytes of held ?? []) this.#post(bytes);
      this.#handler?.(frame);
      return;
    }
    this.#legacy = true;
    this.#mismatch = true;
    if (!held) this.close(`protocol-version ${PROTOCOL_VERSION}`);
  }

  #refuse(frame: ChordFrame): void {
    if (frame.t !== 'hold') return;
    const error = { code: 'upgrade_required', message: `upgrade_required: ${OTHER_VERSION}` };
    this.#post(encoder.encode(JSON.stringify({ t: 'gone', id: frame.id, error })));
  }

  #end(reason: string, failed: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#held = undefined;
    this.#endpoint.close?.();
    this.#unwelcome(new Error(`agent port closed before hello: ${reason}`));
    for (const handler of [...this.#closers]) handler(reason);
    this.#closers.clear();
    this.#finish(this.#mismatch ? otherVersion() : failed ? new Error(reason) : undefined);
  }
}
