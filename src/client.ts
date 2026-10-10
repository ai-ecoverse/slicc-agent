import {
  type Context,
  createRemoteServiceBinding,
  type ReplicatedState,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { ChangesView } from './changes/git.ts';
import type { FrozenCone } from './freezer/index.ts';
import type { MemoryEntry, MemoryScope } from './memory/format.ts';
import {
  AGENT_SESSION,
  AgentControl,
  AgentSessions,
  AgentSettings,
  type AgentsSummary,
  AgentTranscript,
  type Command,
  type Delivered,
  type SendMode,
} from './services.ts';
import type { Sprinkle } from './sprinkles/kind.ts';
import { PortChannel, type PortEndpoint } from './wire.ts';

export interface AgentConnection {
  readonly serverId: string;
  readonly control: AgentControl;
  readonly transcript: ReplicatedState<ConversationView>;
  readonly deliveries: ReplicatedState<Record<string, Delivered>>;
  readonly agents?: ReplicatedState<AgentsSummary>;
  readonly views?: ReplicatedState<Record<string, ConversationView>>;
  readonly commands?: ReplicatedState<Command[]>;
  readonly sprinkles?: ReplicatedState<Sprinkle[]>;
  readonly memories?: ReplicatedState<MemoryEntry[]>;
  readonly memoryScopes?: ReplicatedState<MemoryScope[]>;
  readonly frozen?: ReplicatedState<FrozenCone[]>;
  readonly changes?: ReplicatedState<ChangesView>;
  readonly settings: AgentSettings;
  readonly closed: Promise<Error | undefined>;
  prompt(text: string, whenBusy?: SendMode): Promise<string>;
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
    connect: (providerId, secret, region, context) =>
      settings.connect(providerId, secret, region, context),
    disconnect: (providerId, context) => settings.disconnect(providerId, context),
    signIn: (providerId, context) => settings.signIn(providerId, context),
  };
}

function attached(client: Client): Promise<void> {
  return new Promise((resolve) => {
    const stop = client.onAttachmentChange(() => {
      stop();
      resolve();
    });
  });
}

export async function connectAgent(
  endpoint: PortEndpoint,
  options: { context?: Context } = {}
): Promise<AgentConnection> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const channel = new PortChannel(endpoint);
  const serverId = await channel.hello;
  const client = await Client.connect({ serverId, transportFactory: channel.transport });
  const server = createRemoteServiceBinding({
    services: [AgentSessions],
    transport: createClientServiceTransport(client, () => ({ serverId })),
    bound: true,
  });
  const ready = attached(client);
  await server.use(AgentSessions).attach(AGENT_SESSION, context);
  await ready;
  const session = createRemoteServiceBinding({
    services: [AgentControl, AgentTranscript, AgentSettings],
    transport: createClientServiceTransport(client, () => client.attachment),
    bound: true,
  });
  const control = session.use(AgentControl);
  const {
    state: transcript,
    deliveries,
    agents,
    views,
    commands,
    sprinkles,
    memories,
    memoryScopes,
    frozen,
    changes,
  } = session.use(AgentTranscript);
  const settings = session.use(AgentSettings);
  await session.ready(context);
  const held: Lasting<unknown>[] = [];
  const hold = <T>(state: ReplicatedState<T>): ReplicatedState<T> => {
    const kept = lasting(state);
    held.push(kept as Lasting<unknown>);
    return kept.state;
  };
  const freeze = () => {
    for (const kept of held) kept.freeze();
  };
  const closed = channel.ended.then((reason) => {
    freeze();
    return reason;
  });
  return {
    serverId,
    control,
    transcript: hold(transcript),
    deliveries: hold(deliveries),
    agents: hold(agents),
    views: hold(views),
    commands: hold(commands),
    sprinkles: hold(sprinkles),
    memories: hold(memories),
    memoryScopes: hold(memoryScopes),
    frozen: hold(frozen),
    changes: hold(changes),
    settings: lastingSettings(settings, hold),
    closed,
    async prompt(text, whenBusy = 'followUp') {
      const sent = await control.send({ text, whenBusy, requestId: null }, context);
      if (!sent.accepted) throw new Error(`${sent.error.code}: ${sent.error.message}`);
      const settled = await control.wait(sent.submissionId, context);
      if (settled.status !== 'done') throw new Error(`unanswered: ${settled.reason}`);
      return settled.text;
    },
    async close() {
      freeze();
      await server.use(AgentSessions).detach(context);
      await session.dispose(context);
      await server.dispose(context);
      await client.dispose();
    },
  };
}
