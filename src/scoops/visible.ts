import type { ConversationRecord } from '@earendil-works/pi-durable';
import type { Mark } from '../agents.ts';

export type ReadConversation = (id: number) => Promise<ConversationRecord | undefined>;

export async function visible(
  read: ReadConversation,
  conversation: number,
  mark: Mark
): Promise<boolean> {
  let current = conversation;
  let cap = Number.POSITIVE_INFINITY;
  for (;;) {
    if (current === mark.in) return mark.at <= cap;
    const parent = (await read(current))?.parent;
    if (!parent) return false;
    cap = Math.min(cap, Number(parent.at));
    current = Number(parent.conversationId);
  }
}
