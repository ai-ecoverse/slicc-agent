import { FACADE_PORT, kernelHost, ownKernelServer } from './kernel/loopback.ts';

export interface TransportResponse {
  url?: string;
  redirected?: boolean;
  redirects?: readonly unknown[];
  opaqueRedirect?: boolean;
  status: number;
  statusText?: string;
  headers: HeadersInit;
  body: AsyncIterable<Uint8Array>;
}

export interface Transport {
  traits?: {
    crossOrigin?: 'cors' | 'any';
    manualRedirects?: boolean;
    redirectHops?: boolean;
    redirectPolicy?: boolean;
    unavailable?: boolean;
    exit?: TransportExit;
  };
  fetch(request: {
    url: string;
    method: string;
    headers: [string, string][];
    body?: Uint8Array;
    signal?: AbortSignal;
    redirect?: RequestRedirect;
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

export interface Reach {
  free(): boolean;
  onChange(listener: () => void): () => void;
}

export function transportReach(client: {
  transport: Transport;
  onTraits?: (listener: () => void) => () => void;
}): Reach {
  return {
    free: () => !client.transport.traits?.unavailable && !pageOnly(client.transport),
    onChange: (listener) => client.onTraits?.(() => listener()) ?? (() => undefined),
  };
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

const UNPROVEN =
  "this route can't show it won't follow a redirect, so a request that holds a credential isn't sent";

function honorsManual(traits: Transport['traits']): boolean {
  if (traits?.unavailable) return false;
  return !!traits?.redirectPolicy || (!!traits?.manualRedirects && !traits.redirectHops);
}

function refused(): Response {
  return new Response(UNPROVEN, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function opaque(): Response {
  const response = new Response(null, { status: 502 });
  Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
  return response;
}

function followedBy(response: TransportResponse, url: string): boolean {
  return (
    !!response.redirected ||
    !!response.redirects?.length ||
    (!!response.url && bare(response.url) !== bare(url))
  );
}

async function dropped(response: TransportResponse): Promise<void> {
  await stream(response.body)
    .cancel()
    .catch(() => undefined);
}

const TELEMETRY = 'x-stainless-';

function untracked(request: Request): Request {
  const telemetry = [...request.headers.keys()].filter((name) => name.startsWith(TELEMETRY));
  if (!telemetry.length) return request;
  const headers = new Headers(request.headers);
  for (const name of telemetry) headers.delete(name);
  return new Request(request, { headers });
}

async function carried(transport: Transport, request: Request): Promise<Response> {
  const manual = request.redirect === 'manual';
  if (manual && !honorsManual(transport.traits)) return refused();
  const told = manual || (request.redirect === 'error' && transport.traits?.redirectPolicy);
  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : new Uint8Array(await request.arrayBuffer());
  const response = await transport.fetch({
    url: request.url,
    method: request.method,
    headers: [...request.headers],
    ...(body ? { body } : {}),
    signal: request.signal,
    ...(told ? { redirect: request.redirect } : {}),
  });
  const followed = followedBy(response, request.url);
  const redirected =
    followed || (transport.traits?.manualRedirects && redirects.has(response.status));
  if ((request.redirect === 'error' && redirected) || (manual && followed)) {
    await dropped(response);
    throw new TypeError('unexpected redirect');
  }
  if (response.opaqueRedirect) {
    await dropped(response);
    return opaque();
  }
  return new Response(empty.has(response.status) ? null : stream(response.body), {
    status: response.status,
    statusText: response.statusText ?? '',
    headers: response.headers,
  });
}

export function transportFetch(
  transport: Transport,
  origin: string,
  native: typeof fetch = globalThis.fetch.bind(globalThis),
  loopback?: Loopback
): typeof fetch {
  return async (input, init) => {
    const request = untracked(new Request(input, init));
    const port = kernelPort(request.url);
    if (loopback && port) return loopback(request, { port, signal: request.signal });
    if (
      request.redirect !== 'manual' &&
      (new URL(request.url).origin === origin ||
        transport.traits?.unavailable ||
        request.credentials === 'include')
    ) {
      return native(request);
    }
    return carried(transport, request);
  };
}
