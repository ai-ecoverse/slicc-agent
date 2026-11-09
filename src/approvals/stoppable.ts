import type { Approval } from './record.ts';

export const stoppable = (item: Approval): boolean =>
  item.kind === 'sudo' && item.requester.kind === 'agent' && Boolean(item.requester.agentId);
