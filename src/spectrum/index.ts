import type { MonitorSection } from '@ai-ecoverse/slicc-spectrum/ui';
import type { AgentConnection } from '../client.ts';
import type { GuestGates } from '../guests/seats.ts';
import { AgentAdapter } from './agent-port.ts';
import { ApprovalsAdapter, type HostApprovals } from './approvals-port.ts';
import { ChangesAdapter } from './changes-port.ts';
import { GuestAdapter, type GuestHub } from './guest-port.ts';
import { MemoryAdapter } from './memory-port.ts';
import { MonitorAdapter } from './monitor-port.ts';
import { type HostNotices, NoticesAdapter } from './notices-port.ts';
import { PageAdapter, type PageOptions } from './page-port.ts';
import { type Login, SettingsAdapter } from './settings-port.ts';
import { SprinkleAdapter } from './sprinkle-port.ts';
import { TrayAdapter } from './tray-port.ts';

export { AgentAdapter, CONE } from './agent-port.ts';
export {
  ApprovalsAdapter,
  type HostApprovals,
  NOT_HERE,
  shown as shownApproval,
} from './approvals-port.ts';
export { ChangesAdapter, type ChangesEvents } from './changes-port.ts';
export {
  GuestAdapter,
  type GuestHub,
  NO_HUB,
  NOT_OWNER_DEVICE,
} from './guest-port.ts';
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
export {
  type HostNotices,
  KEYS_MOVED,
  movedList,
  movedNotice,
  NoticesAdapter,
} from './notices-port.ts';
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

export interface GuestSeatShown {
  id: string;
  label: string;
  agentId: string;
  expiresAt: number | null;
  gates: GuestGates;
}

function seatOf(connection: AgentConnection): { seat?: GuestSeatShown } {
  const guest = connection.guest;
  if (!guest) return {};
  const { id, label, agentId, expiresAt, gates } = guest;
  return { seat: { id, label, agentId, expiresAt, gates: { ...gates } } };
}

export function createAgentModel(
  connection: AgentConnection,
  options: {
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
    login?: Login;
    monitor?: { extra?: () => readonly MonitorSection[] };
    page?: PageOptions;
    guests?: GuestHub;
    approvals?: HostApprovals;
    notices?: HostNotices;
  } = {}
): {
  agent: AgentAdapter;
  approvals: ApprovalsAdapter;
  settings: SettingsAdapter;
  tray: TrayAdapter;
  sprinkles: SprinkleAdapter;
  memory: MemoryAdapter;
  changes: ChangesAdapter;
  monitor: MonitorAdapter;
  notices: NoticesAdapter;
  page: PageAdapter | null;
  guests: GuestAdapter;
  seat?: GuestSeatShown;
} {
  const agent = new AgentAdapter(connection);
  const report = (text: string) => agent.notify(text);
  const run = options.page?.run;
  return {
    agent,
    guests: new GuestAdapter(connection, options.guests ?? null),
    ...seatOf(connection),
    approvals: new ApprovalsAdapter(connection, options.approvals),
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
    notices: new NoticesAdapter(connection.settings, report, options.notices),
    monitor: new MonitorAdapter(
      connection,
      options.monitor?.extra ? { extra: options.monitor.extra } : {}
    ),
  };
}
