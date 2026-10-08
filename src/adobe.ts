import type { Provider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';

export const ADOBE = 'adobe';
export const ADOBE_PROXY = 'https://adobe-llm-proxy.paolo-moz.workers.dev';

export interface AdobeModelInfo {
  id: string;
  name: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  hidden?: boolean;
}

export interface AdobeConfig {
  clientId: string;
  scopes: string;
  imsEnvironment: string;
  models: AdobeModelInfo[];
}

export interface Budget {
  percent: number;
  window: 'weekly';
  resets: string;
}

type Fetch = typeof fetch;

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function adobeModel(info: AdobeModelInfo, endpoint: string) {
  const openai = info.api === 'openai';
  return {
    id: info.id,
    name: info.name,
    provider: ADOBE,
    api: openai ? ('openai-completions' as const) : ('anthropic-messages' as const),
    baseUrl: openai ? `${endpoint}/v1` : endpoint,
    reasoning: info.reasoning ?? !openai,
    input: (info.input ?? ['text']).filter(
      (kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image'
    ),
    cost: info.cost ?? free,
    contextWindow: info.context_window ?? 200000,
    maxTokens: info.max_tokens ?? 8192,
    ...(openai ? { compat: { supportsStore: false, supportsDeveloperRole: false } } : {}),
  };
}

export async function adobeConfig(endpoint: string, fetcher: Fetch): Promise<AdobeConfig> {
  const response = await fetcher(`${endpoint}/v1/config`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`the Adobe proxy answered /v1/config with ${response.status}`);
  return (await response.json()) as AdobeConfig;
}

export async function adobeUsage(
  token: string,
  {
    endpoint = ADOBE_PROXY,
    fetch: fetcher = globalThis.fetch,
  }: { endpoint?: string; fetch?: Fetch } = {}
): Promise<Budget | null> {
  const response = await fetcher(`${endpoint}/v1/usage`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const weekly = (
    (await response.json()) as { usage?: { weekly?: { percent?: number; resetsAt?: string } } }
  ).usage?.weekly;
  if (typeof weekly?.percent !== 'number' || typeof weekly.resetsAt !== 'string') return null;
  return { percent: weekly.percent, window: 'weekly', resets: weekly.resetsAt };
}

export function adobeProvider({
  endpoint = ADOBE_PROXY,
  session = crypto.randomUUID(),
  fetch: fetcher = (input, init) => globalThis.fetch(input, init),
}: {
  endpoint?: string;
  session?: string;
  fetch?: Fetch;
} = {}): Provider {
  return createProvider({
    id: ADOBE,
    name: 'Adobe',
    baseUrl: endpoint,
    headers: { 'X-Session-Id': session },
    auth: {
      apiKey: {
        name: 'Adobe IMS',
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          if (!credential?.key) return undefined;
          return {
            auth: { headers: { Authorization: `Bearer ${credential.key}` } },
            source: 'Adobe IMS',
          };
        },
      },
    },
    models: [],
    fetchModels: async () =>
      (await adobeConfig(endpoint, fetcher)).models
        .filter((info) => !info.hidden)
        .map((info) => adobeModel(info, endpoint)),
    api: {
      'anthropic-messages': anthropicMessagesApi(),
      'openai-completions': openAICompletionsApi(),
    },
  }) as Provider;
}
