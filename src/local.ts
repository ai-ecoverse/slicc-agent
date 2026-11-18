import type { ClassifierModel, Model, Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { typesafeSystemOneApi } from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';
import { FACADE_PORT, kernelHost, ownKernelServer } from './kernel/loopback.ts';

export const LOCAL = 'local';
export const LOCAL_BASE = 'LOCAL_BASE_URL';
export const LOCAL_CONTEXT = 'LOCAL_CONTEXT_WINDOW';
export const DEFAULT_CONTEXT = 32768;
export const SMALL_CONTEXT = 16384;
export const DECISIONS_API = 'typesafe-system-one' as const;

type Fetch = typeof fetch;

export interface ListedModel {
  id: string;
  context_length?: number;
  max_context_length?: number;
  meta?: { n_ctx?: number };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const COMPAT: Model<'openai-completions'>['compat'] = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStrictMode: false,
  maxTokensField: 'max_tokens',
};

const ADDRESS =
  'Enter the server’s address, such as http://127.0.0.1:11434/v1, without a user name or password.';
const FAR =
  'An http:// address must be on this machine, your network or your tailnet; use https:// for anything else.';
const FACADE = `Use <port>.kernel.localhost with a port from 1 to 65535 other than ${FACADE_PORT}, the CDP facade.`;

export const KEY_OVER_HTTP =
  'Seven’s vault sends keys over https:// only, so this http:// endpoint can’t take a key yet. Remove the account and add it again without a key, or use an https:// endpoint.';

export const ORIGINS_HINT =
  'If the server is running, let seven reach it: OLLAMA_ORIGINS=https://seven.sliccy.ai for Ollama, Enable CORS in LM Studio, --allowed-origins for vLLM, ORTLLAMA_ORIGINS for ortllama, or link slicc.';

const V4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

function privateV4(host: string): boolean {
  const found = V4.exec(host);
  if (!found) return false;
  const [a, b] = [Number(found[1]), Number(found[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function nearby(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.ts.net') ||
    host === '[::1]' ||
    /^\[f[cd][0-9a-f]{2}:/.test(host) ||
    privateV4(host)
  );
}

export function localBase(value: string): string | { problem: string } {
  const url = URL.parse(value);
  if (!url || url.username || url.password || !['http:', 'https:'].includes(url.protocol))
    return { problem: ADDRESS };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (kernelHost(host) && (!ownKernelServer(host) || url.port !== '')) return { problem: FACADE };
  if (url.protocol === 'http:' && !nearby(host)) return { problem: FAR };
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path.endsWith('/v1') ? path : `${path}/v1`}`;
}

export function localEndpoint(value: string): Record<string, string> | string {
  const base = localBase(value);
  return typeof base === 'string' ? { [LOCAL_BASE]: base } : base.problem;
}

export function localContext(value: string): Record<string, string> | string {
  return /^[1-9]\d{0,8}$/.test(value)
    ? { [LOCAL_CONTEXT]: value }
    : 'Enter the context window as a number of tokens, such as 32768.';
}

const counted = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function contextOf(model: ListedModel, fallback?: number): number {
  return (
    [model.context_length, model.meta?.n_ctx, model.max_context_length].find(counted) ??
    fallback ??
    DEFAULT_CONTEXT
  );
}

export function localModel(
  model: ListedModel,
  baseUrl: string,
  fallback?: number
): Model<'openai-completions'> | ClassifierModel<typeof DECISIONS_API> {
  const contextWindow = contextOf(model, fallback);
  if (model.architecture?.output_modalities?.includes('decisions'))
    return {
      type: 'classifier',
      id: model.id,
      name: model.id,
      provider: LOCAL,
      api: DECISIONS_API,
      baseUrl,
      input: ['text'],
      cost: free,
      contextWindow,
    };
  return {
    id: model.id,
    name: model.id,
    provider: LOCAL,
    api: 'openai-completions',
    baseUrl,
    reasoning: false,
    input: model.architecture?.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
    cost: free,
    contextWindow,
    maxTokens: contextWindow,
    compat: COMPAT,
  };
}

function failed(base: string, why: string): Error {
  return new Error(`Couldn’t reach ${base}/models: ${why}. ${ORIGINS_HINT}`);
}

export async function listLocal(
  base: string,
  { key, fetch: fetcher, signal }: { key?: string; fetch: Fetch; signal?: AbortSignal }
): Promise<ListedModel[]> {
  let response: Response;
  try {
    response = await fetcher(`${base}/models`, {
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failed(base, error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw failed(base, `it answered ${response.status}`);
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(body?.data)) throw failed(base, 'it sent no model list');
  return body.data.filter(
    (entry): entry is ListedModel =>
      typeof entry === 'object' && entry !== null && typeof entry.id === 'string'
  );
}

export function localProvider({
  fetch: fetcher = (input, init) => globalThis.fetch(input, init),
}: {
  fetch?: Fetch;
} = {}): Provider {
  return createProvider({
    id: LOCAL,
    name: 'Local or self-hosted',
    auth: {
      apiKey: {
        name: 'Local or self-hosted',
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          const baseUrl = credential?.env?.[LOCAL_BASE];
          if (!baseUrl) return undefined;
          return {
            auth: { apiKey: credential?.key ?? 'local', baseUrl },
            env: { ...credential?.env },
            source: credential?.key ? 'API key' : 'No key',
          };
        },
      },
    },
    models: [],
    fetchModels: async ({ credential, signal }) => {
      const keyed = credential?.type === 'api_key' ? credential : undefined;
      const base = keyed?.env?.[LOCAL_BASE];
      if (!base) return [];
      const fallback = Number(keyed?.env?.[LOCAL_CONTEXT]) || undefined;
      const listed = await listLocal(base, {
        key: keyed?.key,
        fetch: fetcher,
        signal,
      });
      return listed.map((model) => localModel(model, base, fallback));
    },
    api: { 'openai-completions': openAICompletionsApi() },
    classifiers: { [DECISIONS_API]: typesafeSystemOneApi() },
  }) as Provider;
}
