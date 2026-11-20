import {
  type ChordError,
  type Contract,
  createHost,
  type Host,
  type RefState,
} from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { NativeWatchable } from '@earendil-works/chord/watch';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { ApprovalPolicy } from './approvals/policy.ts';
import type { Approval } from './approvals/record.ts';
import type { NoticeAnswer, RunNotice } from './approvals/run-notice.ts';
import type { Runnable } from './approvals/runnable.ts';
import type { ChangesView } from './changes/git.ts';
import type { FrozenCone } from './freezer/index.ts';
import type { ImportProgress } from './freezer/v6.ts';
import type { GuestSeat } from './guests/seats.ts';
import type { MemoryEntry, MemoryScope } from './memory/format.ts';
import { controlAnswer, pageAnswer, remoteAnswer, settingsAnswer } from './readonly.ts';
import type { AgentRemote } from './remote/host.ts';
import type { AgentPages } from './remote/pages.ts';
import type { VaultState } from './secrets/vault.ts';
import {
  AgentControl,
  AgentInventoryService,
  AgentPagesService,
  AgentRemoteService,
  AgentSettings,
  type AgentsSummary,
  AgentTranscript,
  CONTROL_METHODS,
  type Command,
  type Delivered,
  type GuestProposal,
  type GuestShown,
  helloOf,
  type InventoryState,
  type MonitorFeed,
  OWNER_SETTINGS_METHODS,
  PAGE_METHODS,
  type PrivateRevision,
  REMOTE_METHODS,
  SETTINGS_MEMBER,
  type SendMode,
  type SettingsState,
  type TRANSCRIPT_STATES,
  transcriptMember,
} from './services.ts';
import {
  type AgentPrincipal,
  bindAt,
  bound,
  CLOSED,
  historyOf,
  offers,
  type Remote,
  type Replica,
  replica,
  SELF,
  serviceOf,
} from './serving.ts';
import type { Sprinkle } from './sprinkles/kind.ts';
import { createState, type State } from './state.ts';
import { otherService, type PortEndpoint, PortLink } from './wire.ts';

export type { State } from './state.ts';

export interface AgentConnection {
  readonly serverId: string;
  readonly control: AgentControl;
  readonly transcript: State<ConversationView>;
  readonly deliveries: State<Record<string, Delivered>>;
  readonly agents?: State<AgentsSummary>;
  readonly views?: State<Record<string, ConversationView>>;
  readonly commands?: State<Command[]>;
  readonly privateRevision?: State<PrivateRevision>;
  readonly sprinkles?: State<Sprinkle[]>;
  readonly memories?: State<MemoryEntry[]>;
  readonly memoryScopes?: State<MemoryScope[]>;
  readonly frozen?: State<FrozenCone[]>;
  readonly importing?: State<ImportProgress>;
  readonly changes?: State<ChangesView>;
  readonly monitor?: State<MonitorFeed>;
  readonly vault?: State<VaultState>;
  readonly labels?: State<Record<string, string>>;
  readonly guests?: State<GuestSeat[]>;
  readonly viewOnly?: boolean;
  readonly guest?: GuestShown;
  readonly proposals?: State<GuestProposal[]>;
  readonly owner?: boolean;
  readonly approvals?: State<Approval[]>;
  readonly approvalPolicy?: State<ApprovalPolicy>;
  readonly approvalRunnable?: State<Record<string, Runnable>>;
  readonly settings: AgentSettings;
  readonly remote?: AgentRemote;
  readonly history?: boolean;
  readonly pages?: AgentPages;
  readonly inventory?: State<InventoryState>;
  readonly closed: Promise<Error | undefined>;
  readonly readOnly?: boolean;
  prompt(text: string, whenBusy?: SendMode): Promise<string>;
  webhook(
    name: string,
    delivery: { id?: string | null; headers?: Record<string, string>; body: string }
  ): Promise<{ delivered: boolean }>;
  approvalRunNotice(notice: RunNotice): Promise<NoticeAnswer>;
  close(): Promise<void>;
}

export function lastingSettings(
  settings: AgentSettings,
  state: State<SettingsState>
): AgentSettings {
  return {
    state,
    connect: (providerId, secret, fields, context) =>
      settings.connect(providerId, secret, fields, context),
    disconnect: (providerId, context) => settings.disconnect(providerId, context),
    remove: (providerId, context) => settings.remove(providerId, context),
    serverUrl: (providerId, context) => settings.serverUrl(providerId, context),
    signIn: (providerId, context) => settings.signIn(providerId, context),
    dismissMoved: (context) => settings.dismissMoved(context),
    addServer: (name, entry, context) => settings.addServer(name, entry, context),
    removeServer: (id, context) => settings.removeServer(id, context),
    refusals: (context) => settings.refusals(context),
  };
}

