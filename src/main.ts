import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { CredentialStore, Provider } from '@earendil-works/pi-ai';
import {
  createRegistry,
  type ModelRef,
  type Storage,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { type Agent, openAgent } from './agent.ts';
import { attachChanges, CHANGES_MS } from './changes/index.ts';
import {
  codemodeExtension,
  codemodeTool,
  disabledBySettings,
  locateWasm,
  sandboxFactory,
} from './codemode/index.ts';
import { EncryptedCredentialStore } from './credentials.ts';
import { attachFreezer } from './freezer/index.ts';
import { settingsText, titler } from './freezer/title.ts';
import { lateGelatiere } from './gelatiere/index.ts';
import { type AgentHost, hostAgent } from './host.ts';
import { imageReads } from './images/index.ts';
import { createActivity } from './kernel/activity.ts';
import type { KernelClient } from './kernel/client.ts';
import { HOME, kernelEnvironment, SliccKernelEnv } from './kernel/env.ts';
import { processGroups } from './kernel/groups.ts';
import { adminOver, type UserClient, type UserClients, userClients } from './kernel/users.ts';
import { setupLicks } from './licks/index.ts';
import { setupMcp } from './mcp/index.ts';
import { setupMemory } from './memory/index.ts';
import { modelsCommand } from './models/index.ts';
import { type Transport, transportFetch } from './net.ts';
import { sliccPrompt } from './prompt.ts';
import { identity } from './scoops/identity.ts';
import { type Assets, packageAssets, type ScoopsRuntime, setupScoops } from './scoops/index.ts';
import {
  createAgentSettings,
  createSliccModels,
  DEFAULT_MODEL,
  sliccProviders,
} from './settings.ts';
import { RELOAD_MS, setupSkills } from './skills/index.ts';
import { setupSprinkles } from './sprinkles/index.ts';
import { openOpfsSqliteStorage } from './sqlite.ts';
import {
  agentVersion,
  browserConnected,
  commandsOnPath,
  kernelBoot,
  transportName,
} from './system.ts';
import { type KernelPorts, kernelPorts, serveConnections, type WorkerScope } from './worker.ts';

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
  assets?: Assets;
  codemodeWasm?: () => Promise<WebAssembly.Module | undefined>;
  codemodeWorker?: string | URL;
  catalog?: string;
  users?: boolean;
}

export function usersOf(
  admin: MessagePort | undefined,
  wanted: boolean | undefined,
  attach: KernelAttach
): UserClients | undefined {
  if (!admin) return undefined;
  if (wanted === false) {
    admin.close();
    return undefined;
  }
  return userClients(adminOver(admin), attach as (port: MessagePort) => Promise<UserClient>);
}

export const STORE_DIR = '/.slicc';

async function attached(ports: Promise<KernelPorts>, options: AgentWorkerOptions) {
  const attach: KernelAttach = options.attach ?? attachKernel;
  const { kernel, admin } = await ports;
  const client = await attach(kernel);
  return { client, users: usersOf(admin, options.users, attach) };
}

function privateStore(env: SliccKernelEnv): Promise<unknown> {
  return env.exec(`test -d ${STORE_DIR} && chmod 700 ${STORE_DIR}`, undefined, BACKGROUND_CONTEXT);
}

async function codemodeTools(
  client: KernelClient,
  options: AgentWorkerOptions,
  native: typeof fetch,
  extra: Parameters<typeof codemodeTool>[0]['extra']
) {
  const settings = await client.fs
    .readFile(`${HOME}/.pi/agent/settings.json`)
    .catch(() => undefined);
  if (disabledBySettings(settings === undefined ? undefined : new TextDecoder().decode(settings)))
    return [];
  const sandbox = sandboxFactory(
    options.codemodeWasm ?? (() => locateWasm(native, new URL(import.meta.url))),
    options.codemodeWorker
  );
  return [
    codemodeTool({ declared: CodingTools.tools as readonly ToolRegistration[], sandbox, extra }),
  ];
}

