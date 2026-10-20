import type { Context } from '@earendil-works/chord';
import type { AuthEvent, AuthPrompt, OAuthCredential, Provider } from '@earendil-works/pi-ai';
import { VaultRefusal } from './secrets/vault.ts';
import {
  CODEX,
  CODEX_ACCOUNT,
  type DeviceSignIn,
  httpsUrl,
  NAME_TAKEN,
  SIGN_IN_LOCKED,
  SIGN_IN_REFUSED,
  SIGN_IN_UNFINISHED,
  SIGN_IN_UNKEPT,
} from './sign-ins.ts';

export const ATTACH_MS = 60_000;

export interface ProviderGrant {
  provider: string;
  name: string;
  response: Uint8Array;
  settings?: Record<string, string>;
}

export type Grant = (grant: ProviderGrant) => Promise<unknown>;

export interface DeviceFlows {
  has(providerId: string): boolean;
  start(provider: Provider, name: string, context: Context): Promise<DeviceSignIn>;
  finish(providerId: string, context: Context): Promise<void>;
  stop(providerId: string): void;
}

interface Flow {
  controller: AbortController;
  attached: PromiseWithResolvers<void>;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
}

class Kept extends Error {}

const cancelled = () => new DOMException('The sign-in was cancelled.', 'AbortError');

export function keptError(error: unknown): Error {
  if (error instanceof VaultRefusal && error.code === 'EEXIST') return new Kept(NAME_TAKEN);
  if (error instanceof VaultRefusal && error.code === 'EACCES' && /lock/i.test(error.message))
    return new Kept(SIGN_IN_LOCKED);
  return new Kept(SIGN_IN_UNKEPT);
}

export function flowError(error: unknown): Error {
  if (error instanceof Kept) return error;
  const text = error instanceof Error ? error.message : String(error ?? '');
  return new Error(/denied|refused/i.test(text) ? SIGN_IN_REFUSED : SIGN_IN_UNFINISHED);
}

export function tokenResponse(credential: OAuthCredential, now: number): Uint8Array {
  const seconds = Math.round((credential.expires - now) / 1000);
  return new TextEncoder().encode(
    JSON.stringify({
      access_token: credential.access,
      ...(credential.refresh ? { refresh_token: credential.refresh } : {}),
      token_type: 'Bearer',
      ...(Number.isFinite(seconds) ? { expires_in: Math.max(0, seconds) } : {}),
    })
  );
}

function settingsOf(providerId: string, credential: OAuthCredential) {
  const account = credential.accountId;
  return providerId === CODEX && typeof account === 'string' && account
    ? { settings: { [CODEX_ACCOUNT]: account } }
    : {};
}

function follow(signal: AbortSignal | undefined, controller: AbortController): () => void {
  const abort = () => controller.abort(cancelled());
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  return () => signal?.removeEventListener('abort', abort);
}

const DEVICE_CODE = 'device_code';

export function deviceFlows(
  grant: Grant,
  options: { attachMs?: number; now?: () => number } = {}
): DeviceFlows {
  const flows = new Map<string, Flow>();
  const now = options.now ?? Date.now;
  const drop = (providerId: string, flow: Flow) => {
    clearTimeout(flow.timer);
    if (flows.get(providerId) === flow) flows.delete(providerId);
  };
  const stop = (providerId: string) => {
    const flow = flows.get(providerId);
    if (!flow) return;
    drop(providerId, flow);
    flow.controller.abort(cancelled());
  };
  return {
    has: (providerId) => flows.has(providerId),
    stop,
    start(provider, name, context) {
      stop(provider.id);
      const oauth = provider.auth.oauth;
      if (!oauth) return Promise.reject(new Error(SIGN_IN_UNFINISHED));
      const controller = new AbortController();
      const { signal } = controller;
      const shown = Promise.withResolvers<DeviceSignIn>();
      const attached = Promise.withResolvers<void>();
      const notify = (event: AuthEvent) => {
        if (event.type !== DEVICE_CODE) return;
        if (!httpsUrl(event.verificationUri)) {
          shown.reject(new Error(SIGN_IN_UNFINISHED));
          controller.abort(new Error(SIGN_IN_UNFINISHED));
          return;
        }
        shown.resolve({ url: event.verificationUri, code: event.userCode });
      };
      const prompt = async (asked: AuthPrompt) => {
        if (asked.type === 'select' && asked.options.some((option) => option.id === DEVICE_CODE))
          return DEVICE_CODE;
        throw new Error(SIGN_IN_UNFINISHED);
      };
      const until = (promise: Promise<void>) =>
        new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          promise.then(resolve, reject);
        });
      const run = async () => {
        const credential = await oauth.login({ signal, notify, prompt });
        await until(attached.promise);
        signal.throwIfAborted();
        const response = tokenResponse(credential, now());
        try {
          await grant({
            provider: provider.id,
            name,
            response,
            ...settingsOf(provider.id, credential),
          });
        } catch (error) {
          throw keptError(error);
        } finally {
          response.fill(0);
        }
      };
      const done = run().catch((error: unknown) => {
        throw signal.aborted && !(error instanceof Kept) ? cancelled() : flowError(error);
      });
      done.catch((error: unknown) => shown.reject(error));
      const flow: Flow = {
        controller,
        attached,
        done,
        timer: setTimeout(() => stop(provider.id), options.attachMs ?? ATTACH_MS),
      };
      flows.set(provider.id, flow);
      const off = follow(context.abortSignal, controller);
      return shown.promise.finally(off);
    },
    async finish(providerId, context) {
      const flow = flows.get(providerId);
      if (!flow) throw new Error(SIGN_IN_UNFINISHED);
      clearTimeout(flow.timer);
      const off = follow(context.abortSignal, flow.controller);
      flow.attached.resolve();
      try {
        await flow.done;
      } finally {
        off();
        drop(providerId, flow);
      }
    },
  };
}
