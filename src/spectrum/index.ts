import type { AgentConnection } from '../client.ts';
import { AgentAdapter } from './agent-port.ts';
import { ChangesAdapter } from './changes-port.ts';
import { MemoryAdapter } from './memory-port.ts';
import { type Login, SettingsAdapter } from './settings-port.ts';
import { SprinkleAdapter } from './sprinkle-port.ts';
import { TrayAdapter } from './tray-port.ts';

export { AgentAdapter, CONE } from './agent-port.ts';
export { ChangesAdapter, type ChangesEvents, type RepoChange } from './changes-port.ts';
export { MemoryAdapter } from './memory-port.ts';
export {
  assistant,
  errorAction,
  errorPart,
  isBusy,
  queued,
  textOf,
  toMessages,
} from './messages.ts';
export { type Login, SETTINGS_KEY, SettingsAdapter } from './settings-port.ts';
export { SprinkleAdapter } from './sprinkle-port.ts';
export { TrayAdapter } from './tray-port.ts';

export function createAgentModel(
  connection: AgentConnection,
  options: {
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
    login?: Login;
  } = {}
): {
  agent: AgentAdapter;
  settings: SettingsAdapter;
  tray: TrayAdapter;
  sprinkles: SprinkleAdapter;
  memory: MemoryAdapter;
  changes: ChangesAdapter;
} {
  const agent = new AgentAdapter(connection);
  return {
    agent,
    settings: new SettingsAdapter(
      connection.settings,
      agent,
      options.storage ?? null,
      options.login ?? null
    ),
    tray: new TrayAdapter(connection.settings),
    sprinkles: new SprinkleAdapter(connection),
    memory: new MemoryAdapter(connection),
    changes: new ChangesAdapter(connection),
  };
}
