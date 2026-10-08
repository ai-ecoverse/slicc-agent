import type { Context } from '@earendil-works/chord';
import { type Conversation, defineDoc } from '@earendil-works/pi-durable';

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