async function start(
  scope: AgentWorkerScope,
  ports: Promise<KernelPorts>,
  options: AgentWorkerOptions
): Promise<AgentHost> {
  const { client, users } = await attached(ports, options);
  const native = scope.fetch.bind(scope);
  scope.fetch = transportFetch(client.transport, scope.location.origin, native);
  const facts = {
    version: await agentVersion((url) => native(url)),
    commands: await commandsOnPath(client),
    transport: transportName(client.transport),
    browser: await browserConnected(client),
  };
  const credentials = await (options.credentials ?? (() => EncryptedCredentialStore.open()))();
  const providers = options.providers ?? sliccProviders();
  const models = createSliccModels(credentials, providers);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(sliccPrompt(facts));
  registry.install(
    imageReads(
      (CodingTools.tools as readonly ToolRegistration[]).find(
        (tool) => tool.name === 'read'
      ) as ToolRegistration
    )
  );
  const memory = setupMemory(registry);
  const coding = CodingTools.tools as readonly ToolRegistration[];
  const mcp = setupMcp(registry);
  const codemode = await codemodeTools(client, options, native, mcp.codemode);
  registry.install(codemodeExtension(codemode));
  const licks = setupLicks(registry);
  const scoops = setupScoops(registry, licks.licks, [...coding, ...codemode, ...memory.tools]);
  const skills = setupSkills(registry, licks.licks);
  const activity = createActivity();
  const groups = processGroups(client);
  const model = options.model ?? DEFAULT_MODEL;
  let opened: Agent | undefined;
  const environment = kernelEnvironment(client, {
    activity,
    groups,
    identify: identity(() => opened?.agents, model),
  });
  const agent = await openAgent({
    models,
    model,
    storage: await (options.storage ?? (() => openOpfsSqliteStorage()))(),
    registry,
    env: environment,
  });
  opened = agent;
  const home = new SliccKernelEnv(client, { cwd: HOME });
  await privateStore(home);
  const sources = licks.attach(agent, { env: home, home: HOME, activity });
  await sources.start(BACKGROUND_CONTEXT);
  await sources.boot(
    { version: facts.version, boot: await kernelBoot(client) },
    BACKGROUND_CONTEXT
  );
  const skillsRuntime = await skills.attach(
    { env: home, home: HOME, assets: options.assets ?? packageAssets(), reloadMs: RELOAD_MS },
    BACKGROUND_CONTEXT
  );
  const mcpRuntime = await mcp.attach(
    {
      env: home,
      home: HOME,
      credentials,
      licks: licks.licks,
      fetch: scope.fetch,
      version: facts.version,
      reloadMs: RELOAD_MS,
      codemode: codemode.length > 0,
      cors: client.transport.traits?.crossOrigin === 'cors',
    },
    BACKGROUND_CONTEXT
  );
  const gelatiere = lateGelatiere();
  const sprinkles = await setupSprinkles().attach(
    {
      intercept: gelatiere.intercept,
      harness: agent.harness,
      agents: agent.agents,
      licks: licks.licks,
      env: home,
      assets: options.assets ?? packageAssets(),
      reloadMs: RELOAD_MS,
    },
    BACKGROUND_CONTEXT
  );
  let roles: ScoopsRuntime | undefined;
  const memoryRuntime = await memory.attach(
    {
      harness: agent.harness,
      agents: agent.agents,
      env: home,
      home: HOME,
      reloadMs: RELOAD_MS,
      roles: async (using) => roles?.roles(using),
    },
    BACKGROUND_CONTEXT
  );
  const freezer = attachFreezer({
    harness: agent.harness,
    agents: agent.agents,
    env: home,
    extract: memory.extract,
    title: titler(models, settingsText(home, HOME)),
  });
  licks.licks.guard(freezer.frozenTarget);
  const settings = await createAgentSettings(models, credentials, providers, { mcp: mcpRuntime });
  const runtime = await scoops.attach(
    {
      harness: agent.harness,
      agents: agent.agents,
      groups,
      env: home,
      home: HOME,
      alive: alive(client),
      reads: skillsRuntime.dirs,
      sprinkle: sprinkles.command,
      memory: memoryRuntime.command,
      gelatiere: gelatiere.command,
      freezer: freezer.command,
      models: modelsCommand({ agents: agent.agents, settings, catalog: models }),
      mcp: mcp.direct,
      ...(options.assets ? { assets: options.assets } : {}),
    },
    BACKGROUND_CONTEXT
  );
  roles = runtime;
  gelatiere.attach({
    agents: agent.agents,
    licks: licks.licks,
    env: home,
    home: HOME,
    scoops: scoops.scoops,
    roles: runtime.roles,
    assets: options.assets ?? packageAssets(),
    fetch: scope.fetch,
    skills: skillsRuntime.skills,
    ...(options.catalog ? { catalog: options.catalog } : {}),
  });
  await memoryRuntime.reload(BACKGROUND_CONTEXT).catch(() => undefined);
  const changes = attachChanges({ agents: agent.agents, env: home, reloadMs: CHANGES_MS });
  return hostAgent(agent, {
    settings,
    licks: { licks: licks.licks, sources },
    scoops: { scoops: scoops.scoops, runtime },
    skills: skillsRuntime,
    sprinkles,
    memory: memoryRuntime,
    freezer,
    changes,
    mcp: mcpRuntime,
    ...(users ? { users } : {}),
  });
}

export function alive(client: KernelClient) {
  return async (pid: number): Promise<boolean> => {
    if (!client.ps) return true;
    return (await client.ps()).some((process) => process.pid === pid);
  };
}

export function runAgentWorker(
  scope: AgentWorkerScope,
  options: AgentWorkerOptions = {}
): Promise<AgentHost> {
  const host = start(scope, kernelPorts(scope), options);
  host.catch(() => undefined);
  serveConnections(scope, host);
  return host;
}
