import type { OAuthConfig, OutgoingRequest } from '@ai-ecoverse/slicc-vault';
import { type RefreshTarget, type Vault, VaultRefusal } from './vault.ts';

type Fetch = typeof fetch;

type Port = Pick<Vault, 'connected' | 'needed' | 'model' | 'mcp' | 'refresh' | 'grant'>;

export type ModelRoute = (request: Request) => string | null | undefined;

interface Op {
  prepare(request: OutgoingRequest): Promise<OutgoingRequest>;
  refresh?(): Promise<unknown>;
}

const BODYLESS = new Set(['GET', 'HEAD']);
const MIN_PART = 8;
const HOPS = 5;
const MOVED = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
]);

export function absent(vault: Pick<Vault, 'connected' | 'needed'>): boolean {
  return !vault.connected && !vault.needed;
}

async function outgoing(request: Request): Promise<OutgoingRequest> {
  const body = BODYLESS.has(request.method)
    ? undefined
    : new Uint8Array(await request.arrayBuffer());
  return {
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    ...(body ? { body } : {}),
  };
}

export function refusal(error: unknown): Response {
  const code = error instanceof VaultRefusal ? error.code : undefined;
  const status = code === 'EACCES' ? 403 : code === 'EINVAL' ? 400 : 503;
  const text = error instanceof Error ? error.message : String(error);
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

async function prepared(op: Op, request: OutgoingRequest): Promise<OutgoingRequest> {
  try {
    return await op.prepare(request);
  } catch (error) {
    if (error instanceof VaultRefusal && error.code === 'EAGAIN') return op.prepare(request);
    throw error;
  }
}

function added(original: OutgoingRequest, ready: OutgoingRequest): string[] {
  const sent = new Set(original.headers.map(([, value]) => value));
  return ready.headers.map(([, value]) => value).filter((value) => !sent.has(value));
}

function filled(original: OutgoingRequest, ready: OutgoingRequest): string[] {
  const values = added(original, ready);
  if (ready.url !== original.url) values.push(ready.url, decodeURIComponent(ready.url));
  return values.flatMap((value) => [
    value,
    ...value.split(/[\s=&?]+/).filter((part) => part.length >= MIN_PART),
  ]);
}

export function safeError(error: unknown, original: OutgoingRequest, ready: OutgoingRequest) {
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
    return error;
  const text = error instanceof Error ? error.message : String(error);
  const parts = filled(original, ready);
  const shown = parts.some((part) => text.includes(part)) ? 'the request failed' : text;
  return new TypeError(`${ready.method} ${new URL(ready.url).origin}: ${shown}`);
}

async function sent(
  inner: Fetch,
  request: Request,
  original: OutgoingRequest,
  ready: OutgoingRequest,
  redirect: RequestRedirect
) {
  const init: RequestInit = {
    method: ready.method,
    headers: ready.headers,
    signal: request.signal,
    redirect,
    credentials: request.credentials,
    ...(ready.body === undefined ? {} : { body: ready.body as BodyInit }),
  };
  try {
    return await inner(ready.url, init);
  } catch (error) {
    throw safeError(error, original, ready);
  }
}

function moved(response: Response): boolean {
  return (
    response.type === 'opaqueredirect' ||
    (MOVED.has(response.status) && response.headers.has('location'))
  );
}

function followed(current: OutgoingRequest, response: Response): OutgoingRequest | undefined {
  if (response.type === 'opaqueredirect') return undefined;
  const target = URL.parse(response.headers.get('location') as string, current.url);
  if (target?.origin !== new URL(current.url).origin || target.username || target.password)
    return undefined;
  const { body, ...head } = current;
  const toGet =
    response.status === 303
      ? !BODYLESS.has(current.method)
      : response.status < 303 && current.method === 'POST';
  if (!toGet) return { ...current, url: target.href };
  const headers = current.headers.filter(([name]) => !BODY_HEADERS.has(name.toLowerCase()));
  return { ...head, method: 'GET', url: target.href, headers };
}

function unfollowed(url: string): Response {
  const { origin } = new URL(url);
  return refusal(
    new VaultRefusal(
      'EACCES',
      `${origin} redirected a request that holds a credential, so it wasn't followed`
    )
  );
}

async function through(op: Op, inner: Fetch, request: Request): Promise<Response> {
  let current = await outgoing(request);
  let refreshed = false;
  let hops = 0;
  for (;;) {
    let ready: OutgoingRequest;
    try {
      ready = await prepared(op, current);
    } catch (error) {
      return refusal(error);
    }
    const held =
      request.redirect === 'manual' || ready.url !== current.url || !!added(current, ready).length;
    const response = await sent(inner, request, current, ready, held ? 'manual' : request.redirect);
    if (held && moved(response)) {
      await response.body?.cancel().catch(() => undefined);
      const next = hops < HOPS ? followed(current, response) : undefined;
      if (!next) return unfollowed(current.url);
      current = next;
      hops += 1;
      continue;
    }
    if (response.status !== 401 || refreshed || !op.refresh) return response;
    refreshed = true;
    if (
      !(await op.refresh().then(
        () => true,
        () => false
      ))
    )
      return response;
    await response.body?.cancel().catch(() => undefined);
  }
}

export function vaultFetch(
  vault: Port,
  inner: Fetch,
  route: ModelRoute,
  rejecting: (provider: string) => () => void = () => () => undefined
): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const provider = absent(vault) ? undefined : route(request);
    if (provider === undefined) return inner(request);
    const target: RefreshTarget | undefined = provider === null ? undefined : { provider };
    const rejected = provider === null ? undefined : rejecting(provider);
    const response = await through(
      {
        prepare: (outgoing) => vault.model(provider ?? undefined, outgoing),
        ...(target ? { refresh: () => vault.refresh(target) } : {}),
      },
      inner,
      request
    );
    if (response.status === 401) rejected?.();
    return response;
  };
}

export function mcpFetch(vault: Port, inner: Fetch, server: string): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (absent(vault)) return inner(request);
    return through(
      {
        prepare: (outgoing) => vault.mcp(server, outgoing),
        refresh: () => vault.refresh({ server }),
      },
      inner,
      request
    );
  };
}

export const NO_VAULT_SIGN_IN = "MCP sign-in needs seven's vault: update seven";

function oauthOf(url: string, params: URLSearchParams): OAuthConfig {
  const scope = params.get('scope');
  const resource = params.get('resource');
  return {
    tokenUrl: url,
    clientId: params.get('client_id') ?? '',
    ...(scope ? { scope } : {}),
    ...(resource ? { resource } : {}),
  };
}

export function grantFetch(vault: Port, server: string, base: Fetch): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const params =
      request.method === 'POST' ? new URLSearchParams(await request.clone().text()) : undefined;
    if (params?.get('grant_type') !== 'authorization_code') return base(request);
    if (absent(vault)) throw new Error(NO_VAULT_SIGN_IN);
    const response = await base(new Request(request, { redirect: 'manual' }));
    if (!response.ok) return response;
    const raw = new Uint8Array(await response.arrayBuffer());
    try {
      const granted = await vault.grant(server, raw, oauthOf(request.url, params));
      return new Response(granted.response as BodyInit, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      throw new Error(
        `the vault didn't keep the sign-in: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      raw.fill(0);
    }
  };
}
