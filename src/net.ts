import { FACADE_PORT, kernelHost, ownKernelServer } from './kernel/loopback.ts';

export interface TransportResponse {
  url?: string;
  redirected?: boolean;
  status: number;
  statusText?: string;
  headers: HeadersInit;
  body: AsyncIterable<Uint8Array>;
}

export interface Transport {
  traits?: {
    crossOrigin?: 'cors' | 'any';
    manualRedirects?: boolean;
    unavailable?: boolean;
    exit?: TransportExit;
  };
  fetch(request: {
    url: string;
    method: string;
    headers: [string, string][];
    body?: Uint8Array;
    signal?: AbortSignal;
  }): Promise<TransportResponse>;
}

export interface TransportExit {
  kind: string;
  caps: string[];
}

export function linkedExit(transport: Transport | undefined): TransportExit | undefined {
  const exit = transport?.traits?.exit;
  return typeof exit?.kind === 'string' ? exit : undefined;
}

export function pageOnly(transport: Transport | undefined): boolean {
  return transport?.traits?.crossOrigin === 'cors' && !linkedExit(transport);
}

export type Loopback = (
  request: Request,
  options: { port: number; signal?: AbortSignal }
) => Promise<Response>;

const empty = new Set([101, 103, 204, 205, 304]);
const redirects = new Set([301, 302, 303, 307, 308]);
const bare = (url: string) => url.split('#')[0];

export function kernelPort(url: string): number | undefined {
  const host = new URL(url).hostname.replace(/\.+$/, '');
  if (!kernelHost(host)) return undefined;
  if (!ownKernelServer(host))
    throw new TypeError(
      `${host} isn't a kernel server SLICC may reach: use <port>.kernel.localhost with a port from 1 to 65535 other than ${FACADE_PORT}, the CDP facade`
    );
  return Number(host.split('.')[0]);
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

const TELEMETRY = 'x-stainless-';

export function transportFetch(
  transport: Transport,
  origin: string,
  native: typeof fetch = globalThis.fetch.bind(globalThis),
  loopback?: Loopback
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const port = kernelPort(request.url);
    if (loopback && port) return loopback(request, { port, signal: request.signal });
    if (
      new URL(request.url).origin === origin ||
      transport.traits?.unavailable ||
      request.credentials === 'include'
    ) {
      return native(request);
    }
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
    const response = await transport.fetch({
      url: request.url,
      method: request.method,
      headers: [...request.headers].filter(([name]) => !name.startsWith(TELEMETRY)),
      ...(body ? { body } : {}),
      signal: request.signal,
    });
    const redirected =
      response.redirected ||
      (response.url && bare(response.url) !== bare(request.url)) ||
      (transport.traits?.manualRedirects && redirects.has(response.status));
    if (request.redirect === 'error' && redirected) {
      await stream(response.body)
        .cancel()
        .catch(() => undefined);
      throw new TypeError('unexpected redirect');
    }
    return new Response(empty.has(response.status) ? null : stream(response.body), {
      status: response.status,
      statusText: response.statusText ?? '',
      headers: response.headers,
    });
  };
}
