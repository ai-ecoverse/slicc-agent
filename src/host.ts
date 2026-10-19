import {
  type Context,
  createHost,
  forbidden,
  type Host,
  type Readable,
  type ReplicatedState,
  replicatedState,
  type Self,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { Agent } from './agent.ts';
import {
  type ApprovalJudge,
  type Approvals,
  attachApprovals,
  type Decider,
} from './approvals/index.ts';
import { type ApprovalPolicies, alwaysFor, attachApprovalPolicy } from './approvals/policy.ts';
import { type AgentSudo, createSudo, ownedSudo } from './approvals/sudo.ts';
import type { ChangesView } from './changes/git.ts';
import type { ChangesRuntime } from './changes/index.ts';
import { createAgentControl, type HostLicks, type HostScoops } from './control.ts';
import { trackDeliveries } from './deliveries.ts';
import type { FreezerRuntime, FrozenCone } from './freezer/index.ts';
import { IDLE, type ImportProgress } from './freezer/v6.ts';
import { createGuests, type Guests } from './guests/index.ts';
import type { ScoopReviewHost } from './guests/scoop.ts';
import { admitGuest, guestOpener } from './guests/serve.ts';
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
  type AgentGuest,
  AgentGuestService,
  AgentPagesService,
  AgentRemoteService,
  AgentSettings,
  AgentSudoService,
  AgentTranscript,
  CONTROL_METHODS,
  CONTROL_READS,
  type Command,
  GUEST_METHODS,
  OWNER_DEVICE_METHODS,
  PAGE_METHODS,
  type PrivateRevision,
  REMOTE_METHODS,
  REMOTE_READS,
  SETTINGS_METHODS,
  SUDO_METHODS,
} from './services.ts';
import {
  AGENT_HOST,
  type AgentPrincipal,
  type GuestPrincipal,
  principalKey,
  readable,
  readablesOf,
  SELF,
  type Seat,
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
  guest?: { id: string; label: string };
  device?: string;
}

export interface AgentHost {
  readonly serverId: string;
  readonly agent: Agent;
  readonly users?: UserClients;
  readonly pages: Pages;
  readonly guests: Guests;
  readonly approvals: Approvals;
  connect(endpoint: PortEndpoint, options?: ConnectOptions): void;
  close(): Promise<void>;
}

