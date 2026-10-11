import type { Frame, PortEndpoint } from './wire.ts';

export const MAX_FRAME = 16 * 1024 * 1024;

const DATA = 0;
const HELLO = 1;
const CLOSE = 2;

export interface ByteSink {
  write(chunk: Uint8Array): void;
  close(): void;
}

export interface LinkEnd {
  receive(chunk: Uint8Array): void;
  end(error?: Error): void;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const body =
    frame instanceof Uint8Array
      ? frame
      : 'hello' in frame
        ? new TextEncoder().encode(frame.hello)
        : new Uint8Array();
  const tag = frame instanceof Uint8Array ? DATA : 'hello' in frame ? HELLO : CLOSE;
  const out = new Uint8Array(5 + body.length);
  new DataView(out.buffer).setUint32(0, body.length + 1);
  out[4] = tag;
  out.set(body, 5);
  return out;
}

export class FrameReader {
  readonly #chunks: Uint8Array[] = [];
  #size = 0;

  #take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.#chunks[0] as Uint8Array;
      const used = Math.min(head.length, count - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (used === head.length) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(used);
    }
    this.#size -= count;
    return out;
  }

  #peek(): number {
    const header = new Uint8Array(4);
    let filled = 0;
    for (const chunk of this.#chunks) {
      const used = Math.min(chunk.length, 4 - filled);
      header.set(chunk.subarray(0, used), filled);
      filled += used;
      if (filled === 4) break;
    }
    return new DataView(header.buffer).getUint32(0);
  }

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length) {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
    }
    const frames: Frame[] = [];
    while (this.#size >= 4) {
      const length = this.#peek();
      if (length < 1 || length > MAX_FRAME) throw new Error(`agent link frame of ${length} bytes`);
      if (this.#size - 4 < length) break;
      this.#take(4);
      const frame = this.#take(length);
      const tag = frame[0];
      const body = frame.subarray(1);
      if (tag === DATA) frames.push(body.slice());
      else if (tag === HELLO) frames.push({ hello: new TextDecoder().decode(body) });
      else if (tag === CLOSE) frames.push({ close: true });
      else throw new Error(`agent link frame tag ${tag}`);
    }
    return frames;
  }
}

type Listener = (event: { type: string; data?: unknown }) => void;

export function linkEndpoint(sink: ByteSink): PortEndpoint & LinkEnd {
  const listeners = new Map<string, Listener[]>();
  const reader = new FrameReader();
  let ended = false;
  const emit = (type: string, data?: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener({ type, data });
  };
  const finish = (error?: Error) => {
    if (ended) return;
    ended = true;
    emit(error ? 'error' : 'close');
  };
  return {
    postMessage(message) {
      if (!ended) sink.write(encodeFrame(message as Frame));
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {
      if (ended) return;
      ended = true;
      sink.close();
    },
    receive(chunk) {
      if (ended) return;
      try {
        for (const frame of reader.push(chunk)) emit('message', frame);
      } catch (error) {
        finish(error as Error);
        sink.close();
      }
    },
    end: finish,
  } as PortEndpoint & LinkEnd;
}

export function bridgePort(port: PortEndpoint, sink: ByteSink): LinkEnd {
  const reader = new FrameReader();
  let ended = false;
  const stop = () => {
    if (ended) return;
    ended = true;
    sink.close();
  };
  port.addEventListener('message', ({ data }) => {
    if (!ended) sink.write(encodeFrame(data as Frame));
    if (!(data instanceof Uint8Array) && (data as { close?: boolean } | null)?.close) stop();
  });
  port.addEventListener('close', stop);
  port.start?.();
  const close = () => {
    port.postMessage({ close: true } satisfies Frame);
    port.close?.();
  };
  return {
    receive(chunk) {
      if (ended) return;
      try {
        for (const frame of reader.push(chunk)) {
          if (frame instanceof Uint8Array) port.postMessage(frame, [frame.buffer]);
          else port.postMessage(frame);
        }
      } catch {
        ended = true;
        close();
        sink.close();
      }
    },
    end() {
      if (ended) return;
      ended = true;
      close();
    },
  };
}
