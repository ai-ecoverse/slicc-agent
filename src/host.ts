import {
  broken,
  type Contract,
  createHost,
  defineFacet,
  type FacetHost,
  forbidden,
  type Host,
  type HostError,
  isChordError,
  type Self,
} from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { Agent } from './agent.ts';
import {
  type ApprovalJudge,
  type Approvals,
  type Attendance,
  attachApprovals,
  attendance,
  type Decider,
  stoppingAttach,
} from './approvals/index.ts';
import { ownerAlways, ownerAlwaysForget } from './approvals/owner-tools.ts';
import { type ApprovalPolicies, attachApprovalPolicy } from './approvals/policy.ts';
import { publishedApprovals } from './approvals/published.ts';
import type { RunKernel, Runner, SudoRunHost } from './approvals/run.ts';
import { deliverNotice } from './approvals/run-notice.ts';
import {
  frozenOf,
  goneOf,
  kernelGate,
  type RunGates,
  type RunnableWatch,
  watchRunnable,
} from './approvals/runnable.ts';
import { type AgentSudo, createSudo, ownedSudo } from './approvals/sudo.ts';
import type { ChangesView } from './changes/git.ts';
import type { ChangesRuntime } from './changes/index.ts';
import { createAgentControl, type HostLicks, type HostScoops } from './control.ts';
import { trackDeliveries } from './deliveries.ts';
import type { FreezerRuntime, FrozenCone } from './freezer/index.ts';
import { IDLE, type ImportProgress } from './freezer/v6.ts';
import { captureGate } from './guests/capture.ts';
import { createGuests, type Guests } from './guests/index.ts';
import type { ScoopReviewHost } from './guests/scoop.ts';
import { admitGuest, guestOpener, limited } from './guests/serve.ts';
import { createInventory } from './inventory.ts';
import type { UserClients } from './kernel/users.ts';
import { MAX_FRAME } from './link.ts';
import type { McpRuntime } from './mcp/index.ts';
import type { MemoryEntry, MemoryScope } from './memory/format.ts';
import type { MemoryRuntime } from './memory/index.ts';
import { createMonitor, type MonitorOptions } from './monitor/index.ts';
import { viewRemote } from './readonly.ts';
import { linkDecide } from './remote/decide.ts';
import { type AgentRemote, createRemote } from './remote/host.ts';
import { createPages, ownedPages, type Pages } from './remote/pages.ts';
import type { SecretListing } from './secrets/names.ts';
import type { VaultState } from './secrets/vault.ts';
import {
  AgentControl,
  type AgentGuest,
  AgentGuestService,
  AgentInventoryService,
  AgentPagesService,
  AgentRemoteService,
  AgentSettings,
  AgentSudoService,
  AgentTranscript,
  CONTROL_METHODS,
  CONTROL_READS,
  type Command,
  GUEST_METHODS,
  helloOf,
  type InventoryState,
  OWNER_DEVICE_METHODS,
  OWNER_SETTINGS_METHODS,
  PAGE_METHODS,
  type PrivateRevision,
  REMOTE_METHODS,
  REMOTE_READS,
  SETTINGS_MEMBER,
  SETTINGS_METHODS,
  SUDO_METHODS,
  TRANSCRIPT_STATES,
  transcriptMember,
} from './services.ts';
import {
  Agent as AgentAddress,
  type AgentPrincipal,
  acceptsOf,
  following,
  type GuestPrincipal,
  principalKey,
  SELF,
  type Seat,
  served,
} from './serving.ts';
import type { SkillsRuntime } from './skills/index.ts';
import type { SprinklesRuntime } from './sprinkles/index.ts';
import type { Sprinkle } from './sprinkles/kind.ts';
import { createState, type State } from './state.ts';
import { type Slimmer, slimmer, type Thumbnail, thumbnail } from './thumbs.ts';
import { type LabelsRuntime, visibleLabels, watchLabel, watchStep } from './titles/labels.ts';
import type { Uploads } from './uploads.ts';
import { agentViews } from './views.ts';
import { CALL_WINDOW, type PortEndpoint, PortLink } from './wire.ts';

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

