import type { McpSignIn, SignIn } from '../services.ts';

export const MCP_CHANNEL = 'slicc-mcp-oauth';

export interface Popup {
  location: { href: string };
  close(): void;
}

export interface Channel {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface McpLoginHost {
  open(): Popup | null;
  channel(): Channel;
}

const browser: McpLoginHost = {
  open: () =>
    globalThis.open?.('about:blank', 'slicc-mcp-oauth', 'popup,width=520,height=720') ?? null,
  channel: () => new BroadcastChannel(MCP_CHANNEL) as unknown as Channel,
};

export function mcpLogin(host: McpLoginHost = browser) {
  return async (
    _providerId: string,
    signIn: () => Promise<SignIn | McpSignIn | null>,
    options: { signal: AbortSignal }
  ): Promise<string> => {
    const popup = host.open();
    const channel = host.channel();
    try {
      const started = (await signIn()) as McpSignIn | null;
      if (!started?.url) throw new Error('this MCP server has no sign-in');
      if (!popup)
        throw new Error('the browser blocked the sign-in window; allow pop-ups for SLICC');
      popup.location.href = started.url;
      return await new Promise<string>((resolve, reject) => {
        const stop = () => reject(options.signal.reason);
        options.signal.addEventListener('abort', stop, { once: true });
        channel.onmessage = ({ data }) => {
          const answer = data as { state?: unknown } | null;
          if (answer?.state !== started.state) return;
          options.signal.removeEventListener('abort', stop);
          resolve(JSON.stringify(answer));
        };
      });
    } finally {
      channel.close();
      popup?.close();
    }
  };
}
