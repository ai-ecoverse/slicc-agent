export interface TransportResponse {
  status: number;
  statusText?: string;
  headers: HeadersInit;
  body: AsyncIterable<Uint8Array>;
}

export interface Transport {
  traits?: { crossOrigin?: 'cors' | 'any'; manualRedirects?: boolean };
  fetch(request: {
    url: string;
    method: string;
    headers: [string, string][];
    body?: Uint8Array;
    signal?: AbortSignal;
  }): Promise<TransportResponse>;
}

export type Loopback = (
  request: Request,
  options: { port: number; signal?: AbortSignal }
) => Promise<Response>;

const empty = new Set([101, 103, 204, 205, 304]);
const KERNEL_HOST = /^(\d{1,5})\.kernel\.localhost$/i;

export function kernelPort(url: string): number | undefined {
  const port = Number(KERNEL_HOST.exec(new URL(url).hostname)?.[1]);
  return port > 0 && port < 65536 ? port : undefined;
}

function stream(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export function transportFetch(
  transport: Transport,
  origin: string,
  native: typeof fetch = globalThis.fetch.bind(globalThis),
  loopback?: Loopback
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const port = loopback && kernelPort(request.url);
    if (loopback && port) return loopback(request, { port, signal: request.signal });
    if (new URL(request.url).origin === origin || transport.traits?.crossOrigin === 'cors') {
      return native(request);
    }
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
    const response = await transport.fetch({
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      ...(body ? { body } : {}),
      signal: request.signal,
    });
    return new Response(empty.has(response.status) ? null : stream(response.body), {
      status: response.status,
      statusText: response.statusText ?? '',
      headers: response.headers,
    });
  };
}