const NO_SERVERS = {
  ok: false as const,
  code: 'invalid' as const,
  reason: 'this agent has no MCP servers',
};

export const noSettings: AgentSettings = {
  state: createState({ models: [], accounts: [] }),
  connect: async () => {
    throw new Error('this agent has no accounts');
  },
  disconnect: async () => {},
  remove: async () => {},
  serverUrl: async () => null,
  signIn: async () => null,
  dismissMoved: async () => {},
  addServer: async () => NO_SERVERS,
  removeServer: async () => NO_SERVERS,
  refusals: async () => ({}),
};

export async function follow(
  agent: Agent,
  context: Context,
  slim: (view: ConversationView) => ConversationView
) {
  let watch = await agent.cone().watch(context);
  const state = createState<ConversationView>(slim(watch.value));
  const mirror = (value: ConversationView, from: Context) => state.replace(from, slim(value));
  const listen = (current: typeof watch) => {
    current.start(async (call, using) => {
      if (call.kind !== 'value') return;
      mirror(call.value, using);
    });
  };
  listen(watch);
  const stop = agent.onCone(async (conversation) => {
    const next = await conversation.watch(context);
    await watch.stop();
    watch = next;
    state.replace(context, slim(next.value));
    listen(watch);
  });
  return {
    state,
    refresh: () => state.replace(context, slim(watch.value)),
    dispose() {
      stop();
      void watch.stop();
    },
  };
}

export interface HostSecrets {
  vault: State<VaultState>;
  list(): SecretListing;
  close?(): void;
}

const idleVault = createState<VaultState>({
  port: 'none',
  needed: false,
  version: 0,
  locked: 'no',
  held: 0,
});

export function viewedImage(
  control: AgentControl,
  views: () => readonly ConversationView[],
  paged: Map<number, { agentId: string | null; conversation: number }>
): AgentControl['image'] {
  const none = { data: null, mimeType: null };
  const current = async (entry: number, using: Context) => {
    const grant = paged.get(entry);
    if (!grant) return false;
    const page = await control.entries(
      { ...grant, minEntryId: entry, maxEntryId: entry, limit: 1 },
      using
    );
    if (page.conversation !== grant.conversation) paged.delete(entry);
    return page.entries.some((item) => Number(item.id) === entry);
  };
  return async (ref, using) => {
    const shown = views().some((view) => view.entries.some((item) => item.id === ref.entry));
    const allowed = shown || (await current(ref.entry, using).catch(() => false));
    return allowed ? control.image(ref, using) : none;
  };
}

export function gatedControls(
  control: AgentControl,
  slims: Pick<Slimmer, 'entries' | 'shown'>,
  views: () => readonly ConversationView[],
  labels: State<Record<string, string>>
) {
  const slimmed: AgentControl['entries'] = async (request, using) => {
    const page = await control.entries(request, using);
    return { ...page, entries: await slims.entries(page.entries) };
  };
  const trusted: AgentControl = {
    ...control,
    image: async (ref, using) =>
      slims.shown(ref.entry) ? control.image(ref, using) : { data: null, mimeType: null },
    entries: slimmed,
  };
  const viewed = (): AgentControl => {
    const paged = new Map<number, { agentId: string | null; conversation: number }>();
    return {
      ...control,
      image: viewedImage(control, views, paged),
      toolLabel: watchLabel(labels),
      stepLabel: watchStep(labels),
      entries: async (request, using) => {
        const page = await slimmed(request, using);
        for (const entry of page.entries)
          paged.set(Number(entry.id), {
            agentId: request.agentId,
            conversation: page.conversation,
          });
        return page;
      },
    };
  };
  return { trusted, viewed };
}

type ApprovalOptions = {
  approvals?: Approvals;
  judge?: ApprovalJudge;
  intent?: ScoopReviewHost['intent'];
  approvalMs?: number;
};

