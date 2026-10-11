import type { CredentialStore } from '@earendil-works/pi-ai';
import type { AuthProvider, McpFetch, UnauthorizedContext } from '@earendil-works/pi-mcp';
import {
  authorizeMcp,
  discoverOAuthServerInfo,
  McpOAuthAuthorizationRequiredError,
  type McpOAuthState,
  type OAuthChallenge,
  parseWwwAuthenticate,
  registerClient,
  selectResource,
  stepUpScope,
} from '@earendil-works/pi-mcp/oauth';
import type { McpSignIn } from '../services.ts';
import type { McpServerConfig } from './config.ts';
import { credentialKey } from './credentials.ts';

type Provider = Parameters<typeof authorizeMcp>[0];
type Tokens = Awaited<ReturnType<Provider['tokens']>>;
type Client = Awaited<ReturnType<Provider['clientInformation']>>;
type Discovery = NonNullable<McpOAuthState['discovery']>;

export const CLIENT_NAME = 'SLICC';

export function sentence(text: string): string {
  const trimmed = text.trim();
  const lowered = /^[A-Z][a-z]/.test(trimmed)
    ? `${trimmed[0]?.toLowerCase()}${trimmed.slice(1)}`
    : trimmed;
  return /[.!?]$/.test(lowered) ? lowered : `${lowered}.`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function secureUrl(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

export function signInRequired(cause?: unknown): McpOAuthAuthorizationRequiredError {
  const error = new McpOAuthAuthorizationRequiredError();
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function authProvider(provider: StoredOAuth, server: OAuthServer): AuthProvider {
  const configured = server.config.oauth?.authServerMetadataUrl;
  let inFlight: Promise<void> | undefined;
  const authorize = async (
    context: UnauthorizedContext,
    step: boolean,
    challenge: OAuthChallenge
  ) => {
    const granted = step ? await provider.tokens() : undefined;
    try {
      await authorizeMcp(provider, {
        serverUrl: context.serverUrl,
        ...(challenge.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
        ...(step
          ? { scope: stepUpScope(granted?.scope, challenge.scope), skipRefresh: true }
          : challenge.scope
            ? { scope: challenge.scope }
            : {}),
        ...(configured ? { authorizationServerMetadataUrl: new URL(configured) } : {}),
        fetch: context.fetch,
      });
    } catch (error) {
      throw error instanceof McpOAuthAuthorizationRequiredError ? error : signInRequired(error);
    }
  };
  return {
    token: async () => (await provider.tokens())?.access_token,
    async onUnauthorized(context) {
      const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
      const step = challenge.error === 'insufficient_scope';
      if (!step && !inFlight && context.token !== undefined) {
        const current = (await provider.tokens())?.access_token;
        if (current !== undefined && current !== context.token) return;
      }
      inFlight ??= authorize(context, step, challenge).finally(() => {
        inFlight = undefined;
      });
      await inFlight;
    },
  };
}

const bytesToBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = bytesToBase64Url(random(32));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export function randomState(): string {
  return [...random(32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface OAuthServer {
  name: string;
  config: McpServerConfig;
}

export class StoredOAuth implements Provider {
  readonly redirectUrl: string;
  readonly clientMetadata: Provider['clientMetadata'];
  readonly #credentials: CredentialStore;
  readonly #server: OAuthServer;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(server: OAuthServer, credentials: CredentialStore, redirectUrl: string) {
    this.#server = server;
    this.#credentials = credentials;
    this.redirectUrl = redirectUrl;
    this.clientMetadata = {
      client_name: server.config.oauth?.clientName ?? CLIENT_NAME,
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(server.config.oauth?.scope ? { scope: server.config.oauth.scope } : {}),
    };
  }

  get serverUrl(): string {
    return String(new URL(this.#server.config.url));
  }

  async #key(): Promise<string> {
    return credentialKey(this.#server.name, this.#server.config.url);
  }

  async load(): Promise<McpOAuthState> {
    await this.#writes;
    const stored = await this.#credentials.read(await this.#key());
    const state =
      stored?.type === 'oauth' ? (stored.state as McpOAuthState | undefined) : undefined;
    return state?.serverUrl === this.serverUrl ? state : { serverUrl: this.serverUrl };
  }

  async update(change: (state: McpOAuthState) => McpOAuthState): Promise<void> {
    const write = this.#writes.then(async () => {
      const key = await this.#key();
      await this.#credentials.modify(key, async (current) => {
        const before =
          current?.type === 'oauth' ? (current.state as McpOAuthState | undefined) : undefined;
        const next = change(
          before?.serverUrl === this.serverUrl ? before : { serverUrl: this.serverUrl }
        );
        return {
          type: 'oauth',
          access: next.tokens?.access_token ?? '',
          refresh: next.tokens?.refresh_token ?? '',
          expires: next.tokensExpireAt ?? 0,
          state: next,
        };
      });
    });
    this.#writes = write.catch(() => undefined);
    await write;
  }

  async signedIn(): Promise<boolean> {
    return (await this.load()).tokens !== undefined;
  }

  state(): string {
    throw new McpOAuthAuthorizationRequiredError();
  }

  async clientInformation(): Promise<Client> {
    const configured = this.#server.config.oauth?.clientId;
    return configured ? { client_id: configured } : (await this.load()).clientInformation;
  }

  async saveClientInformation(information: NonNullable<Client>): Promise<void> {
    if (this.#server.config.oauth?.clientId) return;
    await this.update((state) => ({ ...state, clientInformation: information }));
  }

  async tokens(): Promise<Tokens> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: NonNullable<Tokens>): Promise<void> {
    const expires =
      tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    await this.update((state) => {
      const next: McpOAuthState = { ...state, tokens };
      if (expires === undefined) delete next.tokensExpireAt;
      else next.tokensExpireAt = expires;
      return next;
    });
  }

  redirectToAuthorization(): void {
    throw new McpOAuthAuthorizationRequiredError();
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.update((state) => ({ ...state, codeVerifier: verifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) throw new Error('No OAuth PKCE code verifier is stored');
    return verifier;
  }

  async invalidateCredentials(
    kind: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    await this.update((state) => {
      const next = { ...state };
      if (kind === 'all' || kind === 'client') delete next.clientInformation;
      if (kind === 'all' || kind === 'tokens') {
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      if (kind === 'all' || kind === 'verifier') delete next.codeVerifier;
      if (kind === 'all' || kind === 'discovery') delete next.discovery;
      if (kind === 'all') delete next.oauthState;
      return next;
    });
  }

  async saveDiscoveryState(discovery: Discovery): Promise<void> {
    await this.update((state) => ({ ...state, discovery }));
  }

  async discoveryState(): Promise<Discovery | undefined> {
    return (await this.load()).discovery;
  }

  async forget(): Promise<void> {
    await this.#writes;
    await this.#credentials.delete(await this.#key());
  }
}

export type { McpSignIn } from '../services.ts';

export async function beginSignIn(
  provider: StoredOAuth,
  server: OAuthServer,
  options: { fetch: McpFetch; resourceMetadataUrl?: URL }
): Promise<McpSignIn> {
  const configured = server.config.oauth?.authServerMetadataUrl;
  const info = await discoverOAuthServerInfo(server.config.url, {
    fetch: options.fetch,
    ...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl } : {}),
    ...(configured ? { authorizationServerMetadataUrl: new URL(configured) } : {}),
  });
  if (!configured) await provider.saveDiscoveryState(info);
  const metadata = info.authorizationServerMetadata;
  if (metadata && !metadata.response_types_supported.includes('code'))
    throw new Error("The authorization server doesn't support authorization codes.");
  if (
    metadata?.code_challenge_methods_supported &&
    !metadata.code_challenge_methods_supported.includes('S256')
  )
    throw new Error("The authorization server doesn't support PKCE S256.");
  const scope =
    server.config.oauth?.scope || info.resourceMetadata?.scopes_supported?.join(' ') || undefined;
  let client = await provider.clientInformation();
  if (!client) {
    client = await registerClient(info.authorizationServerUrl, {
      ...(metadata ? { metadata } : {}),
      clientMetadata: provider.clientMetadata,
      ...(scope ? { scope } : {}),
      fetch: options.fetch,
    });
    await provider.saveClientInformation(client);
  }
  const { verifier, challenge } = await pkce();
  const state = randomState();
  await provider.update((current) => ({ ...current, codeVerifier: verifier, oauthState: state }));
  const url = new URL(
    metadata?.authorization_endpoint ?? new URL('/authorize', info.authorizationServerUrl)
  );
  if (!secureUrl(url)) throw new Error("The authorization server's sign-in address isn't https.");
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', provider.redirectUrl);
  url.searchParams.set('state', state);
  if (scope) url.searchParams.set('scope', scope);
  if (scope?.split(/\s+/).includes('offline_access')) url.searchParams.set('prompt', 'consent');
  const resource = selectResource(server.config.url, info.resourceMetadata);
  if (resource) url.searchParams.set('resource', resource);
  return { url: url.href, state };
}

export interface Callback {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  error_description?: string;
}

export async function finishSignIn(
  provider: StoredOAuth,
  server: OAuthServer,
  answer: string,
  fetch: McpFetch
): Promise<void> {
  let callback: Callback;
  try {
    callback = JSON.parse(answer) as Callback;
  } catch {
    throw new Error("The sign-in answer isn't a callback.");
  }
  const expected = (await provider.load()).oauthState;
  if (!expected || callback.state !== expected)
    throw new Error("The sign-in answer doesn't match this sign-in. Try again.");
  if (callback.error)
    throw new Error(
      `Sign-in failed: ${sentence(callback.error_description?.trim() || callback.error)}`
    );
  if (!callback.code) throw new Error('The sign-in answer has no authorization code.');
  const configured = server.config.oauth?.authServerMetadataUrl;
  await authorizeMcp(provider, {
    serverUrl: server.config.url,
    authorizationCode: callback.code,
    ...(callback.iss ? { iss: callback.iss } : {}),
    ...(server.config.oauth?.scope ? { scope: server.config.oauth.scope } : {}),
    ...(configured ? { authorizationServerMetadataUrl: new URL(configured) } : {}),
    fetch,
  });
  await provider.update((state) => {
    const next = { ...state };
    delete next.oauthState;
    delete next.codeVerifier;
    return next;
  });
}
