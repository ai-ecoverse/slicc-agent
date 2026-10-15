import { type Context, RemoteServiceError, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CredentialStore, Provider } from '@earendil-works/pi-ai';
import { createModels, type MutableModels } from '@earendil-works/pi-ai/models';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import {
  ADOBE,
  ADOBE_PROXY,
  adobeConfig,
  adobeIdentity,
  adobeProvider,
  adobeUsage,
  type Budget,
} from './adobe.ts';
import type { McpAccounts } from './mcp/index.ts';
import { MCP_ACCOUNT } from './mcp/label.ts';
import { BEDROCK, preferredModel } from './preferred.ts';
import type { KeysMoved } from './secrets/legacy.ts';
import type { VaultRecords } from './secrets/records.ts';
import type { PlainStore } from './secrets/store.ts';
import type {
  AccountField,
  AccountState,
  AgentSettings,
  ModelChoice,
  SettingsState,
} from './services.ts';

export { BEDROCK, PREFERRED_MODELS, preferredModel } from './preferred.ts';

export const DEFAULT_MODEL = { provider: BEDROCK, modelId: 'us.anthropic.claude-sonnet-5-5' };
export const DEFAULT_REGIONS: Readonly<Record<string, string>> = { [BEDROCK]: 'us-west-2' };

export const ACCOUNT_FIELDS: Readonly<Record<string, readonly AccountField[]>> = {
  [BEDROCK]: [{ name: 'region', label: 'Region' }],
};
const FIELD_ENV: Readonly<Record<string, string>> = { region: 'AWS_REGION' };
export const SIGN_IN_NEEDS_VAULT = "Adobe sign-in needs seven's vault: update seven";
export const KEY_NEEDS_VAULT = "API keys are kept in seven's vault: update seven";

export async function resolveDefaultModel(
  credentials: CredentialStore,
  providers: Provider[],
  models: MutableModels
): Promise<{ provider: string; modelId: string }> {
  const stored = new Set((await credentials.list()).map((info) => info.providerId));
  for (const provider of providers) {
    if (!stored.has(provider.id)) continue;
    if (!models.getModels(provider.id).length && provider.refreshModels) {
      await models.refresh({ providers: [provider.id] }).catch(() => undefined);
    }
    const chosen = preferredModel(provider.id, models.getModels(provider.id));
    if (chosen) return { provider: provider.id, modelId: chosen.id };
  }
  return DEFAULT_MODEL;
}

const corsFree = new Set([BEDROCK, ADOBE]);
const signIn = new Set([ADOBE]);
const BUDGET_EVERY = 5 * 60 * 1000;