async function approving(
  agent: Agent,
  policy: ApprovalPolicies,
  options: { judge?: ApprovalJudge; intent?: ScoopReviewHost['intent']; approvalMs?: number },
  owners: Attendance,
  context: Context
): Promise<Approvals> {
  const approvals = await attachApprovals(stoppingAttach(agent, policy, owners, options), context);
  agent.scoopReviews.bind({
    approvals,
    agents: agent.agents,
    harness: agent.harness,
    ...(options.intent ? { intent: options.intent } : {}),
  });
  return approvals;
}

export async function approvalsOf(
  agent: Agent,
  policy: ApprovalPolicies,
  options: ApprovalOptions,
  context: Context
) {
  const owners = attendance();
  const approvals = options.approvals ?? (await approving(agent, policy, options, owners, context));
  const decide: Served['decide'] = (by) => (id, decision, reason, using) =>
    approvals.decide(id, decision, reason, by, using);
  return { approvals, serving: { decide, owners } };
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
  agent.ownerGate.bind({ approvals, tools: () => policy.state.value?.owner.tools ?? 'off' });
  return guests;
}

const inventoryOf = (
  agent: Agent,
  views: State<Record<string, ConversationView>>,
  context: Context
) =>
  createInventory({
    agents: agent.agents,
    views,
    harness: agent.harness,
    models: agent.models,
    context,
  });

const noRevision = () => createState<PrivateRevision>({ revision: 0 });

export type HostOptions = {
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
  runs?: { kernel: RunKernel & { protocol?: readonly number[] }; boot: string | null } & RunTimes;
} & ApprovalOptions;

type OwnControls = 'approvalPolicySet' | 'approvalRunNotice' | 'ownerAlways' | 'ownerAlwaysForget';

export type RunTimes = Partial<
  Pick<SudoRunHost, 'pollMs' | 'killMs' | 'adoptMs' | 'outputCap' | 'keepMs'>
>;

function runsOf(
  agent: Agent,
  sources: { policy: ApprovalPolicies; approvals: Approvals; agents: State<unknown> },
  options: HostOptions,
  serverId: string
) {
  const { policy } = sources;
  const runs = options.runs;
  if (runs)
    agent.sudoRuns.bind({
      ...runs,
      harness: agent.harness,
      agents: agent.agents,
      ...(options.licks ? { licks: options.licks.licks } : {}),
      server: serverId,
      conversation: Number(agent.root.id),
    });
  const gates = (): RunGates => ({
    maxAgeMinutes: policy.current().sudo.runLate.maxAgeMinutes,
    kernel: kernelGate(runs?.kernel),
    frozen: frozenOf(() => agent.agents.state()),
    gone: goneOf(() => agent.agents.state()),
  });
  const serve: Served['runs'] = (runner) => ({
    approvalRun: (id, using) => agent.sudoRuns.claim(id, runner, gates(), using),
    approvalRunStop: (id, using) => agent.sudoRuns.stop(id, runner, using),
  });
  const notices = { harness: agent.harness, agents: agent.agents, licks: options.licks?.licks };
  const controls: Pick<AgentControl, OwnControls> = {
    approvalPolicySet: (change, using) => policy.set(change, using),
    approvalRunNotice: (raw) => deliverNotice(notices, raw),
    ownerAlways: (using) => ownerAlways(agent.harness, using),
    ownerAlwaysForget: (approval, using) => ownerAlwaysForget(agent.harness, approval, using),
  };
  const runnable: RunnableWatch = watchRunnable(
    sources.approvals.state,
    [policy.state, sources.agents, ...(options.freezer ? [options.freezer.frozen] : [])],
    gates
  );
  return { serve, runnable, controls };
}

const captureOf = (agent: Agent, approvals: Approvals, guests: Guests, options: HostOptions) =>
  captureGate({
    harness: agent.harness,
    approvals,
    policy: () => guests.policy(),
    ...(options.scoops ? { lineage: options.scoops.scoops.lineage } : {}),
  });