export const ended = (link: PortLink): Promise<never> =>
  link.ended.then((reason) => {
    throw reason ?? new Error('the agent closed the link');
  });

export const reportClient = (error: unknown): void => {
  if ((error as { kind?: unknown } | null)?.kind !== 'protocol_error') return;
  console.warn('slicc-agent client:', error);
};

export const READY_MS = 60_000;

const REFUSALS = new Set(['contract_mismatch', 'unavailable']);

type Binding =
  | { kind: 'live' }
  | { kind: 'refused'; error: ChordError }
  | { kind: 'failed'; error: unknown };

function settled(state: RefState): Binding | undefined {
  if (state.kind === 'live') return { kind: 'live' };
  if (state.kind === 'ended') return { kind: 'failed', error: state.error };
  if (state.kind !== 'failed') return undefined;
  const { cause } = state;
  if (cause.kind === 'broken') return { kind: 'failed', error: cause.error };
  if (cause.kind === 'waiting' && REFUSALS.has(cause.error.code))
    return { kind: 'refused', error: cause.error };
  return undefined;
}

async function binding(ref: Remote, context: Context, ms: number): Promise<Binding> {
  const watch = await (ref.state as NativeWatchable<RefState>).watch(context);
  let last: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<Binding>((resolve) => {
    const look = (state: RefState) => {
      if (state.kind === 'failed') last = state.cause.error;
      const found = settled(state);
      if (found) resolve(found);
    };
    timer = setTimeout(
      () => resolve({ kind: 'failed', error: last ?? new Error(`not live within ${ms} ms`) }),
      ms
    );
    void watch.closed.then(() => resolve({ kind: 'failed', error: last ?? new Error(CLOSED) }));
    look(watch.value);
    watch.start(async (call) => {
      if (call.kind === 'value') look(call.value);
    });
  });
  clearTimeout(timer);
  void watch.stop();
  return outcome;
}

export async function negotiate(
  host: Host<AgentPrincipal>,
  made: Contract,
  context: Context,
  ms = READY_MS
): Promise<Remote> {
  let refusal: ChordError | undefined;
  for (const version of [...historyOf(made)].reverse()) {
    const ref = host.hold(version, {} as never, context) as unknown as Remote;
    const outcome = await binding(ref, context, ms);
    if (outcome.kind === 'live') return bindAt(ref, version);
    ref.release();
    if (outcome.kind === 'failed') throw outcome.error;
    refusal = outcome.error;
    if (refusal.code !== 'contract_mismatch') break;
  }
  return {
    variant: undefined,
    refused: otherService(serviceOf(made), refusal),
    release: () => undefined,
  };
}

export interface Client {
  readonly host: Host<AgentPrincipal>;
  readonly link: PortLink;
  readonly serverId: string;
  readonly context: Context;
  hold(contracts: readonly Contract[]): Promise<Remote[]>;
  follow<T extends object>(member: unknown): State<T>;
  close(): Promise<void>;
}

export async function openClient(endpoint: PortEndpoint): Promise<Client> {
  const link = new PortLink(endpoint, helloOf(), true);
  const hello = await link.peer;
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, BACKGROUND_CONTEXT);
  const host = createHost<AgentPrincipal>({ onError: reportClient });
  await host.load([], context);
  host.connect(link, { principal: SELF }, context);
  const replicas: Replica<unknown>[] = [];
  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    for (const made of replicas) made.stop();
    stop.abort();
    return host.close(BACKGROUND_CONTEXT).catch(() => undefined);
  };
  void link.ended.then(finish);
  return {
    host,
    link,
    serverId: hello.server ?? '',
    context,
    async hold(contracts) {
      const getting = contracts.map((made) => negotiate(host, made, context));
      return Promise.race([Promise.all(getting), ended(link)]);
    },
    follow<T extends object>(member: unknown) {
      const made = replica(member as Parameters<typeof replica<T>>[0], context);
      if (open) replicas.push(made as Replica<unknown>);
      else made.stop();
      return made.state;
    },
    async close() {
      const closing = finish();
      link.close();
      await closing;
    },
  };
}

