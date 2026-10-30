import { type Context, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CredentialStore, ModelsStore, Provider } from '@earendil-works/pi-ai';
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
import { abortableBedrock } from './bedrock.ts';
import { codexProvider } from './codex.ts';
import { type DeviceFlows, deviceFlows } from './device.ts';
import type { McpAccounts } from './mcp/index.ts';
import { MCP_ACCOUNT } from './mcp/label.ts';
import type { Reach } from './net.ts';
import { BEDROCK, preferredModel } from './preferred.ts';
import {
  ADDED_FIRST,
  DEFAULT_REGION,
  type FieldSpec,
  KEY_PROVIDERS,
  LISTINGS,
  type Listing,
} from './providers.ts';
import { absent } from './secrets/fetch.ts';
import type { KeysMoved } from './secrets/legacy.ts';
import type { VaultRecords } from './secrets/records.ts';
import type { PlainStore } from './secrets/store.ts';
import type { Vault } from './secrets/vault.ts';
import type {
  AccountField,
  AccountState,
  AgentSettings,
  BudgetState,
  ModelChoice,
  ProviderOption,
  SettingsState,
} from './services.ts';
import { DEVICE_NEEDS_VAULT, DEVICE_SIGN_INS } from './sign-ins.ts';
import { XAI, xaiUsage } from './supergrok.ts';

export { BEDROCK, PREFERRED_MODELS, preferredModel } from './preferred.ts';

export const DEFAULT_MODEL = { provider: BEDROCK, modelId: 'us.anthropic.claude-sonnet-5-5' };
export const DEFAULT_REGIONS: Readonly<Record<string, string>> = { [BEDROCK]: DEFAULT_REGION };

const specs = (providerId: string): readonly FieldSpec[] => LISTINGS.get(providerId)?.fields ?? [];

export const ACCOUNT_FIELDS: Readonly<Record<string, readonly AccountField[]>> = Object.fromEntries(
  [...LISTINGS.keys()]
    .filter((id) => specs(id).length)
    .map((id) => [id, specs(id).map(({ env: _env, ...field }) => field)])
);
const NO_SERVERS = {
  ok: false as const,
  code: 'invalid' as const,
  reason: 'this agent has no MCP servers',
};

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

const signIn = new Set([ADOBE]);
const oauth = (providerId: string) => signIn.has(providerId) || DEVICE_SIGN_INS.has(providerId);
const SIGN_IN_CORS_FREE = new Set(['xai']);
const BUDGET_EVERY = 5 * 60 * 1000;