export function sliccProviders(version?: string): Provider[] {
  return [amazonBedrockProvider() as Provider, adobeProvider({ version })];
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

function choices(
  models: MutableModels,
  providers: Provider[],
  stored: ReadonlySet<string>
): ModelChoice[] {
  return providers
    .filter((provider) => stored.has(provider.id))
    .flatMap((provider) =>
      models.getModels(provider.id).map((model) => ({
        id: `${provider.id}/${model.id}`,
        label: model.name,
        provider: provider.name ?? provider.id,
        kind: 'chat' as const,
        reasoning: Boolean(model.reasoning),
        images: model.input.includes('image'),
        contextWindow: model.contextWindow,
      }))
    );
}

function accounts(records: Pick<VaultRecords, 'model'>, providers: Provider[]): AccountState[] {
  return providers.map((provider) => {
    const record = records.model(provider.id);
    const fields = ACCOUNT_FIELDS[provider.id];
    return {
      id: provider.id,
      provider: provider.name ?? provider.id,
      identity: record ? (signIn.has(provider.id) ? 'Adobe ID' : 'API key') : '',
      status: !record ? 'disconnected' : record.state === 'expired' ? 'expired' : 'connected',
      auth: signIn.has(provider.id) ? 'oauth' : 'api-key',
      needs: corsFree.has(provider.id) ? 'cors-free-transport' : null,
      store: 'vault',
      ...(fields ? { fields: fields.map((field) => ({ ...field })) } : {}),
    };
  });
}

export interface ProviderFields {
  get(providerId: string): Readonly<Record<string, string>> | undefined;
  env(providerId: string): Readonly<Record<string, string>> | undefined;
  set(providerId: string, fields: Record<string, string> | undefined): Promise<void>;
}

export async function providerFields(
  store: PlainStore,
  providers: readonly Provider[]
): Promise<ProviderFields> {
  const known = new Map<string, Record<string, string>>();
  for (const provider of providers) {
    const saved = (await store.get(`model:${provider.id}`)) as Record<string, string> | undefined;
    if (saved && typeof saved === 'object') known.set(provider.id, saved);
  }
  return {
    get: (providerId) => known.get(providerId),
    env(providerId) {
      const fields = known.get(providerId);
      if (!fields) return undefined;
      return Object.fromEntries(
        Object.entries(fields).flatMap(([name, value]) =>
          FIELD_ENV[name] ? [[FIELD_ENV[name], value]] : []
        )
      );
    },
    async set(providerId, fields) {
      const allowed = new Set((ACCOUNT_FIELDS[providerId] ?? []).map((field) => field.name));
      const kept = Object.fromEntries(
        Object.entries(fields ?? {}).filter(
          ([name, value]) => allowed.has(name) && typeof value === 'string' && value.trim() !== ''
        )
      );
      const next = Object.keys(kept).length ? kept : undefined;
      if (next) known.set(providerId, next);
      else known.delete(providerId);
      await store.set(`model:${providerId}`, next);
    },
  };
}

export async function shown<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new RemoteServiceError(
      'service_invalid_value',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export type UsageReader = (token: string) => Promise<Budget | null>;

async function budget(records: Pick<VaultRecords, 'model'>, usage: UsageReader) {
  const key = records.model(ADOBE)?.placeholder;
  const found = key ? await usage(key).catch(() => null) : null;
  return found ? { provider: ADOBE, ...found } : null;
}

export interface SettingsSources {
  records: VaultRecords;
  fields: ProviderFields;
}

export async function createAgentSettings(
  models: MutableModels,
  sources: SettingsSources,
  providers = sliccProviders(),
  options: { usage?: UsageReader; every?: number; mcp?: McpAccounts; moved?: KeysMoved } = {}
): Promise<AgentSettings> {
  const { mcp, moved } = options;
  const { records, fields } = sources;
  const routed = (providerId: string) => (providerId.startsWith(MCP_ACCOUNT) ? mcp : undefined);
  const adobe = providers.find((provider) => provider.id === ADOBE);
  const endpoint = adobe?.baseUrl ?? ADOBE_PROXY;
  const identity = (adobe?.headers as Record<string, string> | undefined) ?? adobeIdentity();
  const usage = options.usage ?? ((token: string) => adobeUsage(token, { endpoint, identity }));
  const snapshot = async (): Promise<SettingsState> => {
    const stored = new Set(
      providers.filter((provider) => records.model(provider.id)).map((provider) => provider.id)
    );
    return {
      models: choices(models, providers, stored),
      accounts: [...accounts(records, providers), ...((await mcp?.accounts()) ?? [])],
      budget: await budget(records, usage),
      ...(moved?.state.value?.length ? { moved: [...moved.state.value] } : {}),
    };
  };
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
  mcp?.onChange(() => void refresh(BACKGROUND_CONTEXT).catch(() => undefined));
  moved?.state.subscribe((_value, context) => void refresh(context).catch(() => undefined));
  const held = () => signedIn.filter((id) => records.model(id)).join(' ');
  let seen = held();
  records.state.subscribe(() => {
    const now = held();
    const added = now !== seen;
    seen = now;
    const discovered = added ? discover(signedIn) : Promise.resolve();
    void discovered.then(() => refresh(BACKGROUND_CONTEXT)).catch(() => undefined);
  });
  const reread = (context: Context) => records.refresh(context).catch(() => undefined);
  return {
    state,
    async connect(providerId, secret, given, context) {
      const server = routed(providerId);
      if (server) {
        await shown(() => server.connect(providerId, secret));
        await refresh(context);
        return;
      }
      if (secret !== null)
        throw new RemoteServiceError(
          'service_invalid_value',
          signIn.has(providerId) ? SIGN_IN_NEEDS_VAULT : KEY_NEEDS_VAULT
        );
      if (given !== null) await fields.set(providerId, given);
      await reread(context);
      if (signIn.has(providerId)) await discover([providerId]);
      await refresh(context);
    },
    async signIn(providerId) {
      const server = routed(providerId);
      if (server) return shown(() => server.signIn(providerId));
      if (providerId !== ADOBE) return null;
      const { clientId, scopes, imsEnvironment } = await adobeConfig(
        endpoint,
        (input, init) => globalThis.fetch(input, init),
        identity
      );
      return { clientId, scopes, imsEnvironment: imsEnvironment || 'prod' };
    },
    async dismissMoved(context) {
      await moved?.dismiss(context);
      await refresh(context);
    },
    async disconnect(providerId, context) {
      const server = routed(providerId);
      if (server) await server.disconnect(providerId);
      else await fields.set(providerId, undefined);
      await reread(context);
      await refresh(context);
    },
  };
}
