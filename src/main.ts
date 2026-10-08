import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CredentialStore, Provider } from '@earendil-works/pi-ai';
import { createRegistry, type ModelRef, type Storage } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { openAgent } from './agent.ts';
import { EncryptedCredentialStore } from './credentials.ts';
import { type AgentHost, hostAgent } from './host.ts';
import type { KernelClient } from './kernel/client.ts';
import { HOME, kernelEnvironment } from './kernel/env.ts';
import { setupLicks } from './licks/index.ts';
import { type Transport, transportFetch } from './net.ts';
import { sliccPrompt } from './prompt.ts';
import {
  createAgentSettings,
  createSliccModels,
  DEFAULT_MODEL,
  sliccProviders,
} from './settings.ts';
import { openOpfsSqliteStorage } from './sqlite.ts';
import { agentVersion, commandsOnPath, kernelBoot, transportName } from './system.ts';
import { kernelPort, serveConnections, type WorkerScope } from './worker.ts';

export interface AgentWorkerScope extends WorkerScope {
  fetch: typeof fetch;
  location: { origin: string };
}

export type KernelAttach = (port: MessagePort) => Promise<KernelClient & { transport: Transport }>;

export interface AgentWorkerOptions {
  model?: ModelRef;
  providers?: Provider[];
  attach?: KernelAttach;
  credentials?: () => Promise<CredentialStore>;
  storage?: () => Promise<Storage>;
}

async function start(
  scope: AgentWorkerScope,
  port: Promise<MessagePort>,
  options: AgentWorkerOptions
): Promise<AgentHost> {
  const attach: KernelAttach = options.attach ?? attachKernel;
  const client = await attach(await port);
  const native = scope.fetch.bind(scope);
  scope.fetch = transportFetch(client.transport, scope.location.origin, native);
  const facts = {
    version: await agentVersion((url) => native(url)),
    commands: await commandsOnPath(client),
    transport: transportName(client.transport),
  };
  const credentials = await (options.credentials ?? (() => EncryptedCredentialStore.open()))();
  const providers = options.providers ?? sliccProviders();
  const models = createSliccModels(credentials, providers);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(sliccPrompt(facts));
  const licks = setupLicks(registry);
  const environment = kernelEnvironment(client);
  const agent = await openAgent({
    models,
    model: options.model ?? DEFAULT_MODEL,
    storage: await (options.storage ?? (() => openOpfsSqliteStorage()))(),
    registry,
    env: environment,
  });
  const sources = licks.attach(agent, { env: environment({ cwd: HOME }), home: HOME });
  await sources.start(BACKGROUND_CONTEXT);
  await sources.boot(
    { version: facts.version, boot: await kernelBoot(client) },
    BACKGROUND_CONTEXT
  );
  return hostAgent(agent, {
    settings: await createAgentSettings(models, credentials, providers),
    licks: { licks: licks.licks, sources },
  });
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
