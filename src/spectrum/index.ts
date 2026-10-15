import type { MonitorSection } from '@ai-ecoverse/slicc-spectrum/ui';
import type { AgentConnection } from '../client.ts';
import { AgentAdapter } from './agent-port.ts';
import { ChangesAdapter } from './changes-port.ts';
import { MemoryAdapter } from './memory-port.ts';
import { MonitorAdapter } from './monitor-port.ts';
import { NoticesAdapter } from './notices-port.ts';
import { PageAdapter, type PageOptions } from './page-port.ts';
import { type Login, SettingsAdapter } from './settings-port.ts';
import { SprinkleAdapter } from './sprinkle-port.ts';
import { TrayAdapter } from './tray-port.ts';

export { AgentAdapter, CONE } from './agent-port.ts';
export { ChangesAdapter, type ChangesEvents } from './changes-port.ts';
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
export {
  MonitorAdapter,
  type MonitorAdapterOptions,
  type MonitorInput,
  monitorSnapshot,
} from './monitor-port.ts';
export { KEYS_MOVED, movedNotice, NoticesAdapter } from './notices-port.ts';
export {
  PageAdapter,
  type PageDocument,
  type PageOptions,
  type PageRun,
  type PageTarget,
} from './page-port.ts';
export { type Login, SETTINGS_KEY, SettingsAdapter } from './settings-port.ts';
export { SprinkleAdapter } from './sprinkle-port.ts';
export { TrayAdapter } from './tray-port.ts';

export function createAgentModel(
  connection: AgentConnection,
  options: {
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
    login?: Login;
    monitor?: { extra?: () => readonly MonitorSection[] };
    page?: PageOptions;
  } = {}
): {
  agent: AgentAdapter;
  settings: SettingsAdapter;
  tray: TrayAdapter;
  sprinkles: SprinkleAdapter;
  memory: MemoryAdapter;
  changes: ChangesAdapter;
  monitor: MonitorAdapter;
  notices: NoticesAdapter;
  page: PageAdapter | null;
} {
  const agent = new AgentAdapter(connection);
  const report = (text: string) => agent.notify(text);
  const run = options.page?.run;
  return {
    agent,
    page: options.page && run ? new PageAdapter(connection, agent, { ...options.page, run }) : null,
    settings: new SettingsAdapter(
      connection.settings,
      agent,
      options.storage ?? null,
      options.login ?? null
    ),
    tray: new TrayAdapter(connection.settings),
    sprinkles: new SprinkleAdapter(connection, report),
    memory: new MemoryAdapter(connection, report),
    changes: new ChangesAdapter(connection, report),
    notices: new NoticesAdapter(connection.settings, report),
    monitor: new MonitorAdapter(
      connection,
      options.monitor?.extra ? { extra: options.monitor.extra } : {}
    ),
  };
}
