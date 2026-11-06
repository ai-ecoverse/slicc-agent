import type { Context } from '@earendil-works/chord';
import type { Conversation, EntryId, EntryRecord } from '@earendil-works/pi-durable';
import { Mapper, type RemoteEvent } from './events.ts';

export const HISTORY_LIMIT = 50;
export const MAX_HISTORY = 200;
export const HISTORY_SCANS = 10;

export interface EntriesRequest {
  agentId: string | null;
  conversation?: number | null;
  minEntryId?: number | null;
  maxEntryId?: number | null;
  order?: 'ascending' | 'descending';
  limit?: number;
}

export interface EntriesPage {
  conversation: number;
  entries: EntryRecord[];
  more: boolean;
}

export type RemoteHistory =
  | { ok: true; events: RemoteEvent[]; before: string | null; more: boolean }
  | { ok: false; code: string; message: string };

export function bounded(limit: unknown): number {
  const size = Number(limit);
  return Number.isSafeInteger(size) && size > 0 ? Math.min(size, MAX_HISTORY) : HISTORY_LIMIT;
}

const idOf = (value: unknown): EntryId | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? (value as EntryId)
    : undefined;

export async function entriesPage(
  conversation: Conversation,
  request: EntriesRequest,
  context: Context
): Promise<EntriesPage> {
  const id = Number(conversation.id);
  if (typeof request.conversation === 'number' && request.conversation !== id)
    return { conversation: id, entries: [], more: false };
  const min = idOf(request.minEntryId);
  const max = idOf(request.maxEntryId);
  const page = await conversation.entries(
    {
      order: request.order === 'ascending' ? 'ascending' : 'descending',
      ...(min === undefined ? {} : { minEntryId: min }),
      ...(max === undefined ? {} : { maxEntryId: max }),
    },
    bounded(request.limit),
    undefined,
    context
  );
  return { conversation: id, entries: [...page.items], more: page.next !== undefined };
}

export function cursorOf(before: string | null | undefined): number | null | undefined {
  if (before === null || before === undefined) return null;
  return /^\d{1,15}$/.test(before) ? Number(before) : undefined;
}

export function historyFrom(entries: readonly EntryRecord[], before?: EntryId): string | null {
  const newest = entries.at(-1)?.id ?? before;
  return newest === undefined ? null : String(Number(newest) + 1);
}

export async function historyOf(
  conversation: Conversation,
  request: { before: string | null; limit?: number; thinking: boolean },
  context: Context
): Promise<RemoteHistory> {
  const cursor = cursorOf(request.before);
  if (cursor === undefined)
    return { ok: false, code: 'EINVAL', message: `not a history cursor: ${request.before}` };
  const size = bounded(request.limit);
  let oldest = cursor;
  let events: RemoteEvent[] = [];
  let more = oldest === null || oldest > 0;
  for (let scan = 0; scan < HISTORY_SCANS && more && !events.length; scan++) {
    const page = await conversation.entries(
      { order: 'descending', ...(oldest === null ? {} : { maxEntryId: (oldest - 1) as EntryId }) },
      size + 1,
      undefined,
      context
    );
    const items = [...page.items].reverse();
    const primer = items.length > size ? items.shift() : undefined;
    more = primer !== undefined;
    const first = items[0];
    if (!first) break;
    oldest = Number(first.id);
    const mapper = new Mapper(request.thinking, true);
    if (primer) mapper.entry(primer);
    events = items.flatMap((entry) => mapper.entry(entry));
  }
  return { ok: true, events, before: more && oldest !== null ? String(oldest) : null, more };
}
