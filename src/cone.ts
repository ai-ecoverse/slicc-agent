import type { Context } from '@earendil-works/chord';
import {
  type Conversation,
  type ConversationId,
  defineDoc,
  type Harness,
} from '@earendil-works/pi-durable';

export const ConeDoc = defineDoc<{ conversation: number | null }>({
  kind: 'slicc.cone',
  version: 1,
  scope: 'session',
  initial: () => ({ conversation: null }),
});

export interface Cones {
  cone(): Conversation;
  switchCone(conversation: Conversation, context: Context): Promise<void>;
}

export async function activeCone(
  harness: Harness,
  root: Conversation,
  context: Context
): Promise<Conversation> {
  const id = await harness.commit(async (tx) => (await tx.doc(ConeDoc)).conversation, context);
  const found = id === null ? undefined : await harness.conversation(id as ConversationId, context);
  return found ?? root;
}

export async function pointCone(
  harness: Harness,
  conversation: Conversation,
  context: Context
): Promise<void> {
  await harness.commit(async (tx) => {
    (await tx.doc(ConeDoc)).conversation = conversation.id;
  }, context);
}