const sudoOf = (agent: Agent, approvals: Approvals, guests: Guests, options: HostOptions) =>
  createSudo({
    approvals,
    capture: captureOf(agent, approvals, guests, options),
    agents: () => agent.agents.state(),
    ...(options.licks ? { licks: options.licks.licks } : {}),
  });

const viewStates = (viewMonitor: State<unknown>, approvals: Approvals['state']) => ({
  viewMonitor,
  viewApprovals: publishedApprovals(approvals, true),
});

const seatOf = (options: ConnectOptions | undefined): Exclude<Seat, 'guest'> =>
  options?.readOnly ? 'view' : options?.pages === false ? 'control' : 'owner';

function connector(
  host: Host<AgentPrincipal, Revocation>,
  guests: Guests,
  serverId: string,
  context: Context
): AgentHost['connect'] {
  let links = 0;
  return (endpoint, options) => {
    links += 1;
    if (options?.guest) {
      admitGuest(guests, endpoint, options.guest, serverId, links, host, context);
      return;
    }
    const device = options?.device ? { device: options.device } : {};
    const principal: AgentPrincipal = { kind: seatOf(options), link: links, ...device };
    host.accept(new PortLink(endpoint, helloOf(serverId)), { principal, limits: LIMITS }, context);
  };
}

