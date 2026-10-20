import type { McpSignIn, SignIn } from '../services.ts';
import { askHold, markerUrl, UNHELD } from './held.ts';

export const MCP_CHANNEL = 'slicc-mcp-oauth';
export const MCP_NAME_KEY = 'slicc-mcp-oauth:';
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export interface Popup {
  location: { href: string };
  close(): void;
}

export interface Channel {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface SignInWindow {
  open(url: string): Popup | null;
  hold(marker: string, signal: AbortSignal): Promise<boolean>;
}

export interface McpLoginHost extends SignInWindow {
  channel(): Channel;
  remember?(state: string, name: string | null): void;
  timeoutMs?: number;
}

const browser: McpLoginHost = {
  open: (url) => globalThis.open?.(url, 'slicc-mcp-oauth', 'popup,width=520,height=720') ?? null,
  hold: (marker, signal) => askHold(marker, signal),
  channel: () => new BroadcastChannel(MCP_CHANNEL) as unknown as Channel,
  remember: (state, name) => {
    const key = `${MCP_NAME_KEY}${state}`;
    if (name === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, name);
  },
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function safeAuthorizationUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

function answered(channel: Channel, state: string, signal: AbortSignal, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    };
    const stop = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('The sign-in window gave no answer. Try again.'));
    }, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    channel.onmessage = ({ data }) => {
      const answer = data as { state?: unknown } | null;
      if (answer?.state !== state) return;
      done();
      resolve(JSON.stringify(answer));
    };
  });
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function mcpLogin(host: McpLoginHost = browser) {
  return async (
    providerId: string,
    signIn: () => Promise<SignIn | McpSignIn | null>,
    options: { signal: AbortSignal }
  ): Promise<string> => {
    const marker = crypto.randomUUID();
    const popup = host.open(markerUrl(marker));
    const held = popup ? host.hold(marker, options.signal) : Promise.resolve(false);
    const channel = host.channel();
    let state: string | undefined;
    try {
      const started = (await untilAborted(signIn(), options.signal)) as McpSignIn | null;
      if (!started?.url) throw new Error('This MCP server has no sign-in.');
      if (!safeAuthorizationUrl(started.url))
        throw new Error("The authorization server gave a sign-in address that isn't https.");
      if (!popup)
        throw new Error('The browser blocked the sign-in window. Allow pop-ups for SLICC.');
      if (!(await untilAborted(held, options.signal))) throw new Error(UNHELD);
      state = started.state;
      host.remember?.(state, providerId.replace(/^mcp:/, ''));
      popup.location.href = started.url;
      return await answered(channel, state, options.signal, host.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    } finally {
      if (state) host.remember?.(state, null);
      channel.close();
      popup?.close();
    }
  };
}
