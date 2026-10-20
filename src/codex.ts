import type { Provider } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { CODEX_ACCOUNT } from './sign-ins.ts';

const CLAIM = 'https://api.openai.com/auth';
const MARK = 'slicc';
const CARRIED = /^Bearer slicc\.[A-Za-z0-9+/=]+\.([^.\s]+)$/;

export function codexKey(placeholder: string, account: string): string {
  const claims = btoa(JSON.stringify({ [CLAIM]: { chatgpt_account_id: account } }));
  return `${MARK}.${claims}.${placeholder}`;
}

export function codexProvider(): Provider {
  const base = openaiCodexProvider() as Provider;
  return {
    ...base,
    name: 'ChatGPT',
    auth: {
      ...base.auth,
      apiKey: {
        name: 'ChatGPT sign-in',
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          const account = credential?.env?.[CODEX_ACCOUNT];
          if (!credential?.key || !account) return undefined;
          return {
            auth: { apiKey: codexKey(credential.key, account) },
            env: credential.env,
            source: 'vault',
          };
        },
      },
    },
    stream: (model, context, options) =>
      base.stream(model, context, { ...options, transport: 'sse' } as typeof options),
    streamSimple: (model, context, options) =>
      base.streamSimple(model, context, { ...options, transport: 'sse' }),
  };
}

export function codexFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    const carried = CARRIED.exec(request.headers.get('authorization') ?? '');
    if (!carried) return inner(request);
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${carried[1]}`);
    return inner(new Request(request, { headers }));
  };
}
