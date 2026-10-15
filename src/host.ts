import {
  type Context,
  createHost,
  type Host,
  type ReplicatedState,
  replicatedState,
  resource,
  type Self,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { Agent } from './agent.ts';
import type { ChangesView } from './changes/git.ts';
import type { ChangesRuntime } from './changes/index.ts';
import { createAgentControl, type HostLicks, type HostScoops } from './control.ts';
import { trackDeliveries } from './deliveries.ts';
import type { FreezerRuntime, FrozenCone } from './freezer/index.ts';
import type { UserClients } from './kernel/users.ts';
import type { McpRuntime } from './mcp/index.ts';
import type { MemoryEntry, MemoryScope } from './memory/format.ts';
import type { MemoryRuntime } from './memory/index.ts';
import { createMonitor, type MonitorOptions } from './monitor/index.ts';
import { viewRemote } from './readonly.ts';
import { type AgentRemote, createRemote } from './remote/host.ts';
import { createPages, ownedPages, type Pages } from './remote/pages.ts';
import type { SecretName } from './secrets/names.ts';
import type { VaultState } from './secrets/vault.ts';
import {
  AgentControl,
  AgentPagesService,
  AgentRemoteService,
  AgentSettings,
  AgentTranscript,
  CONTROL_METHODS,
  CONTROL_READS,
  type Command,
  PAGE_METHODS,
  type PrivateRevision,
  REMOTE_METHODS,
  REMOTE_READS,
  SETTINGS_METHODS,
} from './services.ts';
import {
  AGENT_HOST,
  type AgentPrincipal,
  principalKey,
  readable,
  readablesOf,
  type Seat,
  seatOf,
  served,
} from './serving.ts';
import type { SkillsRuntime } from './skills/index.ts';
import type { SprinklesRuntime } from './sprinkles/index.ts';
import type { Sprinkle } from './sprinkles/kind.ts';
import { slimmer, type Thumbnail, thumbnail } from './thumbs.ts';
import { type LabelsRuntime, visibleLabels, watchLabel } from './titles/labels.ts';
import type { Uploads } from './uploads.ts';
import { agentViews } from './views.ts';
import { type PortEndpoint, PortLink } from './wire.ts';

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

const noSettings: AgentSettings = {
  state: replicatedState({ models: [], accounts: [] }),
  connect: async () => {
    throw new Error('this agent has no accounts');
  },
  disconnect: async () => {},
  signIn: async () => null,
  dismissMoved: async () => {},
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

function gatedControls(
  control: AgentControl,
  shown: (entry: number) => boolean,
  views: () => readonly ConversationView[],
  labels: ReplicatedState<Record<string, string>>
) {
  const visible = (entry: number) =>
    views().some((view) => view.entries.some((item) => item.id === entry));
  const gated =
    (allowed: (entry: number) => boolean): AgentControl['image'] =>
    async (ref, using) =>
      allowed(ref.entry) ? control.image(ref, using) : { data: null, mimeType: null };
  const trusted: AgentControl = { ...control, image: gated(shown) };
  const viewed: AgentControl = { ...control, image: gated(visible), toolLabel: watchLabel(labels) };
  return { trusted, viewed };
}

const noRevision = () => replicatedState<PrivateRevision>({ revision: 0 });

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
    monitor?: Pick<MonitorOptions, 'kernel' | 'groups' | 'users'>;
    pages?: Pages;
    secrets?: HostSecrets;
    uploads?: Uploads;
    thumbnail?: Thumbnail;
    labels?: LabelsRuntime;
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
    options.uploads,
    options.labels
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
  const shownViews = () => [state.value, ...Object.values(mounted.views.value)];
  const kept = options.labels?.labels ?? replicatedState<Record<string, string>>({});
  const labels = visibleLabels(kept, [state, mounted.views], shownViews);
  const transcriptService = {
    state,
    deliveries: deliveries.state,
    agents: mounted.agents,
    views: mounted.views,
    commands: options.skills?.commands ?? replicatedState<Command[]>([]),
    privateRevision: options.skills?.privateRevision ?? noRevision(),
    sprinkles: options.sprinkles?.sprinkles ?? replicatedState<Sprinkle[]>([]),
    memories: options.memory?.memories ?? replicatedState<MemoryEntry[]>([]),
    memoryScopes: options.memory?.scopes ?? replicatedState<MemoryScope[]>([]),
    frozen: options.freezer?.frozen ?? replicatedState<FrozenCone[]>([]),
    changes:
      options.changes?.view ?? replicatedState<ChangesView>({ unavailable: null, changes: [] }),
    monitor: monitor.state,
    vault: options.secrets?.vault ?? idleVault,
    labels: labels.state,
  };
  const settings = options.settings ?? noSettings;
  const gates = gatedControls(control, slims.shown, shownViews, transcriptService.labels);
  const { trusted, viewed } = gates;
  const host = serveAgent({
    trusted,
    viewed,
    transcript: transcriptService,
    viewMonitor: monitor.viewState,
    settings,
    remote,
    pages,
  });
  let links = 0;
  return {
    serverId,
    agent,
    pages,
    ...(options.users ? { users: options.users } : {}),
    connect(endpoint, connectOptions) {
      const seat: Seat = connectOptions?.readOnly
        ? 'view'
        : connectOptions?.pages === false
          ? 'control'
          : 'owner';
      links += 1;
      const link = new PortLink(endpoint);
      link.greet(serverId);
      host.accept(link, { principal: { seat, link: links } satisfies AgentPrincipal });
    },
    async close() {
      await host.close();
      await pages.dispose();
      await monitor.dispose();
      await remote.dispose();
      deliveries.dispose();
      transcript.dispose();
      mounted.dispose();
      labels.dispose();
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

interface Served {
  trusted: AgentControl;
  viewed: AgentControl;
  transcript: Record<keyof AgentTranscript, ReplicatedState<unknown>>;
  viewMonitor: ReplicatedState<unknown>;
  settings: AgentSettings;
  remote: AgentRemote;
  pages: Pages;
}

export function serveAgent(serving: Served): Host {
  const host = createHost({ name: AGENT_HOST, principalKey });
  const viewing = { ...serving.transcript, monitor: serving.viewMonitor };
  host.serve(AgentControl, ((_input: unknown, principal: unknown) =>
    seatOf(principal) === 'view'
      ? { kind: 'view', ...served(() => serving.viewed, CONTROL_READS) }
      : { kind: 'control', ...served(() => serving.trusted, CONTROL_METHODS) }) as never);
  host.serve(AgentTranscript, ((_input: unknown, principal: unknown) => ({
    kind: 'transcript',
    ...readablesOf(seatOf(principal) === 'view' ? viewing : serving.transcript),
  })) as never);
  host.serve(AgentSettings, ((_input: unknown, principal: unknown) => ({
    kind: seatOf(principal) === 'view' ? 'view' : 'settings',
    state: readable(serving.settings.state),
    ...(seatOf(principal) === 'view' ? {} : served(() => serving.settings, SETTINGS_METHODS)),
  })) as never);
  host.serve(AgentRemoteService, ((_input: unknown, principal: unknown) => {
    if (seatOf(principal) !== 'view')
      return { kind: 'remote', ...served(() => serving.remote, REMOTE_METHODS) };
    const scoped = viewRemote(serving.remote);
    return { kind: 'watch', ...served(() => scoped, REMOTE_READS) };
  }) as never);
  host.serve(AgentPagesService, ((_input: unknown, principal: unknown, self: Self) => {
    if (seatOf(principal) !== 'owner') return { kind: 'none' };
    const held = self.resources({
      mine: resource({
        rev: 1,
        open: () => ownedPages(serving.pages),
        close: (mine) => mine.release(),
      }),
    });
    return { kind: 'pages', ...served(() => held.mine.value, PAGE_METHODS) };
  }) as never);
  return host;
}
