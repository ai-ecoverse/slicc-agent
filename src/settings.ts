import { type Context, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CredentialStore, Provider } from '@earendil-works/pi-ai';
import { createModels, type MutableModels } from '@earendil-works/pi-ai/models';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import {
  ADOBE,
  ADOBE_PROXY,
  adobeConfig,
  adobeProvider,
  adobeUsage,
  type Budget,
} from './adobe.ts';
import type { AccountState, AgentSettings, ModelChoice, SettingsState } from './services.ts';

export const BEDROCK = 'amazon-bedrock';
export const DEFAULT_MODEL = { provider: BEDROCK, modelId: 'us.anthropic.claude-sonnet-5-5' };
export const DEFAULT_REGIONS: Readonly<Record<string, string>> = { [BEDROCK]: 'us-west-2' };

const corsFree = new Set([BEDROCK, ADOBE]);
const signIn = new Set([ADOBE]);
const BUDGET_EVERY = 5 * 60 * 1000;

export function sliccProviders(): Provider[] {
  return [amazonBedrockProvider() as Provider, adobeProvider()];
}

export function withDefaultRegions(credentials: CredentialStore): CredentialStore {
  return {
    async read(providerId, options) {
      const credential = await credentials.read(providerId, options);
      const region = DEFAULT_REGIONS[providerId];
      if (credential?.type !== 'api_key' || !region || credential.env?.AWS_REGION) {
        return credential;
      }
      return { ...credential, env: { ...credential.env, AWS_REGION: region } };
    },
    list: (options) => credentials.list(options),
    modify: (providerId, fn, options) => credentials.modify(providerId, fn, options),
    delete: (providerId, options) => credentials.delete(providerId, options),
  };
}

export function createSliccModels(
  credentials: CredentialStore,
  providers = sliccProviders()
): MutableModels {
  const models = createModels({ credentials: withDefaultRegions(credentials) });
  for (const provider of providers) models.setProvider(provider);
  return models;
}

function choices(models: MutableModels, providers: Provider[]): ModelChoice[] {
  return providers.flatMap((provider) =>
    models.getModels(provider.id).map((model) => ({
      id: `${provider.id}/${model.id}`,
      label: model.name,
      provider: provider.name ?? provider.id,
      kind: 'chat' as const,
      reasoning: Boolean(model.reasoning),
      contextWindow: model.contextWindow,
    }))
  );
}

async function accounts(
  credentials: CredentialStore,
  providers: Provider[]
): Promise<AccountState[]> {
  const stored = new Set((await credentials.list()).map((info) => info.providerId));
  return providers.map((provider) => ({
    id: provider.id,
    provider: provider.name ?? provider.id,
    identity: stored.has(provider.id) ? (signIn.has(provider.id) ? 'Adobe ID' : 'API key') : '',
    status: stored.has(provider.id) ? 'connected' : 'disconnected',
    auth: signIn.has(provider.id) ? 'oauth' : 'api-key',
    needs: corsFree.has(provider.id) ? 'cors-free-transport' : null,
  }));
}

export type UsageReader = (token: string) => Promise<Budget | null>;

async function budget(credentials: CredentialStore, usage: UsageReader) {
  const credential = await credentials.read(ADOBE);
  const key = credential?.type === 'api_key' ? credential.key : undefined;
  const found = key ? await usage(key).catch(() => null) : null;
  return found ? { provider: ADOBE, ...found } : null;
}

export async function createAgentSettings(
  models: MutableModels,
  credentials: CredentialStore,
  providers = sliccProviders(),
  options: { usage?: UsageReader; every?: number } = {}
): Promise<AgentSettings> {
  const endpoint = providers.find((provider) => provider.id === ADOBE)?.baseUrl ?? ADOBE_PROXY;
  const usage = options.usage ?? ((token: string) => adobeUsage(token, { endpoint }));
  const snapshot = async (): Promise<SettingsState> => ({
    models: choices(models, providers),
    accounts: await accounts(credentials, providers),
    budget: await budget(credentials, usage),
  });
  const state = replicatedState<SettingsState>(await snapshot());
  let latest = Promise.resolve();
  const refresh = (context: Context) => {
    const next = latest.then(async () => state.replace(context, await snapshot()));
    latest = next.catch(() => undefined);
    return next;
  };
  const signedIn = providers
    .filter((provider) => signIn.has(provider.id))
    .map((provider) => provider.id);
  const discover = (ids: string[]) =>
    models.refresh({ providers: ids }).then(
      () => undefined,
      () => undefined
    );
  if (signedIn.length) {
    const cycle = () =>
      void discover(signedIn)
        .then(() => refresh(BACKGROUND_CONTEXT))
        .catch(() => undefined);
    cycle();
    const timer: unknown = setInterval(cycle, options.every ?? BUDGET_EVERY);
    (timer as { unref?: () => void }).unref?.();
  }
  return {
    state,
    async connect(providerId, secret, region, context) {
      await credentials.modify(providerId, async () => ({
        type: 'api_key',
        key: secret,
        ...(region ? { env: { AWS_REGION: region } } : {}),
      }));
      if (signIn.has(providerId)) await discover([providerId]);
      await refresh(context);
    },
    async signIn(providerId) {
      if (providerId !== ADOBE) return null;
      const { clientId, scopes, imsEnvironment } = await adobeConfig(endpoint, (input, init) =>
        globalThis.fetch(input, init)
      );
      return { clientId, scopes, imsEnvironment: imsEnvironment || 'prod' };
    },
    async disconnect(providerId, context) {
      await credentials.delete(providerId);
      await refresh(context);
    },
  };
}
