import type { AgentConnection } from '../client.ts';
import { AgentAdapter } from './agent-port.ts';
import { SettingsAdapter } from './settings-port.ts';

export { AgentAdapter, CONE } from './agent-port.ts';
export { assistant, isBusy, queued, textOf, toMessages } from './messages.ts';
export { SETTINGS_KEY, SettingsAdapter } from './settings-port.ts';

export function createAgentModel(
  connection: AgentConnection,
  options: { storage?: Pick<Storage, 'getItem' | 'setItem'> | null } = {}
): { agent: AgentAdapter; settings: SettingsAdapter } {
  const agent = new AgentAdapter(connection);
  return {
    agent,
    settings: new SettingsAdapter(connection.settings, agent, options.storage ?? null),
  };
}