export function sliccProviders(version?: string): Provider[] {
  return [
    amazonBedrockProvider() as Provider,
    adobeProvider({ version }),
    ...KEY_PROVIDERS.map((entry) => entry.make()),
    codexProvider(),
  ];
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

export function catalogStore(store: PlainStore): ModelsStore {
  return {
    read: async (providerId) =>
      ((await store.get(providerId)) as Awaited<ReturnType<ModelsStore['read']>>) ?? undefined,
    write: (providerId, entry) => store.set(providerId, entry),
    delete: (providerId) => store.set(providerId, undefined),
  };
}

export function createSliccModels(
  credentials: CredentialStore,
  providers = sliccProviders(),
  catalog?: ModelsStore
): MutableModels {
  const models = createModels({
    credentials: withDefaultRegions(credentials),
    ...(catalog ? { modelsStore: catalog } : {}),
  });
  for (const provider of providers) models.setProvider(abortableBedrock(provider));
  return models;
}

const SHORT: Record<string, string> = { [BEDROCK]: 'Bedrock', [ADOBE]: 'Adobe' };

function labels(
  models: MutableModels,
  providers: Provider[],
  stored: ReadonlySet<string>
): Record<string, string> {
  return Object.fromEntries(
    providers
      .filter((provider) => !stored.has(provider.id))
      .flatMap((provider) =>
        models
          .getModels(provider.id)
          .map((model) => [
            `${provider.id}/${model.id}`,
            `${model.name} on ${SHORT[provider.id] ?? provider.name ?? provider.id}`,
          ])
      )
  );
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

function listed(
  records: Pick<VaultRecords, 'model'>,
  fields: Pick<ProviderFields, 'get' | 'added'>
): (providerId: string) => boolean {
  const added = new Set(fields.added() ?? ADDED_FIRST);
  return (providerId) =>
    !LISTINGS.has(providerId) ||
    added.has(providerId) ||
    records.model(providerId) !== undefined ||
    fields.get(providerId) !== undefined;
}

function filled(
  fields: readonly AccountField[],
  stored: Readonly<Record<string, string>> | undefined
): AccountField[] {
  return fields.map((field) => {
    const value = stored?.[field.name]?.trim() || field.value;
    const options =
      field.options && value && !field.options.some((option) => option.value === value)
        ? [{ value, label: value }, ...field.options]
        : field.options;
    return { ...field, ...(options ? { options: [...options] } : {}), ...(value ? { value } : {}) };
  });
}

function accounts(
  records: Pick<VaultRecords, 'model'>,
  providers: Provider[],
  given: Pick<ProviderFields, 'ready' | 'get'>,
  blocked: (providerId: string) => boolean
): AccountState[] {
  return providers.map((provider) => {
    const record = given.ready(provider.id) ? records.model(provider.id) : undefined;
    const fields = ACCOUNT_FIELDS[provider.id];
    const listing = LISTINGS.get(provider.id);
    return {
      id: provider.id,
      provider: provider.name ?? provider.id,
      identity: record ? identityOf(provider.id, record) : '',
      status: !record ? 'disconnected' : record.state === 'expired' ? 'expired' : 'connected',
      auth: oauth(provider.id) ? 'oauth' : 'api-key',
      ...(DEVICE_SIGN_INS.has(provider.id) && listing?.keyUrl
        ? { secret: 'api-key' as const }
        : {}),
      needs: listing?.corsFree ? 'cors-free-transport' : null,
      ...(blocked(provider.id) ? { blocked: 'cors-free-transport' as const } : {}),
      group: 'providers',
      store: 'vault',
      ...(fields ? { fields: filled(fields, given.get(provider.id)) } : {}),
      ...about(listing),
    };
  });
}

function identityOf(providerId: string, record: { expiresAt?: number }): string {
  if (signIn.has(providerId)) return 'Adobe ID';
  return DEVICE_SIGN_INS.has(providerId) && record.expiresAt !== undefined
    ? 'Signed in'
    : 'API key';
}

function about(listing: Listing | undefined) {
  if (!listing) return {};
  return {
    description: listing.description,
    vaultName: listing.vaultName,
    ...(listing.keyUrl ? { keyUrl: listing.keyUrl } : {}),
  };
}

function offered(
  providers: Provider[],
  blocked: (providerId: string) => boolean
): ProviderOption[] {
  return providers
    .flatMap((provider): ProviderOption[] => {
      const listing = LISTINGS.get(provider.id);
      if (!listing) return [];
      const fields = ACCOUNT_FIELDS[provider.id];
      return [
        {
          id: provider.id,
          name: provider.name,
          description: listing.description,
          auth: listing.auth,
          vaultName: listing.vaultName,
          ...(fields ? { fields: filled(fields, undefined) } : {}),
          ...(listing.keyUrl ? { keyUrl: listing.keyUrl } : {}),
          ...(listing.corsFree ? { needs: 'cors-free-transport' as const } : {}),
          ...(blocked(provider.id) ? { blocked: 'cors-free-transport' as const } : {}),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ProviderFields {
  get(providerId: string): Readonly<Record<string, string>> | undefined;
  env(providerId: string): Readonly<Record<string, string>> | undefined;
  set(providerId: string, fields: Record<string, string> | undefined): Promise<void>;
  ready(providerId: string): boolean;
  added(): readonly string[] | undefined;
  add(providerId: string): Promise<void>;
  forget(providerId: string): Promise<void>;
}

const ADDED = 'providers';

export async function providerFields(
  store: PlainStore,
  providers: readonly Provider[]
): Promise<ProviderFields> {
  const known = new Map<string, Record<string, string>>();
  for (const provider of providers) {
    const saved = (await store.get(`model:${provider.id}`)) as Record<string, string> | undefined;
    if (saved && typeof saved === 'object') known.set(provider.id, saved);
  }
  const saved = await store.get(ADDED);
  let added = Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === 'string')
    : undefined;
  const keep = async (next: string[]) => {
    added = next;
    await store.set(ADDED, next);
  };
  return {
    ready: (providerId) =>
      specs(providerId).every((spec) => {
        const value = known.get(providerId)?.[spec.name];
        if (value === undefined) return !spec.required;
        return typeof spec.env(value.trim()) !== 'string';
      }),
    added: () => added,
    async add(providerId) {
      const now = added ?? ADDED_FIRST;
      if (added && now.includes(providerId)) return;
      await keep([...new Set([...now, providerId])]);
    },
    async forget(providerId) {
      await keep((added ?? ADDED_FIRST).filter((id) => id !== providerId));
      known.delete(providerId);
      await store.set(`model:${providerId}`, undefined);
    },
    get: (providerId) => known.get(providerId),
    env(providerId) {
      const fields = known.get(providerId);
      if (!fields) return undefined;
      return Object.assign(
        {},
        ...specs(providerId).flatMap((spec) => {
          const value = fields[spec.name];
          const env = value === undefined ? '' : spec.env(value.trim());
          return typeof env === 'string' ? [] : [env];
        })
      );
    },
    async set(providerId, fields) {
      const kept: Record<string, string> = {};
      for (const spec of specs(providerId)) {
        const given = fields?.[spec.name];
        const value = typeof given === 'string' ? given.trim() : '';
        const stored = known.get(providerId)?.[spec.name];
        if (!value && spec.required && fields && stored) kept[spec.name] = stored;
        else if (!value && spec.required && fields)
          throw new Error(`${spec.label} can’t be empty.`);
        else if (value) {
          const problem = spec.env(value);
          if (typeof problem === 'string') throw new Error(problem);
          kept[spec.name] = value;
        }
      }
      const next = Object.keys(kept).length ? kept : undefined;
      if (next) known.set(providerId, next);
      else known.delete(providerId);
      await store.set(`model:${providerId}`, next);
    },
  };
}

export type UsageReader = (token: string) => Promise<Budget | null>;

async function adobeBudget(records: Pick<VaultRecords, 'model'>, usage: UsageReader) {
  const key = records.model(ADOBE)?.placeholder;
  const found = key ? await usage(key).catch(() => null) : null;
  return found ? { provider: ADOBE, ...found } : null;
}

export function grokBudgets(
  records: Pick<VaultRecords, 'model'>,
  usage: UsageReader,
  { reach, every, now }: { reach?: Reach; every: number; now: () => number }
): () => Promise<BudgetState | null> {
  let kept: { key: string; at: number; found: Promise<Budget | null> } | undefined;
  return async () => {
    const record = records.model(XAI);
    if (!record || record.expiresAt === undefined || record.state === 'expired') return null;
    if (reach?.free() !== true) return null;
    const key = `${record.placeholder} ${record.expiresAt}`;
    const at = now();
    if (!kept || kept.key !== key || at - kept.at >= every)
      kept = { key, at, found: usage(record.placeholder).catch(() => null) };
    const found = await kept.found;
    return found ? { provider: XAI, ...found } : null;
  };
}

export interface SettingsSources {
  records: VaultRecords;
  fields: ProviderFields;
}

function blockedBy(reach: Reach | undefined): (providerId: string) => boolean {
  return (providerId) => Boolean(LISTINGS.get(providerId)?.corsFree) && reach?.free() === false;
}

export async function createAgentSettings(
  models: MutableModels,
  sources: SettingsSources,
  providers = sliccProviders(),
  options: {
    usage?: UsageReader;
    every?: number;
    mcp?: McpAccounts;
    moved?: KeysMoved;
    reach?: Reach;
    vault?: Pick<Vault, 'connected' | 'needed' | 'grantProvider'>;
    flows?: DeviceFlows;
    grok?: UsageReader;
    now?: () => number;
  } = {}
): Promise<AgentSettings> {
  const { mcp, moved, reach, vault } = options;
  const blocked = blockedBy(reach);
  const flows =
    options.flows ??
    deviceFlows((grant) => (vault as Pick<Vault, 'grantProvider'>).grantProvider(grant));
  const device = (providerId: string, context: Context) => {
    const provider = providers.find((candidate) => candidate.id === providerId);
    const name = LISTINGS.get(providerId)?.vaultName;
    if (!provider || !name) return Promise.resolve(null);
    if (!vault || absent(vault)) return Promise.reject(new Error(DEVICE_NEEDS_VAULT));
    if (blocked(providerId) || (SIGN_IN_CORS_FREE.has(providerId) && reach?.free() === false))
      return Promise.reject(new Error(`${provider.name} sign-in needs the cors-free transport.`));
    return fields
      .add(providerId)
      .then(() => refresh(context))
      .then(() => flows.start(provider, name, context));
  };
  const { records, fields } = sources;
  const routed = (providerId: string) => (providerId.startsWith(MCP_ACCOUNT) ? mcp : undefined);
  const adobe = providers.find((provider) => provider.id === ADOBE);
  const endpoint = adobe?.baseUrl ?? ADOBE_PROXY;
  const identity = (adobe?.headers as Record<string, string> | undefined) ?? adobeIdentity();
  const usage = options.usage ?? ((token: string) => adobeUsage(token, { endpoint, identity }));
  const every = options.every ?? BUDGET_EVERY;
  const grok = grokBudgets(records, options.grok ?? ((token: string) => xaiUsage(token)), {
    reach,
    every,
    now: options.now ?? Date.now,
  });
  const polled = providers.some((provider) => provider.id === XAI);
  const budgets = async () =>
    (await Promise.all([adobeBudget(records, usage), polled ? grok() : null])).filter(
      (found): found is BudgetState => found !== null
    );
  const snapshot = async (): Promise<SettingsState> => {
    const stored = new Set(
      providers
        .filter((provider) => records.model(provider.id) && fields.ready(provider.id))
        .map((provider) => provider.id)
    );
    const show = listed(records, fields);
    const shown = providers.filter((provider) => show(provider.id));
    const open = (list: Provider[]) => list.filter((provider) => !blocked(provider.id));
    const held = await budgets();
    return {
      models: choices(models, open(providers), stored),
      labels: labels(models, open(shown), stored),
      accounts: [...accounts(records, shown, fields, blocked), ...((await mcp?.accounts()) ?? [])],
      providers: offered(providers, blocked),
      budget: held[0] ?? null,
      budgets: held,
      ...(moved?.state.value?.length
        ? { moved: moved.state.value.map((name) => ({ ...name })) }
        : {}),
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
  if (signedIn.length || polled) {
    const cycle = () =>
      void (signedIn.length ? discover(signedIn) : Promise.resolve())
        .then(() => refresh(BACKGROUND_CONTEXT))
        .catch(() => undefined);
    cycle();
    const timer: unknown = setInterval(cycle, every);
    (timer as { unref?: () => void }).unref?.();
  }
  mcp?.onChange(() => void refresh(BACKGROUND_CONTEXT).catch(() => undefined));
  reach?.onChange(() => void refresh(BACKGROUND_CONTEXT).catch(() => undefined));
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
        await server.connect(providerId, secret);
        await refresh(context);
        return;
      }
      if (secret !== null)
        throw new Error(signIn.has(providerId) ? SIGN_IN_NEEDS_VAULT : KEY_NEEDS_VAULT);
      if (flows.has(providerId)) await flows.finish(providerId, context);
      if (given !== null) await fields.set(providerId, given);
      if (LISTINGS.has(providerId)) await fields.add(providerId);
      records.reconnected(providerId);
      await reread(context);
      if (signIn.has(providerId)) await discover([providerId]);
      await refresh(context);
    },
    async signIn(providerId, context) {
      const server = routed(providerId);
      if (server) return server.signIn(providerId);
      if (DEVICE_SIGN_INS.has(providerId)) return device(providerId, context);
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
      flows.stop(providerId);
      const server = routed(providerId);
      if (server) await server.disconnect(providerId);
      else if (LISTINGS.has(providerId)) await fields.add(providerId);
      else await fields.set(providerId, undefined);
      await reread(context);
      await refresh(context);
    },
    async serverUrl(providerId) {
      return (await routed(providerId)?.serverUrl(providerId)) ?? null;
    },
    addServer: async (name, entry) => (await mcp?.addServer(name, entry)) ?? NO_SERVERS,
    removeServer: async (id) => (await mcp?.removeServer(id)) ?? NO_SERVERS,
    refusals: async () => (await mcp?.refusals()) ?? {},
    async remove(providerId, context) {
      flows.stop(providerId);
      const server = routed(providerId);
      if (server) await server.disconnect(providerId);
      else await fields.forget(providerId);
      await reread(context);
      await refresh(context);
    },
  };
}
