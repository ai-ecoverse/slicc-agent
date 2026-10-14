import type {
  ClassifierModel,
  Provider,
  ProviderClassifier,
  ProviderHeaders,
  ProviderStreams,
} from '@earendil-works/pi-ai';
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

export const SESSION_HEADER = 'X-Session-Id';
export const VERSION_HEADER = 'X-Slicc-Version';

export function adobeIdentity({
  session = crypto.randomUUID(),
  version = 'unknown',
}: {
  session?: string;
  version?: string;
} = {}): Record<string, string> {
  return { [SESSION_HEADER]: session, [VERSION_HEADER]: version };
}

export function withAdobeIdentity(
  identity: Record<string, string>,
  headers: ProviderHeaders = {}
): ProviderHeaders {
  const ours = new Set(Object.keys(identity).map((name) => name.toLowerCase()));
  const kept = Object.entries(headers).filter(([name]) => !ours.has(name.toLowerCase()));
  return { ...Object.fromEntries(kept), ...identity };
}

function identified<T extends { headers?: ProviderHeaders }>(
  identity: Record<string, string>,
  options: T | undefined
): T {
  return { ...options, headers: withAdobeIdentity(identity, options?.headers) } as T;
}

type Call = (model: unknown, input: unknown, options?: { headers?: ProviderHeaders }) => unknown;

function identifiedApi(api: ProviderStreams, identity: Record<string, string>): ProviderStreams {
  const calls = Object.entries(api as unknown as Record<string, Call>).map(([name, call]) => [
    name,
    (model: unknown, input: unknown, options?: { headers?: ProviderHeaders }) =>
      call(model, input, identified(identity, options)),
  ]);
  return Object.fromEntries(calls) as ProviderStreams;
}

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

function clef(fetcher: Fetch, identity: Record<string, string>): ProviderClassifier {
  const transport = cloudflareWorkersAISystemOneApi();
  return {
    classify: (model, context, options = {}) =>
      transport.classify(model, context, {
        ...identified(identity, options),
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

export async function adobeConfig(
  endpoint: string,
  fetcher: Fetch,
  identity = adobeIdentity()
): Promise<AdobeConfig> {
  const response = await fetcher(`${endpoint}/v1/config`, {
    headers: { Accept: 'application/json', ...identity },
  });
  if (!response.ok) throw new Error(`the Adobe proxy answered /v1/config with ${response.status}`);
  return (await response.json()) as AdobeConfig;
}

export async function adobeUsage(
  token: string,
  {
    endpoint = ADOBE_PROXY,
    fetch: fetcher = globalThis.fetch,
    identity = adobeIdentity(),
  }: { endpoint?: string; fetch?: Fetch; identity?: Record<string, string> } = {}
): Promise<Budget | null> {
  const response = await fetcher(`${endpoint}/v1/usage`, {
    headers: { Accept: 'application/json', ...identity, Authorization: `Bearer ${token}` },
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
  session,
  version,
  fetch: fetcher = (input, init) => globalThis.fetch(input, init),
}: {
  endpoint?: string;
  session?: string;
  version?: string;
  fetch?: Fetch;
} = {}): Provider {
  const identity = adobeIdentity({ session, version });
  return createProvider({
    id: ADOBE,
    name: 'Adobe',
    baseUrl: endpoint,
    headers: identity,
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
      (await adobeConfig(endpoint, fetcher, identity)).models
        .filter((info) => !info.hidden)
        .map((info) => adobeModel(info, endpoint)),
    api: {
      'anthropic-messages': identifiedApi(anthropicMessagesApi(), identity),
      'openai-completions': identifiedApi(openAICompletionsApi(), identity),
    },
    classifiers: { [CLASSIFIER_API]: clef(fetcher, identity) },
  }) as Provider;
}
