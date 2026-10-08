import {
  type Context,
  createRemoteServiceBinding,
  type ReplicatedState,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import type { ConversationView } from '@earendil-works/pi-durable';
import {
  AGENT_SESSION,
  AgentControl,
  AgentSessions,
  AgentSettings,
  type AgentsSummary,
  AgentTranscript,
  type Delivered,
  type SendMode,
} from './services.ts';
import { PortChannel, type PortEndpoint } from './wire.ts';

export interface AgentConnection {
  readonly serverId: string;
  readonly control: AgentControl;
  readonly transcript: ReplicatedState<ConversationView>;
  readonly deliveries: ReplicatedState<Record<string, Delivered>>;
  readonly agents?: ReplicatedState<AgentsSummary>;
  readonly views?: ReplicatedState<Record<string, ConversationView>>;
  readonly settings: AgentSettings;
  prompt(text: string, whenBusy?: SendMode): Promise<string>;
  close(): Promise<void>;
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
  const { state: transcript, deliveries, agents, views } = session.use(AgentTranscript);
  const settings = session.use(AgentSettings);
  await session.ready(context);
  return {
    serverId,
    control,
    transcript,
    deliveries,
    agents,
    views,
    settings,
    async prompt(text, whenBusy = 'followUp') {
      const sent = await control.send({ text, whenBusy, requestId: null }, context);
      if (!sent.accepted) throw new Error(`${sent.error.code}: ${sent.error.message}`);
      const settled = await control.wait(sent.submissionId, context);
      if (settled.status !== 'done') throw new Error(`unanswered: ${settled.reason}`);
      return settled.text;
    },
    async close() {
      await server.use(AgentSessions).detach(context);
      await session.dispose(context);
      await server.dispose(context);
      await client.dispose();
    },
  };
}
