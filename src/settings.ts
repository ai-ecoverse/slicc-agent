import {
  type Context,
  defineService,
  type ReplicatedState,
  replicatedState,
} from '@earendil-works/chord';
import type { CredentialStore, Provider } from '@earendil-works/pi-ai';
import { createModels, type MutableModels } from '@earendil-works/pi-ai/models';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

export const BEDROCK = 'amazon-bedrock';
export const DEFAULT_MODEL = { provider: BEDROCK, modelId: 'us.anthropic.claude-sonnet-5-5' };

export interface ModelChoice {
  id: string;
  label: string;
  provider: string;
  kind: 'chat' | 'classifier';
  reasoning: boolean;
  contextWindow: number;
}

export interface AccountState {
  id: string;
  provider: string;
  identity: string;
  status: 'connected' | 'disconnected';
  auth: 'api-key';
  needs: 'cors-free-transport' | null;
}

export interface SettingsState {
  models: ModelChoice[];
  accounts: AccountState[];
}

export interface AgentSettings {
  readonly state: ReplicatedState<SettingsState>;
  connect(
    providerId: string,
    secret: string,
    region: string | null,
    context: Context
  ): Promise<void>;
  disconnect(providerId: string, context: Context): Promise<void>;
}

export const AgentSettings = defineService<AgentSettings>('slicc.agent.settings');

const corsFree = new Set([BEDROCK]);

export function sliccProviders(): Provider[] {
  return [amazonBedrockProvider() as Provider];
}

export function createSliccModels(
  credentials: CredentialStore,
  providers = sliccProviders()
): MutableModels {
  const models = createModels({ credentials });
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
    identity: stored.has(provider.id) ? 'API key' : '',
    status: stored.has(provider.id) ? 'connected' : 'disconnected',
    auth: 'api-key',
    needs: corsFree.has(provider.id) ? 'cors-free-transport' : null,
  }));
}

export async function createAgentSettings(
  models: MutableModels,
  credentials: CredentialStore,
  providers = sliccProviders()
): Promise<AgentSettings> {
  const state = replicatedState<SettingsState>({
    models: choices(models, providers),
    accounts: await accounts(credentials, providers),
  });
  const refresh = async (context: Context) => {
    state.replace(context, {
      models: choices(models, providers),
      accounts: await accounts(credentials, providers),
    });
  };
  return {
    state,
    async connect(providerId, secret, region, context) {
      await credentials.modify(providerId, async () => ({
        type: 'api_key',
        key: secret,
        ...(region ? { env: { AWS_REGION: region } } : {}),
      }));
      await refresh(context);
    },
    async disconnect(providerId, context) {
      await credentials.delete(providerId);
      await refresh(context);
    },
  };
}
