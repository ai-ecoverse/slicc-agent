import type { ByteTransportFactory, ByteTransportHandlers } from '@earendil-works/pi-client';
import type { ServerListener } from '@earendil-works/pi-server';

type ByteConnectionAcceptor = Parameters<ServerListener['start']>[0];
type ByteConnection = Parameters<ByteConnectionAcceptor>[0];
type ByteConnectionHandler = ReturnType<ByteConnectionAcceptor>;

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

type Frame = { hello: string } | { close: true } | Uint8Array;

function post(endpoint: PortEndpoint, chunk: Uint8Array): void {
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

class PortConnection implements ByteConnection {
  closed = false;
  readonly #endpoint: PortEndpoint;
  readonly #ended: () => void;

  constructor(endpoint: PortEndpoint, ended: () => void) {
    this.#endpoint = endpoint;
    this.#ended = ended;
  }

  async send(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('connection is closed');
    post(this.#endpoint, chunk);
  }

  close(finalChunk?: Uint8Array): void {
    if (this.closed) return;
    if (finalChunk) post(this.#endpoint, finalChunk);
    this.closed = true;
    this.#endpoint.postMessage({ close: true } satisfies Frame);
    this.#endpoint.close?.();
    this.#ended();
  }

  end(): void {
    this.closed = true;
    this.#ended();
  }
}

export class PortListener implements ServerListener {
  readonly #serverId: string;
  readonly #connections = new Set<PortConnection>();
  #accept: ByteConnectionAcceptor | undefined;

  constructor(serverId: string) {
    this.#serverId = serverId;
  }

  async start(accept: ByteConnectionAcceptor): Promise<void> {
    this.#accept = accept;
  }

  async close(): Promise<void> {
    for (const connection of [...this.#connections]) connection.close();
    this.#accept = undefined;
  }

  connect(endpoint: PortEndpoint): void {
    const accept = this.#accept;
    if (!accept) throw new Error('agent host is not listening');
    const connection = new PortConnection(endpoint, () => this.#connections.delete(connection));
    this.#connections.add(connection);
    const handler: ByteConnectionHandler = withUnrefTimers(() => accept(connection));
    endpoint.addEventListener('message', ({ data }) => {
      if (data instanceof Uint8Array) handler.onData(data);
      else if ((data as { close?: boolean } | null)?.close) {
        connection.end();
        handler.onClose();
      }
    });
    const failed = (event: Event) => {
      connection.end();
      handler.onError(new Error(`agent port ${event.type}`));
    };
    endpoint.addEventListener('messageerror', failed);
    endpoint.addEventListener('close', () => {
      if (connection.closed) return;
      connection.end();
      handler.onClose();
    });
    endpoint.start?.();
    endpoint.postMessage({ hello: this.#serverId } satisfies Frame);
  }
}

export class PortChannel {
  readonly hello: Promise<string>;
  readonly #endpoint: PortEndpoint;
  readonly #queue: Uint8Array[] = [];
  #handlers: ByteTransportHandlers | undefined;
  #ended: 'close' | Error | undefined;
  #greet!: (serverId: string) => void;
  #refuse!: (error: Error) => void;

  constructor(endpoint: PortEndpoint) {
    this.#endpoint = endpoint;
    this.hello = new Promise((greet, refuse) => {
      this.#greet = greet;
      this.#refuse = refuse;
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
