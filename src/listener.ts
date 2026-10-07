import type { ServerListener } from '@earendil-works/pi-server';
import { applyPatches } from './patches.ts';
import { type Frame, type PortEndpoint, post } from './wire.ts';

type ByteConnectionAcceptor = Parameters<ServerListener['start']>[0];
type ByteConnection = Parameters<ByteConnectionAcceptor>[0];
type ByteConnectionHandler = ReturnType<ByteConnectionAcceptor>;

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
    applyPatches();
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
    const handler: ByteConnectionHandler = accept(connection);
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
