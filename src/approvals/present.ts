import type { Context } from '@earendil-works/chord';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { entryLick } from '../licks/state.ts';
import { FROM_KIND, type From } from '../scoops/from.ts';
import type { IntentSources } from './intent.ts';
import { type Approval, personal } from './record.ts';

export const PRESENT_MS = 15 * 60_000;

export interface Attendance {
  attend(): () => void;
  attended(): boolean;
}

export function attendance(): Attendance {
  const links = new Set<symbol>();
  return {
    attend() {
      const link = Symbol('owner device');
      links.add(link);
      return () => void links.delete(link);
    },
    attended: () => links.size > 0,
  };
}

export function ownerSpoke(entries: readonly EntryRecord[]): number {
  const noted = new Set<number>();
  for (const entry of entries) if (entry.kind === FROM_KIND) noted.add((entry.data as From).entry);
  const own = entries.findLast(
    (entry) => entry.kind === 'pi.user' && !noted.has(entry.id) && !entryLick(entry)
  );
  const at = (own?.model?.[0] as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof at === 'number' ? at : 0;
}

export function ownerDecided(items: readonly Approval[], agentId: string): number {
  let last = 0;
  for (const item of items)
    if (item.agentId === agentId && item.decidedBy && personal(item.decidedBy))
      last = Math.max(last, item.decidedAt ?? 0);
  return last;
}

export interface PresenceSources {
  attended(): boolean;
  agents: IntentSources['agents'];
  items(): readonly Approval[];
  now?: () => number;
}

export function ownerPresent(sources: PresenceSources) {
  const now = sources.now ?? Date.now;
  return async (item: Approval, context: Context): Promise<boolean> => {
    if (item.kind !== 'sudo' || !sources.attended()) return false;
    const { requester } = item;
    if (requester.kind === 'user') return Boolean(requester.where);
    if (requester.kind !== 'agent' || !sources.agents.state().cones[item.agentId]) return false;
    const conversation = await sources.agents.conversation(item.agentId, context);
    const spoke = ownerSpoke(conversation ? (await conversation.context(context)).entries : []);
    const seen = Math.max(spoke, ownerDecided(sources.items(), item.agentId));
    return now() - seen <= PRESENT_MS;
  };
}
