import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Provider } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import {
  createRegistry,
  type ModelRef,
  type Storage,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { type Agent, type AgentOptions, openAgent } from './agent.ts';
import { browserGuard } from './browser/guard.ts';
import { attachChanges, CHANGES_MS } from './changes/index.ts';
import {
  codemodeExtension,
  codemodeTool,
  disabledBySettings,
  locateWasm,
  sandboxFactory,
} from './codemode/index.ts';
import { attachFreezer } from './freezer/index.ts';
import { lateGelatiere } from './gelatiere/index.ts';
import { type AgentHost, hostAgent } from './host.ts';
import { imageReads } from './images/index.ts';
import { createActivity } from './kernel/activity.ts';
import { agentUsers, warnSupport } from './kernel/agent-users.ts';
import type { KernelClient } from './kernel/client.ts';
import { HOME, kernelEnvironment, SliccKernelEnv } from './kernel/env.ts';
import { processGroups } from './kernel/groups.ts';
import { adminOver, type UserClient, type UserClients, userClients } from './kernel/users.ts';
import { AGENT_DIR, ROOT_HOME } from './layout.ts';
import { setupLicks } from './licks/index.ts';
import { lickTriage } from './licks/triage.ts';
import { type McpAccounts, setupMcp } from './mcp/index.ts';
import { setupMemory } from './memory/index.ts';
import { modelsCommand } from './models/index.ts';
import { pageOnly, type Transport, transportFetch } from './net.ts';
import { sliccPrompt } from './prompt.ts';
import { createPages } from './remote/pages.ts';
import { identity } from './scoops/identity.ts';
import { type Assets, packageAssets, type ScoopsRuntime, setupScoops } from './scoops/index.ts';
import { vaultCredentials } from './secrets/credentials.ts';
import {
  BEDROCK_ENDPOINTS,
  type ModelBases,
  modelRoute,
  vaultEndpoints,
} from './secrets/endpoints.ts';
import { repin, secretsExtension, shellGrants } from './secrets/extension.ts';
import { grantFetch, mcpFetch, vaultFetch } from './secrets/fetch.ts';
import { secretNames } from './secrets/names.ts';
import { type VaultRecords, vaultRecords } from './secrets/records.ts';
import { scrubWith } from './secrets/scrub.ts';
import { fileStore, type PlainStore } from './secrets/store.ts';
import { listenVault, Vault } from './secrets/vault.ts';
import {
  BEDROCK,
  createAgentSettings,
  createSliccModels,
  DEFAULT_MODEL,
  providerFields,
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
import { titlesExtension } from './titles/extension.ts';
import { settingsText, titler } from './titles/generate.ts';
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
  store?: () => Promise<PlainStore>;
  storage?: () => Promise<Storage>;
  assets?: Assets;
  codemodeWasm?: () => Promise<WebAssembly.Module | undefined>;
  codemodeWorker?: string | URL;
  catalog?: string;
  users?: boolean;
  mcpRedirect?: string;
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
export const ACCOUNTS_FILE = `${STORE_DIR}/accounts.json`;

async function attached(ports: Promise<KernelPorts>, options: AgentWorkerOptions) {
  const attach: KernelAttach = options.attach ?? attachKernel;
  const { kernel, admin } = await ports;
  const client = await attach(kernel);
  const users = usersOf(admin, options.users, attach);
  await warnSupport(users, client, options.users);
  const home = new SliccKernelEnv(client, { cwd: HOME });
  await privateStore(home);
  return { client, users, home, at: { home: HOME, ...(users ? { agentDir: AGENT_DIR } : {}) } };
}

function privateStore(env: SliccKernelEnv): Promise<unknown> {
  return env.exec(`mkdir -p ${STORE_DIR} && chmod 700 ${STORE_DIR}`, undefined, BACKGROUND_CONTEXT);
}

async function codemodeTools(
  client: KernelClient,
  options: AgentWorkerOptions,
  native: typeof fetch,
  extra: Parameters<typeof codemodeTool>[0]['extra'],
  dir = `${HOME}/.pi/agent`
) {
  const settings = await client.fs.readFile(`${dir}/settings.json`).catch(() => undefined);
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

export function seesImages(models: Pick<Models, 'getModel'>, ref: ModelRef | undefined): boolean {
  const found = ref && models.getModel(ref.provider, ref.modelId);
  return found ? found.input.includes('image') : true;
}

export const MCP_CALLBACK = '/oauth/mcp-callback';

async function openRepinned(
  options: AgentWorkerOptions,
  base: Omit<AgentOptions, 'storage' | 'beforeResume'>
): Promise<Agent> {
  const storage = await (options.storage ?? (() => openOpfsSqliteStorage()))();
  return openAgent({
    ...base,
    storage,
    beforeResume: (harness, using) => repin(harness, storage, using),
  });
}

async function secretsFor(home: SliccKernelEnv, vault: Vault) {
  scrubWith(vault);
  const names = secretNames(home, vault);
  await names.refresh(BACKGROUND_CONTEXT);
  return names;
}

export function modelBases(
  providers: readonly Provider[],
  models: Pick<ReturnType<typeof createSliccModels>, 'getModels'>
): ModelBases[] {
  return providers.map((provider) => ({
    provider: provider.id,
    urls: [
      ...new Set(
        [
          provider.baseUrl,
          ...models.getModels(provider.id).map((model) => model.baseUrl),
          ...(provider.id === BEDROCK ? BEDROCK_ENDPOINTS : []),
        ].filter((url): url is string => typeof url === 'string' && url !== '')
      ),
    ],
  }));
}

function mcpVault(
  vault: Vault,
  made: { store: PlainStore; records: VaultRecords; endpoints: ReturnType<typeof vaultEndpoints> }
) {
  const { store, records, endpoints } = made;
  return {
    store,
    vault: {
      records,
      fetch: (server: string, base: typeof fetch) => mcpFetch(vault, base, server),
      grant: (server: string, base: typeof fetch) => grantFetch(vault, server, base),
      servers: endpoints.servers,
      token: endpoints.token,
    },
  };
}

function hostSecrets(
  vault: Vault,
  names: Awaited<ReturnType<typeof secretsFor>>,
  parts: readonly { close(): void }[]
) {
  return {
    vault: vault.state,
    list: () => names.state.value,
    close: () => {
      for (const part of parts) part.close();
    },
  };
}

async function modelsOf(
  scope: AgentWorkerScope,
  options: AgentWorkerOptions,
  given: { vault: Vault; home: SliccKernelEnv; transport: typeof fetch; version: string }
) {
  const { vault, home, transport, version } = given;
  const store = await (options.store ?? (async () => fileStore(home, ACCOUNTS_FILE)))();
  const records = vaultRecords(vault);
  void records.refresh(BACKGROUND_CONTEXT).catch(() => undefined);
  const providers = options.providers ?? sliccProviders(version);
  const fields = await providerFields(store, providers);
  const models = createSliccModels(vaultCredentials(records, fields.env), providers);
  const bases = () => modelBases(providers, models);
  scope.fetch = vaultFetch(
    vault,
    transport,
    modelRoute(bases, () => records.state.value)
  );
  const endpoints = vaultEndpoints(vault);
  void endpoints.models(bases()).catch(() => undefined);
  return { store, records, providers, fields, models, bases, endpoints };
}

function baseRegistry(facts: Awaited<ReturnType<typeof factsOf>>) {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(sliccPrompt(facts));
  const read = (CodingTools.tools as readonly ToolRegistration[]).find(
    (tool) => tool.name === 'read'
  ) as ToolRegistration;
  registry.install(imageReads(read));
  return registry;
}

async function factsOf(client: KernelClient & { transport: Transport }, native: typeof fetch) {
  return {
    version: await agentVersion((url) => native(url)),
    commands: await commandsOnPath(client),
    transport: transportName(client.transport),
    browser: await browserConnected(client),
  };
}

function routeFetch(scope: AgentWorkerScope, client: KernelClient & { transport: Transport }) {
  const native = scope.fetch.bind(scope);
  const loopback = client.loopbackFetch?.bind(client);
  const transport = transportFetch(client.transport, scope.location.origin, native, loopback);
  scope.fetch = transport;
  return { native, transport };
}

async function prepare(
  scope: AgentWorkerScope,
  kernel: { client: KernelClient & { transport: Transport }; home: SliccKernelEnv; vault: Vault },
  options: AgentWorkerOptions
) {
  const names = await secretsFor(kernel.home, kernel.vault);
  const { native, transport } = routeFetch(scope, kernel.client);
  const facts = await factsOf(kernel.client, native);
  const made = await modelsOf(scope, options, {
    vault: kernel.vault,
    home: kernel.home,
    transport,
    version: facts.version,
  });
  return { names, native, transport, facts, ...made, registry: baseRegistry(facts) };
}

function modelsOfAgent(
  agent: Agent,
  settings: Awaited<ReturnType<typeof createAgentSettings>>,
  catalog: Models,
  vault: Vault
) {
  const locked = () => vault.state.value.locked !== 'no';
  return modelsCommand({ agents: agent.agents, settings, catalog, locked });
}

async function settingsOf(made: Awaited<ReturnType<typeof modelsOf>>, mcp: McpAccounts) {
  const { models, records, fields, providers, bases, endpoints } = made;
  const settings = await createAgentSettings(models, { records, fields }, providers, { mcp });
  settings.state.subscribe(() => void endpoints.models(bases()).catch(() => undefined));
  return settings;
}

function setupTitles(
  registry: ReturnType<typeof createRegistry>,
  models: Models,
  home: SliccKernelEnv,
  at: { home: string; agentDir?: string },
  opened: () => Agent | undefined
) {
  const titleFn = titler(models, settingsText(home, HOME, at.agentDir));
  const titles = titlesExtension({
    agents: () => opened()?.agents,
    harness: () => opened()?.harness,
    title: titleFn,
  });
  registry.install(titles.extension);
  return { titleFn, cancel: titles.cancel };
}

async function start(
  scope: AgentWorkerScope,
  ports: Promise<KernelPorts>,
  options: AgentWorkerOptions,
  vault: Vault
): Promise<AgentHost> {
  const { client, users, home, at } = await attached(ports, options);
  const ready = await prepare(scope, { client, home, vault }, options);
  const { names, native, transport, facts, models, registry } = ready;
  const { records, endpoints } = ready;
  const memory = setupMemory(registry);
  const coding = CodingTools.tools as readonly ToolRegistration[];
  registry.install(browserGuard([scope.location.origin], coding));
  const mcp = setupMcp(registry);
  const codemode = await codemodeTools(client, options, native, mcp.codemode, at.agentDir);
  registry.install(codemodeExtension(codemode));
  const licks = setupLicks(registry);
  licks.licks.triage(lickTriage(models));
  const scoops = setupScoops(registry, licks.licks, [...coding, ...codemode, ...memory.tools]);
  const skills = setupSkills(registry, licks.licks);
  registry.install(secretsExtension({ names, vault }));
  const titles = setupTitles(registry, models, home, at, () => opened);
  const [activity, groups] = [createActivity(), processGroups(client)];
  const model = options.model ?? DEFAULT_MODEL;
  let opened: Agent | undefined;
  const people = users ? agentUsers(users, client, home, () => opened?.agents) : undefined;
  const environment = kernelEnvironment(client, {
    activity,
    groups,
    identify: identity(() => opened?.agents, model),
    scrub: vault,
    spawn: shellGrants(names),
    ...(people ? { route: people.route } : {}),
  });
  const agent = await openRepinned(options, { models, model, registry, env: environment });
  opened = agent;
  await people?.start(agent.agents);
  const sources = licks.attach(agent, {
    env: home,
    home: HOME,
    activity,
    ...(people ? { dirs: () => people.lickDirs() } : {}),
  });
  await sources.start(BACKGROUND_CONTEXT);
  await sources.boot(
    { version: facts.version, boot: await kernelBoot(client) },
    BACKGROUND_CONTEXT
  );
  const skillsRuntime = await skills.attach(
    {
      env: home,
      ...at,
      assets: options.assets ?? packageAssets(),
      reloadMs: RELOAD_MS,
      ...(people ? { people: people.people } : {}),
    },
    BACKGROUND_CONTEXT
  );
  const mcpRuntime = await mcp.attach(
    {
      env: home,
      ...at,
      ...mcpVault(vault, ready),
      licks: licks.licks,
      fetch: transport,
      version: facts.version,
      reloadMs: RELOAD_MS,
      codemode: codemode.length > 0,
      cors: pageOnly(client.transport),
      redirect: options.mcpRedirect ?? new URL(MCP_CALLBACK, scope.location.origin).href,
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
      ...(people?.sprinkles() ?? {}),
    },
    BACKGROUND_CONTEXT
  );
  people?.follow([sources, skillsRuntime, sprinkles]);
  let roles: ScoopsRuntime | undefined;
  const memoryRuntime = await memory.attach(
    {
      harness: agent.harness,
      agents: agent.agents,
      env: home,
      ...at,
      ...(people ? { home: ROOT_HOME } : {}),
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
    title: titles.titleFn,
    cancelTitle: titles.cancel,
    ...(people ? { layout: people.layout } : {}),
  });
  licks.licks.guard(freezer.frozenTarget);
  const settings = await settingsOf(ready, mcpRuntime);
  const pages = createPages({ claim: sprinkles.claim });
  const runtime = await scoops.attach(
    {
      harness: agent.harness,
      agents: agent.agents,
      groups,
      env: home,
      ...at,
      ...(people
        ? { layout: people.layout, spools: people.spools, enforced: people.enforced }
        : {}),
      alive: alive(client),
      reads: skillsRuntime.dirs,
      memory: memoryRuntime.command,
      gelatiere: gelatiere.command,
      freezer: freezer.command,
      models: modelsOfAgent(agent, settings, models, vault),
      panel: pages.command,
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
    ...(await people?.gelatiere(home)),
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
    pages,
    mcp: mcpRuntime,
    ...(users ? { users } : {}),
    secrets: hostSecrets(vault, names, [names, records, endpoints]),
    uploads: {
      env: environment,
      sees: (ref) => seesImages(models, ref),
    },
    monitor: {
      kernel: client,
      groups,
      ...(users ? { users: () => users.users.list() } : {}),
    },
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
  const vault = new Vault();
  listenVault(scope, vault);
  const host = start(scope, kernelPorts(scope), options, vault);
  host.catch(() => undefined);
  serveConnections(scope, host);
  return host;
}