export const followed = <T extends object>(
  client: Client,
  handle: Remote,
  member: string
): State<T> | undefined => (offers(handle, member) ? client.follow<T>(handle[member]) : undefined);

export async function handshake(
  endpoint: PortEndpoint,
  contracts: readonly Contract[],
  failed: (error: unknown) => unknown = (error) => error
): Promise<{ client: Client; handles: Remote[] }> {
  const client = await openClient(endpoint).catch((error: unknown) => {
    throw failed(error);
  });
  try {
    return { client, handles: await client.hold(contracts) };
  } catch (error) {
    await client.close();
    throw failed(error);
  }
}

export async function connectAgent(
  endpoint: PortEndpoint,
  options: { context?: Context } = {}
): Promise<AgentConnection> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const { client, handles } = await handshake(endpoint, [
    AgentControl,
    AgentTranscript,
    AgentSettings,
    AgentRemoteService,
    AgentPagesService,
    AgentInventoryService,
  ]);
  const [
    controlHandle,
    transcriptHandle,
    settingsHandle,
    remoteHandle,
    pagesHandle,
    inventoryHandle,
  ] = handles as [Remote, Remote, Remote, Remote, Remote, Remote];
  const essential = [controlHandle, transcriptHandle].find((handle) => handle.refused);
  if (essential) {
    await client.close();
    throw essential.refused;
  }
  const control = bound<AgentControl>(controlHandle, CONTROL_METHODS, controlAnswer);
  const settings = lastingSettings(
    bound<AgentSettings>(settingsHandle, OWNER_SETTINGS_METHODS, settingsAnswer),
    followed<SettingsState>(client, settingsHandle, SETTINGS_MEMBER) ??
      createState<SettingsState>({ models: [], accounts: [] })
  );
  const remote = bound<AgentRemote>(remoteHandle, REMOTE_METHODS, remoteAnswer);
  const pages = bound<AgentPages>(pagesHandle, PAGE_METHODS, pageAnswer);
  const state = <T extends object>(name: (typeof TRANSCRIPT_STATES)[number]) =>
    followed<T>(client, transcriptHandle, transcriptMember(name));
  const closed = client.link.ended;
  return {
    serverId: client.serverId,
    readOnly: controlHandle.variant === 'view',
    control,
    transcript: state<ConversationView>('state') as State<ConversationView>,
    deliveries: state<Record<string, Delivered>>('deliveries') as State<Record<string, Delivered>>,
    agents: state<AgentsSummary>('agents'),
    views: state<Record<string, ConversationView>>('views'),
    commands: state<Command[]>('commands'),
    privateRevision: state<PrivateRevision>('privateRevision'),
    sprinkles: state<Sprinkle[]>('sprinkles'),
    memories: state<MemoryEntry[]>('memories'),
    memoryScopes: state<MemoryScope[]>('memoryScopes'),
    frozen: state<FrozenCone[]>('frozen'),
    importing: state<ImportProgress>('importing'),
    changes: state<ChangesView>('changes'),
    monitor: state<MonitorFeed>('monitor'),
    vault: state<VaultState>('vault'),
    labels: state<Record<string, string>>('labels'),
    guests: state<GuestSeat[]>('guests'),
    viewOnly: controlHandle.variant === 'view',
    owner: pagesHandle.variant === 'pages',
    approvals: state<Approval[]>('approvals'),
    approvalPolicy: state<ApprovalPolicy>('approvalPolicy'),
    approvalRunnable: state<Record<string, Runnable>>('approvalRunnable'),
    settings,
    remote,
    history: offers(controlHandle, 'entries'),
    pages,
    ...(inventoryHandle.variant === 'owner'
      ? { inventory: client.follow<InventoryState>(inventoryHandle.inventory) }
      : {}),
    closed,
    webhook(name, delivery) {
      return control.webhook(
        name,
        { id: delivery.id ?? null, headers: delivery.headers ?? {}, body: delivery.body },
        context
      );
    },
    approvalRunNotice(notice) {
      return control.approvalRunNotice(notice, context);
    },
    async prompt(text, whenBusy = 'followUp') {
      const sent = await control.send({ text, whenBusy, requestId: null }, context);
      if (!sent.accepted) throw new Error(`${sent.error.code}: ${sent.error.message}`);
      const settled = await control.wait(sent.submissionId, context);
      if (settled.status !== 'done') throw new Error(`unanswered: ${settled.reason}`);
      return settled.text;
    },
    async close() {
      await client.close();
      await closed;
    },
  };
}
