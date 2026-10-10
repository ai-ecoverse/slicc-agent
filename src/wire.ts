import type { ByteTransportFactory, ByteTransportHandlers } from '@earendil-works/pi-client';

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

export function post(endpoint: PortEndpoint, chunk: Uint8Array): void {
  const copy = chunk.slice();
  endpoint.postMessage(copy, [copy.buffer]);
}

function unrefable(id: number): object {
  return {
    unref() {
      return this;
    },
    ref() {
      return this;
    },
    [Symbol.toPrimitive]: () => id,
  };
}

export function withUnrefTimers<T>(
  run: () => T,
  scope: { setTimeout: typeof setTimeout } = globalThis
): T {
  const original = scope.setTimeout;
  scope.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const id: unknown = original(...args);
    return typeof id === 'number' ? unrefable(id) : id;
  }) as typeof setTimeout;
  try {
    return run();
  } finally {
    scope.setTimeout = original;
  }
}

export class PortChannel {
  readonly hello: Promise<string>;
  readonly ended: Promise<Error | undefined>;
  readonly #endpoint: PortEndpoint;
  readonly #queue: Uint8Array[] = [];
  #handlers: ByteTransportHandlers | undefined;
  #ended: 'close' | Error | undefined;
  #greet!: (serverId: string) => void;
  #refuse!: (error: Error) => void;
  #finish!: (reason: Error | undefined) => void;

  constructor(endpoint: PortEndpoint) {
    this.#endpoint = endpoint;
    this.hello = new Promise((greet, refuse) => {
      this.#greet = greet;
      this.#refuse = refuse;
    });
    this.ended = new Promise((finish) => {
      this.#finish = finish;
    });
    endpoint.addEventListener('message', ({ data }) => this.#receive(data as Frame));
    endpoint.addEventListener('messageerror', (event) =>
      this.#end(new Error(`agent port ${event.type}`))
    );
    endpoint.addEventListener('error', (event) => this.#end(new Error(`agent port ${event.type}`)));
    endpoint.addEventListener('close', () => this.#end('close'));
    endpoint.start?.();
  }

  readonly transport: ByteTransportFactory = (handlers) => {
    this.#handlers = handlers;
    for (const chunk of this.#queue.splice(0)) handlers.onData(chunk);
    if (this.#ended) this.#deliver(this.#ended);
    return {
      send: async (chunk) => {
        if (this.#ended) throw new Error('agent port is closed');
        post(this.#endpoint, chunk);
      },
      close: () => {
        if (this.#ended) return;
        this.#ended = 'close';
        this.#refuse(new Error('agent port closed before hello'));
        this.#finish(undefined);
        this.#endpoint.postMessage({ close: true } satisfies Frame);
        this.#endpoint.close?.();
      },
    };
  };

  #receive(frame: Frame): void {
    if (frame instanceof Uint8Array) {
      if (this.#handlers) this.#handlers.onData(frame);
      else this.#queue.push(frame);
    } else if ('hello' in frame) {
      this.#greet(frame.hello);
    } else {
      this.#end('close');
    }
  }

  #end(reason: 'close' | Error): void {
    if (this.#ended) return;
    this.#ended = reason;
    this.#refuse(reason === 'close' ? new Error('agent port closed before hello') : reason);
    this.#finish(reason === 'close' ? undefined : reason);
    this.#deliver(reason);
  }

  #deliver(reason: 'close' | Error): void {
    const handlers = this.#handlers;
    if (!handlers) return;
    this.#handlers = undefined;
    if (reason === 'close') handlers.onClose();
    else handlers.onError(reason);
  }
}
