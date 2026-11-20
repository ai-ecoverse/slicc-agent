import type { Credential, OAuthCredential, Provider, ProviderEnv } from '@earendil-works/pi-ai';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { headerList } from './net.ts';

export const COPILOT = 'github-copilot';
export const COPILOT_ENDPOINT = 'COPILOT_ENDPOINT';
export const COPILOT_MODELS: readonly string[] = Array.from(
  { length: 15 },
  (_, at) => `COPILOT_MODELS_${at + 1}`
);

const SETTING_LENGTH = 256;
const MODEL_ID = /^[^,\0-\x1f\x7f]+$/;

const PLANS: ReadonlySet<string> = new Set(['individual', 'business', 'enterprise']);
const PROXY = /(?:^|;)proxy-ep=proxy\.([a-z]+)\.githubcopilot\.com(?:;|:|$)/;
const GITHUB = /(?:^|\.)(?:github\.com|githubcopilot\.com)$/;

export const COPILOT_BASES: readonly string[] = [...PLANS].map(
  (plan) => `https://api.${plan}.githubcopilot.com`
);

export function copilotBase(env: ProviderEnv | undefined): string {
  const plan = env?.[COPILOT_ENDPOINT];
  return `https://api.${plan && PLANS.has(plan) ? plan : 'individual'}.githubcopilot.com`;
}

function modelIdsOf(credential: OAuthCredential): string[] {
  const ids = credential.availableModelIds;
  if (!Array.isArray(ids)) return [];
  return [
    ...new Set(
      ids.filter(
        (id): id is string =>
          typeof id === 'string' && id.length <= SETTING_LENGTH && MODEL_ID.test(id)
      )
    ),
  ];
}

function modelSettings(credential: OAuthCredential): Record<string, string> {
  const chunks: string[] = [];
  for (const id of modelIdsOf(credential)) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + id.length <= SETTING_LENGTH)
      chunks[chunks.length - 1] = `${last},${id}`;
    else chunks.push(id);
  }
  if (chunks.length > COPILOT_MODELS.length) return {};
  return Object.fromEntries(chunks.map((chunk, at) => [COPILOT_MODELS[at], chunk]));
}

export function copilotSettings(credential: OAuthCredential): Record<string, string> {
  const plan = PROXY.exec(credential.access)?.[1];
  return {
    ...(plan && PLANS.has(plan) ? { [COPILOT_ENDPOINT]: plan } : {}),
    ...modelSettings(credential),
  };
}

export function copilotModels(credential: Credential | undefined): ReadonlySet<string> | undefined {
  const env = credential?.type === 'api_key' ? credential.env : undefined;
  const chunks: string[] = [];
  for (const name of COPILOT_MODELS) {
    const chunk = env?.[name];
    if (!chunk) break;
    chunks.push(chunk);
  }
  return chunks.length ? new Set(chunks.join(',').split(',')) : undefined;
}

export function copilotProvider(): Provider {
  const base = githubCopilotProvider() as Provider;
  return {
    ...base,
    filterModels: (models, credential) => {
      const available = copilotModels(credential);
      return available ? models.filter((model) => available.has(model.id)) : models;
    },
    auth: {
      ...base.auth,
      apiKey: {
        name: 'GitHub Copilot sign-in',
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          if (!credential?.key) return undefined;
          return {
            auth: { apiKey: credential.key, baseUrl: copilotBase(credential.env) },
            ...(credential.env ? { env: credential.env } : {}),
            source: 'vault',
          };
        },
      },
    },
  };
}

const API = /^api\.(?:individual|business|enterprise)\.githubcopilot\.com$/;
const SIGN_IN_PATHS = /^\/models(?:\/[^/]+\/policy)?$/;

export function copilotFetch(inner: typeof fetch, direct: typeof fetch): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!GITHUB.test(url.hostname)) return inner(request, init);
    const headers = headerList(request, input, init).filter(
      ([name]) => name.toLowerCase() !== 'user-agent'
    );
    const signingIn = API.test(url.hostname) && SIGN_IN_PATHS.test(url.pathname);
    return (signingIn ? direct : inner)(request, { headers });
  };
}
