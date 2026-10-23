import type { Context } from '@earendil-works/chord';
import {
  AgentDoc,
  type AgentState,
  type ConversationId,
  type ConversationInit,
  type Cursor,
  defineDoc,
  type Harness,
  type HarnessOptions,
  type Storage,
} from '@earendil-works/pi-durable';
import { boundedDeltas } from './checkpoints.ts';

export type Choosable = (tool: string) => boolean;

type Field = keyof AgentState;

export const SELECTION: readonly Field[] = ['extensions', 'tools', 'modelTools', 'instructions'];

const ALL: readonly Field[] = ['model', 'thinkingLevel', 'cwd', ...SELECTION];

export const SelectionDoc = defineDoc<{ version: number }>({
  kind: 'slicc.selection',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ version: 0 }),
});

export const SELECTION_VERSION = 1;

export async function storedAgent(
  harness: Pick<Harness, 'snapshot'>,
  conversationId: ConversationId,
  context: Context
): Promise<AgentState> {
  return structuredClone((await harness.snapshot(AgentDoc, conversationId, context)) ?? {});
}

export function copyAgent(from: AgentState, fields: readonly Field[] = ALL): ConversationInit {
  return async (tx, conversationId) => {
    const agent = (await tx.doc(AgentDoc, conversationId)) as Record<string, unknown>;
    for (const field of fields) {
      const value = from[field];
      if (value === undefined) delete agent[field];
      else agent[field] = structuredClone(value);
    }
  };
}

export function unfrozen(agent: AgentState, choosable: Choosable): boolean {
  let changed = false;
  if (Array.isArray(agent.extensions)) {
    delete agent.extensions;
    changed = true;
  }
  if (Array.isArray(agent.tools) && !agent.tools.every(choosable)) {
    delete agent.tools;
    changed = true;
  }
  return changed;
}

export function unfreezeCreated(choosable: Choosable): HarnessOptions['conversationCreated'] {
  return async (tx, conversation) => {
    unfrozen(await tx.doc(AgentDoc, conversation.id), choosable);
  };
}

export async function unfreeze(
  harness: Pick<Harness, 'snapshot' | 'commit'>,
  storage: Pick<Storage, 'scanConversations'>,
  choosable: Choosable,
  context: Context
): Promise<number> {
  const done = await harness.snapshot(SelectionDoc, context);
  if ((done?.version ?? 0) >= SELECTION_VERSION) return 0;
  let fixed = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, 100, cursor, context);
    for (const record of page.items)
      if (
        await harness.commit(
          async (tx) => unfrozen(await tx.doc(AgentDoc, record.id), choosable),
          context
        )
      )
        fixed++;
    cursor = page.next;
  } while (cursor);
  await harness.commit(async (tx) => {
    (await tx.doc(SelectionDoc)).version = SELECTION_VERSION;
  }, context);
  return fixed;
}
