import type { ConversationView, EntryRecord, JsonObject } from '@earendil-works/pi-durable';
import { withoutIntents } from '../intent/said.ts';
import { GATED_KIND, GUEST_INPUT_KIND, TAINTED_KIND } from './attribution.ts';

const SHOWN = new Set([
  'pi.user',
  'pi.assistant',
  'pi.tool-result',
  'pi.compaction',
  'slicc.rewound',
  'slicc.from',
  GUEST_INPUT_KIND,
  TAINTED_KIND,
  GATED_KIND,
]);

export const EMPTY_VIEW = {
  conversation: {},
  entries: [],
  docs: {},
} as unknown as ConversationView;

type InboxItem = { mode?: string; entry?: { kind?: string; data?: { seat?: unknown } } };

const own = (seat: string) => (item: InboxItem) =>
  item.entry?.kind === GUEST_INPUT_KIND && item.entry.data?.seat === seat;

function shownMessage<T>(message: T): T {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? { ...message, content: withoutIntents(content) } : message;
}

function shownEntry(entry: EntryRecord): EntryRecord {
  if (entry.kind !== 'pi.assistant' || !entry.model) return entry;
  return { ...entry, model: entry.model.map(shownMessage) };
}

function shownLive(live: { generation?: { message?: JsonObject } }) {
  const message = live.generation?.message;
  if (!message) return live;
  return { ...live, generation: { ...live.generation, message: shownMessage(message) } };
}

export function guestView(view: ConversationView | undefined, seat: string): ConversationView {
  if (!view) return EMPTY_VIEW;
  const docs: Record<string, JsonObject> = {};
  const live = view.docs['pi.live'] as { generation?: { message?: JsonObject } } | undefined;
  if (live) docs['pi.live'] = shownLive(live) as JsonObject;
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
    entries: view.entries.filter((entry: EntryRecord) => SHOWN.has(entry.kind)).map(shownEntry),
    docs,
  };
}