const noSettings: AgentSettings = {
  state: replicatedState({ models: [], accounts: [] }),
  connect: async () => {
    throw new Error('this agent has no accounts');
  },
  disconnect: async () => {},
  remove: async () => {},
  serverUrl: async () => null,
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

async function approving(
  agent: Agent,
  policy: ApprovalPolicies,
  options: { judge?: ApprovalJudge; intent?: ScoopReviewHost['intent']; approvalMs?: number },
  context: Context
): Promise<Approvals> {
  const approvals = await attachApprovals(
    {
      harness: agent.harness,
      guestAlways: alwaysFor(policy),
      sudoApprover: () => policy.current().sudo.approver,
      scoops: agent.scoopReviews,
      ...(options.judge ? { judge: options.judge } : {}),
      ...(options.approvalMs ? { ttlMs: options.approvalMs } : {}),
    },
    context
  );
  agent.scoopReviews.bind({
    approvals,
    agents: agent.agents,
    harness: agent.harness,
    ...(options.intent ? { intent: options.intent } : {}),
  });
  return approvals;
}

async function guestsOf(
  agent: Agent,
  approvals: Approvals,
  policy: ApprovalPolicies,
  context: Context
): Promise<Guests> {
  const guests = await createGuests({
    harness: agent.harness,
    agents: agent.agents,
    approvals,
    policy,
    reviews: agent.reviews,
    context,
  });
  agent.gate.bind({ approvals, policy: () => guests.policy() });
  return guests;
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
    approvals?: Approvals;
    judge?: ApprovalJudge;
    intent?: ScoopReviewHost['intent'];
    approvalMs?: number;
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
  const policy = await attachApprovalPolicy(agent.harness, context);
  const approvals = options.approvals ?? (await approving(agent, policy, options, context));
  const monitor = createMonitor({
    ...options.monitor,
    harness: agent.harness,
    agents: agent.agents,
    views: mounted.views,
    context,
  });
  const guests = await guestsOf(agent, approvals, policy, context);
  const control: AgentControl = {
    ...createAgentControl(
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
      options.labels,
      guests
    ),
    approvalPolicySet: (change, using) => policy.set(change, using),
  };
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
    importing: options.freezer?.importing ?? replicatedState<ImportProgress>(IDLE),
    changes:
      options.changes?.view ?? replicatedState<ChangesView>({ unavailable: null, changes: [] }),
    monitor: monitor.state,
    vault: options.secrets?.vault ?? idleVault,
    labels: labels.state,
    guests: guests.seats,
    approvals: approvals.state,
    approvalPolicy: policy.state,
  };
  const sudo = createSudo({
    approvals,
    agents: () => agent.agents.state(),
    ...(options.licks ? { licks: options.licks.licks } : {}),
  });
  const settings = options.settings ?? noSettings;
  const gates = gatedControls(control, slims.shown, shownViews, transcriptService.labels);
  const { trusted, viewed } = gates;
  const host = serveAgent({
    trusted,
    viewed,
    transcript: transcriptService,
    viewMonitor: monitor.viewState,
    sudo,
    settings,
    remote,
    pages,
    guest: guestOpener(guests, agent.agents, mounted.views, context),
    decide: (by) => (id, decision, reason, using) =>
      approvals.decide(id, decision, reason, by, using),
  });
  const offGuests = guests.onEnd((id) => {
    void host.invalidatePrincipal(
      (principal) => principal.seat === 'guest' && principal.guest.id === id
    );
  });
  let links = 0;
  return {
    serverId,
    agent,
    pages,
    guests,
    approvals,
    ...(options.users ? { users: options.users } : {}),
    connect(endpoint, connectOptions) {
      if (connectOptions?.guest) {
        links += 1;
        admitGuest(guests, endpoint, connectOptions.guest, serverId, links, host);
        return;
      }
      const seat: Exclude<Seat, 'guest'> = connectOptions?.readOnly
        ? 'view'
        : connectOptions?.pages === false
          ? 'control'
          : 'owner';
      links += 1;
      const link = new PortLink(endpoint);
      link.greet(serverId);
      const device = connectOptions?.device ? { device: connectOptions.device } : {};
      host.accept(link, {
        principal: { seat, link: links, ...device } satisfies AgentPrincipal,
      });
    },
    async close() {
      offGuests();
      await host.close();
      guests.dispose();
      await pages.dispose();
      await monitor.dispose();
      await remote.dispose();
      deliveries.dispose();
      sudo.close();
      approvals.close();
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
  sudo?: AgentSudo;
  settings: AgentSettings;
  remote: AgentRemote;
  pages: Pages;
  guest?: (principal: GuestPrincipal) => { value: AgentGuest; dispose(): void } | undefined;
  decide: (by: Decider) => AgentControl['decide'];
}

export const CLOSED_TO_GUESTS = 'a guest seat has only its transcript and propose';

const opened = new WeakSet<object>();

export const openToGuests = <F extends object>(factory: F): F => {
  opened.add(factory);
  return factory;
};

export function closedToGuests(host: Host<AgentPrincipal>): Host<AgentPrincipal> {
  const serve = ((type: never, factory: (...args: unknown[]) => unknown, options?: never) =>
    host.serve(
      type,
      (opened.has(factory)
        ? factory
        : (input: unknown, principal: AgentPrincipal, self: unknown) => {
            if (principal.seat === 'guest') throw forbidden(CLOSED_TO_GUESTS);
            return factory(input, principal, self);
          }) as never,
      options
    )) as Host<AgentPrincipal>['serve'];
  return new Proxy(host, {
    get(target, key) {
      if (key === 'serve') return serve;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function lazily<T>(state: () => ReplicatedState<T>): Readable<T> {
  return {
    get value() {
      return readable(state()).value;
    },
    subscribe: (listener) => readable(state()).subscribe(listener),
    events: (listener) => readable(state()).events(listener),
  };
}

const seated = (serving: Served, principal: AgentPrincipal): AgentControl => ({
  ...(principal.seat === 'view' ? serving.viewed : serving.trusted),
  decide: serving.decide({
    by: principal.seat === 'owner' ? 'owner' : 'follower',
    ...('device' in principal && principal.device ? { device: principal.device } : {}),
  }),
});

const VIEW_METHODS = [...CONTROL_READS, ...OWNER_DEVICE_METHODS];

export function serveAgent(serving: Served): Host<AgentPrincipal> {
  const host = closedToGuests(
    createHost<AgentPrincipal>({ name: AGENT_HOST, self: SELF, principalKey })
  );
  const viewing = { ...serving.transcript, monitor: serving.viewMonitor };
  host.serve(AgentControl, (_input, principal) => {
    const control = seated(serving, principal);
    return principal.seat === 'view'
      ? { variant: 'view', ...served(() => control, VIEW_METHODS) }
      : { variant: 'control', ...served(() => control, CONTROL_METHODS) };
  });
  host.serve(AgentTranscript, (_input, principal) => ({
    variant: 'transcript',
    ...readablesOf(principal.seat === 'view' ? viewing : serving.transcript),
  }));
  host.serve(AgentSettings, (_input, principal) =>
    principal.seat === 'view'
      ? { variant: 'view', state: readable(serving.settings.state) }
      : {
          variant: 'settings',
          state: readable(serving.settings.state),
          ...served(() => serving.settings, SETTINGS_METHODS),
        }
  );
  host.serve(AgentRemoteService, (_input, principal) => {
    if (principal.seat !== 'view')
      return { variant: 'remote', ...served(() => serving.remote, REMOTE_METHODS) };
    const scoped = viewRemote(serving.remote);
    return { variant: 'watch', ...served(() => scoped, REMOTE_READS) };
  });
  host.serve(AgentPagesService, (_input, principal, self) => {
    if (principal.seat !== 'owner') return { variant: 'none' };
    const mine = self.resource('mine', {
      version: 1,
      open: () => ownedPages(serving.pages),
      close: (owned) => owned.release(),
    });
    return { variant: 'pages', ...served(() => mine.value, PAGE_METHODS) };
  });
  host.serve(
    AgentGuestService,
    openToGuests((_input: unknown, principal: AgentPrincipal, self: Self<AgentPrincipal>) => {
      if (principal.seat !== 'guest') return { variant: 'none' };
      const opening = serving.guest?.(principal.guest);
      if (!opening) throw forbidden(CLOSED_TO_GUESTS);
      const seat = self.resource('seat', {
        version: 1,
        open: () => opening,
        close: (made) => made.dispose(),
      });
      const later = (name: 'transcript' | 'seat' | 'proposals') =>
        lazily(() => seat.value.value[name] as ReplicatedState<unknown>);
      return {
        variant: 'guest',
        transcript: later('transcript'),
        seat: later('seat'),
        proposals: later('proposals'),
        ...served(() => seat.value.value, GUEST_METHODS),
      };
    })
  );
  host.serve(AgentSudoService, (_input, principal, self) => {
    const sudo = serving.sudo;
    if (principal.seat !== 'owner' || !sudo) return { variant: 'none' };
    const mine = self.resource('mine', {
      version: 1,
      open: () => ownedSudo(sudo),
      close: (owned) => owned.release(),
    });
    return {
      variant: 'sudo',
      approvals: readable(sudo.approvals),
      ...served(() => mine.value, SUDO_METHODS),
    };
  });
  return host;
}
