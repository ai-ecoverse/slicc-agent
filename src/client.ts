import {
  type Context,
  createHost,
  type Host,
  isChordError,
  type Readable,
  type ReplicatedState,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { ApprovalPolicy } from './approvals/policy.ts';
import type { Approval } from './approvals/record.ts';
import type { ChangesView } from './changes/git.ts';
import type { FrozenCone } from './freezer/index.ts';
import type { GuestSeat } from './guests/seats.ts';
import type { MemoryEntry, MemoryScope } from './memory/format.ts';
import { controlAnswer, pageAnswer, remoteAnswer, settingsAnswer } from './readonly.ts';
import type { AgentRemote } from './remote/host.ts';
import type { AgentPages } from './remote/pages.ts';
import type { VaultState } from './secrets/vault.ts';
import {
  AgentControl,
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
  type MonitorFeed,
  PAGE_METHODS,
  type PrivateRevision,
  REMOTE_METHODS,
  SETTINGS_METHODS,
  type SendMode,
  type SettingsState,
  TRANSCRIPT_STATES,
} from './services.ts';
import { type AgentPrincipal, bound, type Remote, type Root, replicated, SELF } from './serving.ts';
import type { Sprinkle } from './sprinkles/kind.ts';
import { otherVersion, type PortEndpoint, PortLink } from './wire.ts';

export interface AgentConnection {
  readonly serverId: string;
  readonly control: AgentControl;
  readonly transcript: ReplicatedState<ConversationView>;
  readonly deliveries: ReplicatedState<Record<string, Delivered>>;
  readonly agents?: ReplicatedState<AgentsSummary>;
  readonly views?: ReplicatedState<Record<string, ConversationView>>;
  readonly commands?: ReplicatedState<Command[]>;
  readonly privateRevision?: ReplicatedState<PrivateRevision>;
  readonly sprinkles?: ReplicatedState<Sprinkle[]>;
  readonly memories?: ReplicatedState<MemoryEntry[]>;
  readonly memoryScopes?: ReplicatedState<MemoryScope[]>;
  readonly frozen?: ReplicatedState<FrozenCone[]>;
  readonly changes?: ReplicatedState<ChangesView>;
  readonly monitor?: ReplicatedState<MonitorFeed>;
  readonly vault?: ReplicatedState<VaultState>;
  readonly labels?: ReplicatedState<Record<string, string>>;
  readonly guests?: ReplicatedState<GuestSeat[]>;
  readonly viewOnly?: boolean;
  readonly guest?: GuestShown;
  readonly proposals?: ReplicatedState<GuestProposal[]>;
  readonly owner?: boolean;
  readonly approvals?: ReplicatedState<Approval[]>;
  readonly approvalPolicy?: ReplicatedState<ApprovalPolicy>;
  readonly settings: AgentSettings;
  readonly remote?: AgentRemote;
  readonly pages?: AgentPages;
  readonly closed: Promise<Error | undefined>;
  readonly readOnly?: boolean;
  prompt(text: string, whenBusy?: SendMode): Promise<string>;
  webhook(
    name: string,
    delivery: { id?: string | null; headers?: Record<string, string>; body: string }
  ): Promise<{ delivered: boolean }>;
  close(): Promise<void>;
}

export interface Lasting<T> {
  readonly state: ReplicatedState<T>;
  freeze(): void;
}

export function lasting<T>(state: ReplicatedState<T>): Lasting<T> {
  let last: T | undefined;
  let frozen = false;
  const read = () => {
    if (frozen) return last;
    try {
      last = state.value;
    } catch {}
    return last;
  };
  return {
    state: {
      get value() {
        return read();
      },
      subscribe: (listener) => (frozen ? () => undefined : state.subscribe(listener)),
    },
    freeze() {
      read();
      frozen = true;
    },
  };
}

function lastingSettings(
  settings: AgentSettings,
  hold: <T>(state: ReplicatedState<T>) => ReplicatedState<T>
): AgentSettings {
  return {
    state: hold(settings.state),
    connect: (providerId, secret, fields, context) =>
      settings.connect(providerId, secret, fields, context),
    disconnect: (providerId, context) => settings.disconnect(providerId, context),
    signIn: (providerId, context) => settings.signIn(providerId, context),
    dismissMoved: (context) => settings.dismissMoved(context),
  };
}

const VERSIONS = new Set(['upgrade_required', 'contract_mismatch']);

export const final = (error: unknown): unknown =>
  isChordError(error) && VERSIONS.has(error.code) ? otherVersion(error) : error;

export const ended = (link: PortLink): Promise<never> =>
  link.ended.then((reason) => {
    throw reason ?? new Error('the agent closed the link');
  });

type Contract = Parameters<Host<AgentPrincipal>['get']>[0];

export function clientHost(link: PortLink, name: string): Host<AgentPrincipal> {
  const host = createHost<AgentPrincipal>({
    name: `${name}:${crypto.randomUUID()}`,
    kind: 'client',
    self: SELF,
  });
  host.connect(link, { principal: SELF, onProtocolMismatch: () => link.mismatched() });
  return host;
}

export async function holding(
  host: Host<AgentPrincipal>,
  link: PortLink,
  contracts: readonly Contract[]
): Promise<Remote[]> {
  const stop = new AbortController();
  const getting = contracts.map(
    (contract) =>
      host.get(contract, {}, { signal: stop.signal }) as Promise<unknown> as Promise<Remote>
  );
  try {
    return await Promise.race([Promise.all(getting), ended(link)]);
  } catch (error) {
    stop.abort();
    for (const got of getting)
      void got.then(
        (ref) => ref.release(),
        () => undefined
      );
    link.close('handshake failed');
    void host.close().catch(() => undefined);
    throw error;
  }
}

export async function connectAgent(
  endpoint: PortEndpoint,
  options: { context?: Context } = {}
): Promise<AgentConnection> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const link = new PortLink(endpoint);
  const serverId = await link.hello;
  const host = clientHost(link, 'follower');
  const handles = await holding(host, link, [
    AgentControl,
    AgentTranscript,
    AgentSettings,
    AgentRemoteService,
    AgentPagesService,
  ]).catch((error: unknown) => {
    throw final(error);
  });
  const [controlHandle, transcriptHandle, settingsHandle, remoteHandle, pagesHandle] = handles as [
    Remote,
    Remote,
    Remote,
    Remote,
    Remote,
  ];
  const release = () => {
    for (const handle of handles) handle.release();
  };
  const root: Root = (run, rootOptions) => host.root(run, rootOptions);
  const control = bound<AgentControl>(controlHandle, root, CONTROL_METHODS, controlAnswer);
  const members = Object.fromEntries(
    TRANSCRIPT_STATES.map((name) => [name, transcriptHandle[name] as Readable<unknown>])
  ) as Record<(typeof TRANSCRIPT_STATES)[number], Readable<unknown>>;
  const settingsState = settingsHandle.state as Readable<SettingsState>;
  const settings: AgentSettings = {
    ...bound<Omit<AgentSettings, 'state'>>(settingsHandle, root, SETTINGS_METHODS, settingsAnswer),
    state: replicated(settingsState),
  };
  const remote = bound<AgentRemote>(remoteHandle, root, REMOTE_METHODS, remoteAnswer);
  const pages = bound<AgentPages>(pagesHandle, root, PAGE_METHODS, pageAnswer);
  const state = <K extends keyof typeof members>(name: K) =>
    replicated(members[name] as Readable<never>);
  const held: Lasting<unknown>[] = [];
  const hold = <T>(state: ReplicatedState<T>): ReplicatedState<T> => {
    const kept = lasting(state);
    held.push(kept as Lasting<unknown>);
    return kept.state;
  };
  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    for (const kept of held) kept.freeze();
    release();
  };
  const closed = link.ended.then((reason) => {
    finish();
    return reason;
  });
  return {
    serverId,
    readOnly: controlHandle.variant === 'view',
    control,
    transcript: hold<ConversationView>(state('state')),
    deliveries: hold<Record<string, Delivered>>(state('deliveries')),
    agents: hold<AgentsSummary>(state('agents')),
    views: hold<Record<string, ConversationView>>(state('views')),
    commands: hold<Command[]>(state('commands')),
    privateRevision: hold<PrivateRevision>(state('privateRevision')),
    sprinkles: hold<Sprinkle[]>(state('sprinkles')),
    memories: hold<MemoryEntry[]>(state('memories')),
    memoryScopes: hold<MemoryScope[]>(state('memoryScopes')),
    frozen: hold<FrozenCone[]>(state('frozen')),
    changes: hold<ChangesView>(state('changes')),
    monitor: hold<MonitorFeed>(state('monitor')),
    vault: hold<VaultState>(state('vault')),
    labels: hold<Record<string, string>>(state('labels')),
    guests: hold<GuestSeat[]>(state('guests')),
    viewOnly: controlHandle.variant === 'view',
    owner: pagesHandle.variant === 'pages',
    approvals: hold<Approval[]>(state('approvals')),
    approvalPolicy: hold<ApprovalPolicy>(state('approvalPolicy')),
    settings: lastingSettings(settings, hold),
    remote,
    pages,
    closed,
    webhook(name, delivery) {
      return control.webhook(
        name,
        { id: delivery.id ?? null, headers: delivery.headers ?? {}, body: delivery.body },
        context
      );
    },
    async prompt(text, whenBusy = 'followUp') {
      const sent = await control.send({ text, whenBusy, requestId: null }, context);
      if (!sent.accepted) throw new Error(`${sent.error.code}: ${sent.error.message}`);
      const settled = await control.wait(sent.submissionId, context);
      if (settled.status !== 'done') throw new Error(`unanswered: ${settled.reason}`);
      return settled.text;
    },
    async close() {
      finish();
      link.close('closed');
      await closed;
      await host.close();
    },
  };
}
