import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import type { CredentialStore, Provider } from '@earendil-works/pi-ai';
import { createRegistry, type ModelRef, type Storage } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { openAgent } from './agent.ts';
import { EncryptedCredentialStore } from './credentials.ts';
import { type AgentHost, hostAgent } from './host.ts';
import { kernelEnvironment } from './kernel/env.ts';
import { transportFetch } from './net.ts';
import { SliccPrompt } from './prompt.ts';
import {
  createAgentSettings,
  createSliccModels,
  DEFAULT_MODEL,
  sliccProviders,
} from './settings.ts';
import { openOpfsSqliteStorage } from './sqlite.ts';
import { kernelPort, serveConnections, type WorkerScope } from './worker.ts';

export interface AgentWorkerScope extends WorkerScope {
  fetch: typeof fetch;
  location: { origin: string };
}

export interface AgentWorkerOptions {
  model?: ModelRef;
  providers?: Provider[];
  attach?: typeof attachKernel;
  credentials?: () => Promise<CredentialStore>;
  storage?: () => Promise<Storage>;
}

async function start(
  scope: AgentWorkerScope,
  port: Promise<MessagePort>,
  options: AgentWorkerOptions
): Promise<AgentHost> {
  const client = await (options.attach ?? attachKernel)(await port);
  scope.fetch = transportFetch(client.transport, scope.location.origin, scope.fetch.bind(scope));
  const credentials = await (options.credentials ?? (() => EncryptedCredentialStore.open()))();
  const providers = options.providers ?? sliccProviders();
  const models = createSliccModels(credentials, providers);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(SliccPrompt);
  const agent = await openAgent({
    models,
    model: options.model ?? DEFAULT_MODEL,
    storage: await (options.storage ?? (() => openOpfsSqliteStorage()))(),
    registry,
    env: kernelEnvironment(client),
  });
  return hostAgent(agent, { settings: await createAgentSettings(models, credentials, providers) });
}

export function runAgentWorker(
  scope: AgentWorkerScope,
  options: AgentWorkerOptions = {}
): Promise<AgentHost> {
  const host = start(scope, kernelPort(scope), options);
  host.catch(() => undefined);
  serveConnections(scope, host);
  return host;
}
