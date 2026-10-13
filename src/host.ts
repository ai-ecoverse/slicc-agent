import {
  type Context,
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  type ReplicatedState,
  replicatedState,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import {
  type RoutedServerServiceHost,
  type RoutedSessionAttachment,
  type RoutedSessionHandle,
  Server,
  type ServerHost,
  SessionNotFoundError,
} from '@earendil-works/pi-server';
import type { Agent } from './agent.ts';
import type { ChangesView } from './changes/git.ts';
import type { ChangesRuntime } from './changes/index.ts';
import { createAgentControl, type HostLicks, type HostScoops } from './control.ts';
import { trackDeliveries } from './deliveries.ts';
import type { FreezerRuntime, FrozenCone } from './freezer/index.ts';
import type { UserClients } from './kernel/users.ts';
import { PortListener } from './listener.ts';
import type { McpRuntime } from './mcp/index.ts';
import type { MemoryEntry, MemoryScope } from './memory/format.ts';
import type { MemoryRuntime } from './memory/index.ts';
import { createMonitor, type MonitorOptions } from './monitor/index.ts';
import { viewControl, viewPages, viewRemote, viewSettings } from './readonly.ts';
import { createRemote } from './remote/host.ts';
import { type AgentPages, createPages, ownedPages, type Pages } from './remote/pages.ts';
import type { SecretName } from './secrets/names.ts';
import type { VaultState } from './secrets/vault.ts';
import {
  AGENT_SESSION,
  AgentControl,
  AgentPagesService,
  AgentRemoteService,
  AgentSessions,
  AgentSettings,
  AgentTranscript,
  type Command,
} from './services.ts';
import type { SkillsRuntime } from './skills/index.ts';
import type { SprinklesRuntime } from './sprinkles/index.ts';
import type { Sprinkle } from './sprinkles/kind.ts';
import { slimmer, type Thumbnail, thumbnail } from './thumbs.ts';
import type { Uploads } from './uploads.ts';
import { agentViews } from './views.ts';
import type { PortEndpoint } from './wire.ts';

export interface ConnectOptions {
  readOnly?: boolean;
  pages?: boolean;
}

export interface AgentHost {
  readonly serverId: string;
  readonly agent: Agent;
  readonly users?: UserClients;
  readonly pages: Pages;
  connect(endpoint: PortEndpoint, options?: ConnectOptions): void;
  close(): Promise<void>;
}

function endpointFor(provider: RemoteServiceProvider): RoutedSessionAttachment {
  const endpoint = createRemoteServiceEndpoint(provider);
  return {
    invokeService: (call, publish, context) =>
      endpoint.invoke(call, (id, update) => publish(id, update, context), context),
    release: () => endpoint.dispose(),
  };
}

type Attached = { provider: RemoteServiceProvider; release(): void };

function sessionServices(attach: () => Attached): RoutedSessionHandle {
  return {
    attachClient() {
      const attached = attach();
      const endpoint = endpointFor(attached.provider);
      return {
        invokeService: endpoint.invokeService,
        release(context) {
          endpoint.release(context);
          attached.release();
        },
      };
    },
    close: async () => {},
  };
}

function serverServices(): RoutedServerServiceHost {
  return {
    attachClient(presentation) {
      const provider = new RemoteServiceProvider([{ service: AgentSessions, mode: 'singleton' }]);
      provider.provide(AgentSessions, {
        attach: (sessionId, context) => presentation.attachSession(sessionId, context),
        detach: (context) => presentation.detachSession(context),
      });
      const attachment = endpointFor(provider);
      return {
        invokeService: attachment.invokeService,
        release(context) {
          attachment.release(context);
          provider.dispose();
        },
      };
    },
  };
}

const noSettings: AgentSettings = {
  state: replicatedState({ models: [], accounts: [] }),
  connect: async () => {
    throw new Error('this agent has no accounts');
  },
  disconnect: async () => {},
  signIn: async () => null,
};

async function follow(
  agent: Agent,
  context: Context,
  slim: (view: ConversationView) => ConversationView
) {
  let attached = await agent.cone().viewState(context);
  const state = replicatedState<ConversationView>(slim(attached.value));
  const mirror = (value: ConversationView, from: Context) => state.replace(from, slim(value));
  let off = attached.subscribe(mirror);
  const stop = agent.onCone(async (conversation) => {
    const next = await conversation.viewState(context);
    off();
    attached.dispose();
    attached = next;
    state.replace(context, slim(next.value));
    off = next.subscribe(mirror);
  });
  return {
    state,
    refresh: () => state.replace(context, slim(attached.value)),
    dispose() {
      stop();
      off();
      attached.dispose();
    },
  };
}

export interface HostSecrets {
  vault: ReplicatedState<VaultState>;
  list(): readonly SecretName[];
  close?(): void;
}

const idleVault = replicatedState<VaultState>({
  port: 'none',
  needed: false,
  version: 0,
  locked: 'no',
  held: 0,
});

export async function hostAgent(
  agent: Agent,
  options: {
    serverId?: string;
    context?: Context;
    settings?: AgentSettings;
    licks?: HostLicks;
    scoops?: HostScoops;
    skills?: SkillsRuntime;
    sprinkles?: SprinklesRuntime;
    memory?: MemoryRuntime;
    freezer?: FreezerRuntime;
    changes?: ChangesRuntime;
    mcp?: Pick<McpRuntime, 'close'>;
    users?: UserClients;
    monitor?: Pick<MonitorOptions, 'kernel' | 'groups' | 'users' | 'secrets'>;
    pages?: Pages;
    secrets?: HostSecrets;
    uploads?: Uploads;
    thumbnail?: Thumbnail;
  } = {}
): Promise<AgentHost> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const serverId = options.serverId ?? crypto.randomUUID();
  let refresh = () => {};
  const slims = slimmer(options.thumbnail ?? thumbnail, () => refresh());
  const transcript = await follow(agent, context, slims.slim);
  const { state } = transcript;
  const mounted = await agentViews(agent, context, slims.slim);
  refresh = () => {
    transcript.refresh();
    mounted.refresh();
  };
  const touch = () => options.freezer?.touch();
  const untouch = [state.subscribe(touch), mounted.views.subscribe(touch)];
  const catalogue = () =>
    new RemoteServiceProvider([
      { service: AgentControl, mode: 'singleton' },
      { service: AgentTranscript, mode: 'singleton' },
      { service: AgentSettings, mode: 'singleton' },
      { service: AgentRemoteService, mode: 'singleton' },
      { service: AgentPagesService, mode: 'singleton' },
    ]);
  const pages = options.pages ?? createPages();
  const deliveries = trackDeliveries(agent.harness, state, context);
  const monitor = createMonitor({
    ...options.monitor,
    harness: agent.harness,
    agents: agent.agents,
    views: mounted.views,
    context,
  });
  const control = createAgentControl(
    agent.harness,
    agent,
    deliveries,
    options.licks,
    options.scoops,
    options.skills,
    options.sprinkles,
    options.memory,
    options.freezer,
    options.changes,
    monitor,
    options.secrets?.list,
    options.uploads
  );
  const remote = createRemote({
    harness: agent.harness,
    send: (request, using) => control.send(request, using),
    vault: options.secrets?.vault ?? idleVault,
    async conversation(agentId, using) {
      if (!agentId) return agent.cone();
      const found = await agent.agents.conversation(agentId, using);
      if (!found) throw new Error(`There is no agent ${agentId}.`);
      return found;
    },
  });
  const transcriptService = {
    state,
    deliveries: deliveries.state,
    agents: mounted.agents,
    views: mounted.views,
    commands: options.skills?.commands ?? replicatedState<Command[]>([]),
    sprinkles: options.sprinkles?.sprinkles ?? replicatedState<Sprinkle[]>([]),
    memories: options.memory?.memories ?? replicatedState<MemoryEntry[]>([]),
    memoryScopes: options.memory?.scopes ?? replicatedState<MemoryScope[]>([]),
    frozen: options.freezer?.frozen ?? replicatedState<FrozenCone[]>([]),
    changes:
      options.changes?.view ?? replicatedState<ChangesView>({ unavailable: null, changes: [] }),
    monitor: monitor.state,
    vault: options.secrets?.vault ?? idleVault,
  };
  const settings = options.settings ?? noSettings;
  const visible = (entry: number) =>
    [state.value, ...Object.values(mounted.views.value)].some((view) =>
      view.entries.some((item) => item.id === entry)
    );
  const gated =
    (allowed: (entry: number) => boolean): AgentControl['image'] =>
    async (ref, using) =>
      allowed(ref.entry) ? control.image(ref, using) : { data: null, mimeType: null };
  const trusted: AgentControl = { ...control, image: gated(slims.shown) };
  const viewed: AgentControl = { ...control, image: gated(visible) };
  const served = (served: AgentPages) => {
    const made = catalogue();
    made.provide(AgentControl, trusted);
    made.provide(AgentTranscript, transcriptService);
    made.provide(AgentSettings, settings);
    made.provide(AgentRemoteService, remote);
    made.provide(AgentPagesService, served);
    return made;
  };
  const owned = (): Attached => {
    const mine = ownedPages(pages);
    const made = served(mine);
    return {
      provider: made,
      release() {
        made.dispose();
        mine.release();
      },
    };
  };
  const follower = served(viewPages());
  const viewer = catalogue();
  viewer.provide(AgentControl, viewControl(viewed));
  viewer.provide(AgentTranscript, { ...transcriptService, monitor: monitor.viewState });
  viewer.provide(AgentSettings, viewSettings(settings));
  viewer.provide(AgentRemoteService, viewRemote(remote));
  viewer.provide(AgentPagesService, viewPages());
  const shared = (services: RemoteServiceProvider) => () => ({
    provider: services,
    release: () => undefined,
  });
  const serve = async (id: string, attach: () => Attached) => {
    const host: ServerHost = {
      serverServices: serverServices(),
      async resolveSession(sessionId) {
        if (sessionId !== AGENT_SESSION)
          throw new SessionNotFoundError(`unknown session ${sessionId}`);
        return { id: sessionId };
      },
      openSession: async () => sessionServices(attach),
    };
    const listener = new PortListener(id);
    const server = await new Server(host, { serverId: id, listeners: [listener] }).start();
    return { listener, server };
  };
  const full = await serve(serverId, owned);
  const view = await serve(crypto.randomUUID(), shared(viewer));
  const linked = await serve(crypto.randomUUID(), shared(follower));
  return {
    serverId,
    agent,
    pages,
    ...(options.users ? { users: options.users } : {}),
    connect(endpoint, connectOptions) {
      const chosen = connectOptions?.readOnly
        ? view
        : connectOptions?.pages === false
          ? linked
          : full;
      chosen.listener.connect(endpoint);
    },
    async close() {
      await full.server.close();
      await view.server.close();
      await linked.server.close();
      viewer.dispose();
      follower.dispose();
      await pages.dispose();
      await monitor.dispose();
      await remote.dispose();
      deliveries.dispose();
      transcript.dispose();
      mounted.dispose();
      slims.dispose();
      for (const off of untouch) off();
      options.freezer?.close();
      options.secrets?.close?.();
      await options.changes?.close(context);
      await options.memory?.close(context);
      await options.sprinkles?.close(context);
      await options.skills?.close(context);
      await options.mcp?.close(context);
      await options.scoops?.runtime.close(context);
      await options.licks?.sources.close(context);
      await agent.close();
      await options.users?.close();
    },
  };
}
