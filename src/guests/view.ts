import type { ConversationView, EntryRecord, JsonObject } from '@earendil-works/pi-durable';
import { GUEST_INPUT_KIND } from './attribution.ts';

const SHOWN = new Set([
  'pi.user',
  'pi.assistant',
  'pi.tool-result',
  'pi.compaction',
  'slicc.rewound',
  'slicc.from',
  GUEST_INPUT_KIND,
]);

export const EMPTY_VIEW = {
  conversation: {},
  entries: [],
  docs: {},
} as unknown as ConversationView;

type InboxItem = { mode?: string; entry?: { kind?: string; data?: { seat?: unknown } } };

const own = (seat: string) => (item: InboxItem) =>
  item.entry?.kind === GUEST_INPUT_KIND && item.entry.data?.seat === seat;

export function guestView(view: ConversationView | undefined, seat: string): ConversationView {
  if (!view) return EMPTY_VIEW;
  const docs: Record<string, JsonObject> = {};
  const live = view.docs['pi.live'];
  if (live) docs['pi.live'] = live;
  const agent = view.docs['pi.agent'] as { model?: JsonObject; thinkingLevel?: string } | undefined;
  if (agent)
    docs['pi.agent'] = {
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    };
  const inbox = view.docs['pi.inbox'] as { items?: InboxItem[] } | undefined;
  if (inbox) docs['pi.inbox'] = { items: (inbox.items ?? []).filter(own(seat)) } as JsonObject;
  return {
    conversation: view.conversation,
    entries: view.entries.filter((entry: EntryRecord) => SHOWN.has(entry.kind)),
    docs,
  };
}
