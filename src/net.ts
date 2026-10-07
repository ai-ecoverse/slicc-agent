export interface TransportResponse {
  status: number;
  statusText?: string;
  headers: HeadersInit;
  body: AsyncIterable<Uint8Array>;
}

export interface Transport {
  traits?: { crossOrigin?: 'cors' | 'any' };
  fetch(request: {
    url: string;
    method: string;
    headers: [string, string][];
    body?: Uint8Array;
    signal?: AbortSignal;
  }): Promise<TransportResponse>;
}

const empty = new Set([101, 103, 204, 205, 304]);

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
  native: typeof fetch = globalThis.fetch.bind(globalThis)
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
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
