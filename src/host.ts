import {
  type Context,
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  replicatedState,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  type RoutedServerServiceHost,
  type RoutedSessionAttachment,
  type RoutedSessionHandle,
  Server,
  type ServerHost,
  SessionNotFoundError,
} from '@earendil-works/pi-server';
import type { Agent } from './agent.ts';
import { createAgentControl } from './control.ts';
import { trackDeliveries } from './deliveries.ts';
import { PortListener } from './listener.ts';
import {
  AGENT_SESSION,
  AgentControl,
  AgentSessions,
  AgentSettings,
  AgentTranscript,
} from './services.ts';
import type { PortEndpoint } from './wire.ts';

export interface AgentHost {
  readonly serverId: string;
  readonly agent: Agent;
  connect(endpoint: PortEndpoint): void;
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

function sessionServices(provider: RemoteServiceProvider): RoutedSessionHandle {
  return {
    attachClient: () => endpointFor(provider),
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
};

export async function hostAgent(
  agent: Agent,
  options: { serverId?: string; context?: Context; settings?: AgentSettings } = {}
): Promise<AgentHost> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const serverId = options.serverId ?? crypto.randomUUID();
  const state = await agent.root.viewState(context);
  const provider = new RemoteServiceProvider([
    { service: AgentControl, mode: 'singleton' },
    { service: AgentTranscript, mode: 'singleton' },
    { service: AgentSettings, mode: 'singleton' },
  ]);
  const deliveries = trackDeliveries(agent.harness, state, context);
  provider.provide(AgentControl, createAgentControl(agent.harness, agent.root, deliveries));
  provider.provide(AgentTranscript, { state, deliveries: deliveries.state });
  provider.provide(AgentSettings, options.settings ?? noSettings);
  const host: ServerHost = {
    serverServices: serverServices(),
    async resolveSession(sessionId) {
      if (sessionId !== AGENT_SESSION)
        throw new SessionNotFoundError(`unknown session ${sessionId}`);
      return { id: sessionId };
    },
    openSession: async () => sessionServices(provider),
  };
  const listener = new PortListener(serverId);
  const server = await new Server(host, { serverId, listeners: [listener] }).start();
  return {
    serverId,
    agent,
    connect: (endpoint) => listener.connect(endpoint),
    async close() {
      await server.close();
      provider.dispose();
      deliveries.dispose();
      state.dispose();
      await agent.close();
    },
  };
}
