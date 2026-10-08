import type { Context } from '@earendil-works/chord';
import {
  AgentDoc,
  type ConversationId,
  type DocumentReader,
  type ModelRef,
} from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import type { EnvTargetLike } from '../kernel/env.ts';

export function callerOf(
  agents: Agents | undefined,
  conversation: number | undefined
): string | undefined {
  if (!agents || conversation === undefined) return undefined;
  const state = agents.state();
  const cone = Object.entries(state.cones).find(
    ([, record]) => record.conversation === conversation
  )?.[0];
  if (cone) return `cone:${cone}`;
  return Object.entries(state.scoops).find(
    ([, record]) => record.conversation === conversation
  )?.[0];
}

export function identity(agents: () => Agents | undefined, fallback: ModelRef) {
  return async (target: EnvTargetLike, context: Context): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const caller = callerOf(agents(), target.conversationId);
    if (caller) out.SLICC_AGENT = caller;
    const read = target.read as DocumentReader | undefined;
    const stored =
      read && target.conversationId !== undefined
        ? await read.snapshot(AgentDoc, target.conversationId as ConversationId, context)
        : undefined;
    const model = stored?.model ?? fallback;
    out.PI_PROVIDER = model.provider;
    out.PI_MODEL = model.modelId;
    out.PI_REASONING_LEVEL = stored?.thinkingLevel ?? 'off';
    return out;
  };
}
