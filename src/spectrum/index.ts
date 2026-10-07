import type { AgentConnection } from '../client.ts';
import { AgentAdapter } from './agent-port.ts';

export { AgentAdapter, CONE } from './agent-port.ts';
export { assistant, isBusy, queued, textOf, toMessages } from './messages.ts';

export function createAgentModel(connection: AgentConnection): { agent: AgentAdapter } {
  return { agent: new AgentAdapter(connection) };
}
