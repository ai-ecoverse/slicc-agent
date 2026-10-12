import type { ClassifierModel, Provider, ProviderClassifier } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { cloudflareWorkersAISystemOneApi } from '@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one.lazy';
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

export const CLASSIFIER_API = 'cloudflare-workers-ai-system-one';
const WORKERS_AI = '@cf/cloudflare/';

const CLEF = [
  { id: 'clef', name: 'Clef', input: 0.24 },
  { id: 'clef-flash', name: 'Clef Flash', input: 0.09 },
];

export function adobeClassifiers(endpoint: string): ClassifierModel<typeof CLASSIFIER_API>[] {
  return CLEF.map(({ id, name, input }) => ({
    type: 'classifier',
    id,
    name,
    provider: ADOBE,
    api: CLASSIFIER_API,
    baseUrl: `${endpoint}/v1/ai`,
    input: ['text'],
    cost: { ...free, input },
    contextWindow: 65536,
  }));
}

function bearer(headers: Record<string, string | null> = {}): string | undefined {
  const value = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization'
  )?.[1];
  return value?.replace(/^Bearer\s+/i, '');
}

function clef(fetcher: Fetch): ProviderClassifier {
  const transport = cloudflareWorkersAISystemOneApi();
  return {
    classify: (model, context, options = {}) =>
      transport.classify(model, context, {
        ...options,
        fetch: options.fetch ?? fetcher,
        apiKey: bearer(options.headers) ?? options.apiKey,
        onPayload: async (payload, sent) => {
          const wire = { ...(payload as object), model: `${WORKERS_AI}${model.id}` };
          return (await options.onPayload?.(wire, sent)) ?? wire;
        },
      }),
  };
}

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
    models: adobeClassifiers(endpoint),
    fetchModels: async () =>
      (await adobeConfig(endpoint, fetcher)).models
        .filter((info) => !info.hidden)
        .map((info) => adobeModel(info, endpoint)),
    api: {
      'anthropic-messages': anthropicMessagesApi(),
      'openai-completions': openAICompletionsApi(),
    },
    classifiers: { [CLASSIFIER_API]: clef(fetcher) },
  }) as Provider;
}