export async function hostAgent(agent: Agent, options: HostOptions = {}): Promise<AgentHost> {
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
  const inventory = inventoryOf(agent, mounted.views, context);
  const untouch = [state.subscribe(touch), mounted.views.subscribe(touch), inventory.dispose];
  const pages = options.pages ?? createPages();
  const deliveries = trackDeliveries(agent.harness, state, context);
  const policy = await attachApprovalPolicy(agent.harness, context);
  const { approvals, serving } = await approvalsOf(agent, policy, options, context);
  const monitor = createMonitor({
    ...options.monitor,
    harness: agent.harness,
    agents: agent.agents,
    views: mounted.views,
    reports: agent.reports,
    timings: agent.timings,
    context,
  });
  const guests = await guestsOf(agent, approvals, policy, context);
  const runs = runsOf(agent, { policy, approvals, agents: mounted.agents }, options, serverId);
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
    ...runs.controls,
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
  const kept = options.labels?.labels ?? createState<Record<string, string>>({});
  const labels = visibleLabels(kept, [state, mounted.views], shownViews);
  const transcriptService = {
    state,
    deliveries: deliveries.state,
    agents: mounted.agents,
    views: mounted.views,
    commands: options.skills?.commands ?? createState<Command[]>([]),
    privateRevision: options.skills?.privateRevision ?? noRevision(),
    sprinkles: options.sprinkles?.sprinkles ?? createState<Sprinkle[]>([]),
    memories: options.memory?.memories ?? createState<MemoryEntry[]>([]),
    memoryScopes: options.memory?.scopes ?? createState<MemoryScope[]>([]),
    frozen: options.freezer?.frozen ?? createState<FrozenCone[]>([]),
    importing: options.freezer?.importing ?? createState<ImportProgress>(IDLE),
    changes: options.changes?.view ?? createState<ChangesView>({ unavailable: null, changes: [] }),
    monitor: monitor.state,
    vault: options.secrets?.vault ?? idleVault,
    labels: labels.state,
    guests: guests.seats,
    approvals: publishedApprovals(approvals.state, false),
    approvalPolicy: policy.state,
    approvalRunnable: runs.runnable.state,
  };
  const sudo = sudoOf(agent, approvals, guests, options);
  const settings = options.settings ?? noSettings;
  const { trusted, viewed } = gatedControls(control, slims, shownViews, labels.state);
  const host = await serveAgent(
    {
      trusted,
      viewed,
      transcript: transcriptService,
      ...viewStates(monitor.viewState, approvals.state),
      sudo,
      settings,
      remote,
      pages,
      inventory: inventory.state,
      guest: guestOpener(guests, agent.agents, mounted.views, context),
      ...serving,
      runs: runs.serve,
    },
    context
  );
  const offGuests = guests.onEnd((id) => host.revoke({ guest: id }, context));
  return {
    serverId,
    agent,
    pages,
    guests,
    approvals,
    ...(options.users ? { users: options.users } : {}),
    connect: connector(host, guests, serverId, context),
    async close() {
      offGuests();
      await host.close(context);
      guests.dispose();
      await pages.dispose();
      await monitor.dispose();
      await remote.dispose();
      deliveries.dispose();
      sudo.close();
      runs.runnable.dispose();
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
  viewed: () => AgentControl;
  transcript: Record<keyof AgentTranscript, State<unknown>>;
  viewMonitor: State<unknown>;
  viewApprovals: State<unknown>;
  sudo?: AgentSudo;
  settings: AgentSettings;
  remote: Omit<AgentRemote, 'decide'>;
  pages: Pages;
  inventory?: State<InventoryState>;
  guest?: (principal: GuestPrincipal) => { value: AgentGuest; dispose(): void } | undefined;
  decide: (by: Decider) => AgentControl['decide'];
  runs: (runner: Runner) => Pick<AgentControl, 'approvalRun' | 'approvalRunStop'>;
  owners?: Attendance;
}

export const CLOSED_TO_GUESTS = 'a guest seat has only its transcript and propose';

export const LIMITS = { part: MAX_FRAME, decoded: MAX_FRAME };

type Factory = (params: unknown, principal: AgentPrincipal, self: Self<AgentPrincipal>) => unknown;

const opened = new WeakSet<object>();

export const openToGuests = <F extends Factory>(factory: F): F => {
  opened.add(factory);
  return factory;
};

export function closedToGuests(host: FacetHost<AgentPrincipal>) {
  return (type: Contract, factory: Factory): void =>
    host.serve(
      type,
      (opened.has(factory)
        ? factory
        : (params: unknown, principal: AgentPrincipal, self: Self<AgentPrincipal>) => {
            if (principal.kind === 'guest') throw forbidden(CLOSED_TO_GUESTS);
            return factory(params, principal, self);
          }) as never,
      { accepts: acceptsOf(type) }
    );
}

const deviceOf = (principal: AgentPrincipal): string | undefined =>
  'device' in principal && principal.device ? principal.device : undefined;

const seated = (serving: Served, principal: AgentPrincipal): AgentControl => {
  const runner: Runner = {
    by: principal.kind === 'owner' ? 'owner' : 'follower',
    ...(deviceOf(principal) ? { device: deviceOf(principal) } : {}),
  };
  return {
    ...(principal.kind === 'view' ? serving.viewed() : serving.trusted),
    decide: serving.decide(runner),
    ...serving.runs(runner),
  };
};

const VIEW_METHODS = [...CONTROL_READS, ...OWNER_DEVICE_METHODS];

export function settingsFor(serving: Pick<Served, 'settings'>) {
  return (_params: unknown, principal: AgentPrincipal, self: Self<AgentPrincipal>) => {
    const members = { [SETTINGS_MEMBER]: self.follow(following(() => serving.settings.state)) };
    if (principal.kind === 'view') return { variant: 'view', members };
    const owner = principal.kind === 'owner';
    return {
      variant: owner ? 'owner' : 'settings',
      members: {
        ...members,
        ...served(() => serving.settings, owner ? OWNER_SETTINGS_METHODS : SETTINGS_METHODS),
      },
    };
  };
}

const quiet = (error: HostError) =>
  error.kind === 'activation_failed' && isChordError(error.failure.error, 'forbidden');

export const reportHost = (error: HostError): void => {
  if (!quiet(error)) console.warn('slicc-agent host:', error.kind, error);
};

type Revocation = { guest: string };

function facetOf(serving: Served) {
  const viewing: Record<keyof AgentTranscript, State<unknown>> = {
    ...serving.transcript,
    monitor: serving.viewMonitor,
    approvals: serving.viewApprovals,
  };
  return defineFacet<AgentPrincipal>((facetHost) => {
    const serve = closedToGuests(facetHost);
    serve(AgentControl, (_params, principal, self) => {
      const control = seated(serving, principal);
      const owners = serving.owners;
      if (owners && principal.kind !== 'host' && principal.kind !== 'guest')
        self.open(
          async () => owners.attend(),
          (leave) => leave()
        );
      return principal.kind === 'view'
        ? { variant: 'view', members: served(() => control, VIEW_METHODS) }
        : { variant: 'control', members: served(() => control, CONTROL_METHODS) };
    });
    serve(AgentTranscript, (_params, principal, self) => {
      const states = principal.kind === 'view' ? viewing : serving.transcript;
      return {
        variant: 'transcript',
        members: Object.fromEntries(
          TRANSCRIPT_STATES.map((name) => [
            transcriptMember(name),
            self.follow(following(() => states[name])),
          ])
        ),
      };
    });
    serve(AgentSettings, settingsFor(serving));
    serve(AgentRemoteService, (_params, principal) => {
      if (principal.kind !== 'view') {
        const remote: AgentRemote = {
          ...serving.remote,
          decide: linkDecide(serving.decide, deviceOf(principal)),
        };
        return { variant: 'remote', members: served(() => remote, REMOTE_METHODS) };
      }
      const scoped = viewRemote(serving.remote);
      return { variant: 'watch', members: served(() => scoped, REMOTE_READS) };
    });
    serve(AgentPagesService, (_params, principal, self) => {
      if (principal.kind !== 'owner') return { variant: 'none', members: {} };
      const mine = self.open(
        async () => ownedPages(serving.pages),
        (owned) => owned.release()
      );
      return { variant: 'pages', members: served(() => mine.value, PAGE_METHODS) };
    });
    serve(
      AgentGuestService,
      openToGuests((_params, principal, self) => {
        if (principal.kind !== 'guest') return { variant: 'none', members: {} };
        const guest = principal.guest;
        const seat = self.open(
          async () => {
            const opening = serving.guest?.(guest);
            if (!opening) throw broken(forbidden(CLOSED_TO_GUESTS));
            return opening;
          },
          (made) => made.dispose()
        );
        const later = (name: 'transcript' | 'seat' | 'proposals') =>
          self.follow(following(() => seat.value.value[name] as State<unknown>));
        return {
          variant: 'guest',
          members: {
            transcript: later('transcript'),
            seat: later('seat'),
            proposals: later('proposals'),
            ...limited(
              served(() => seat.value.value, GUEST_METHODS),
              principal.calls
            ),
          },
        };
      })
    );
    serve(AgentInventoryService, (_params, principal, self) => {
      const inventory = serving.inventory;
      if (principal.kind !== 'owner' || !inventory) return { variant: 'none', members: {} };
      return { variant: 'owner', members: { inventory: self.follow(following(() => inventory)) } };
    });
    serve(AgentSudoService, (_params, principal, self) => {
      const sudo = serving.sudo;
      if (principal.kind !== 'owner' || !sudo) return { variant: 'none', members: {} };
      const mine = self.open(
        async () => ownedSudo(sudo),
        (owned) => owned.release()
      );
      return {
        variant: 'sudo',
        members: {
          approvals: self.follow(following(() => sudo.approvals)),
          ...served(() => mine.value, SUDO_METHODS),
        },
      };
    });
  });
}

export async function serveAgent(
  serving: Served,
  context: Context
): Promise<Host<AgentPrincipal, Revocation>> {
  const host = createHost<AgentPrincipal, Revocation>({
    address: AgentAddress(),
    principal: SELF,
    principalKey,
    callWindow: CALL_WINDOW,
    onError: reportHost,
    revokedBy: (principal) => (principal.kind === 'guest' ? [{ guest: principal.guest.id }] : []),
  });
  await host.load([{ name: '@ai-ecoverse/slicc-agent', facet: facetOf(serving) }], context);
  return host;
}
