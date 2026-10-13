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

function filled(original: OutgoingRequest, ready: OutgoingRequest): string[] {
  const sent = new Set(original.headers.map(([, value]) => value));
  const values = ready.headers.map(([, value]) => value).filter((value) => !sent.has(value));
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
  ready: OutgoingRequest
) {
  const init: RequestInit = {
    method: ready.method,
    headers: ready.headers,
    signal: request.signal,
    redirect: request.redirect,
    credentials: request.credentials,
    ...(ready.body === undefined ? {} : { body: ready.body as BodyInit }),
  };
  try {
    return await inner(ready.url, init);
  } catch (error) {
    throw safeError(error, original, ready);
  }
}

async function through(op: Op, inner: Fetch, request: Request): Promise<Response> {
  const original = await outgoing(request);
  let refreshed = false;
  for (;;) {
    let ready: OutgoingRequest;
    try {
      ready = await prepared(op, original);
    } catch (error) {
      return refusal(error);
    }
    const response = await sent(inner, request, original, ready);
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

export function vaultFetch(vault: Port, inner: Fetch, route: ModelRoute): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const provider = absent(vault) ? undefined : route(request);
    if (provider === undefined) return inner(request);
    const target: RefreshTarget | undefined = provider === null ? undefined : { provider };
    return through(
      {
        prepare: (outgoing) => vault.model(provider ?? undefined, outgoing),
        ...(target ? { refresh: () => vault.refresh(target) } : {}),
      },
      inner,
      request
    );
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
    const response = await base(request);
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
