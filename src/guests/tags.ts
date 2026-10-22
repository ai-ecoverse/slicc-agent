import type { Context } from '@earendil-works/chord';
import { type ConversationId, defineDoc, type Harness } from '@earendil-works/pi-durable';
import { TAINT_TAG } from '../kernel/sightings.ts';
import { canonical, distinctTaints, type InheritedTaint, runTaints } from './guard.ts';

export const TaintTagDoc = defineDoc<{ tags: Record<string, InheritedTaint[]> }>({
  kind: 'slicc.taint-tags',
  version: 1,
  scope: 'session',
  initial: () => ({ tags: {} }),
});

const keyOf = (taints: readonly InheritedTaint[]) =>
  canonical(
    distinctTaints(taints)
      .map((taint) => [taint.seat, taint.tier])
      .sort()
  );

export function taintTag(
  harness: Pick<Harness, 'commit'>,
  taints: readonly InheritedTaint[],
  context: Context
): Promise<string> {
  const key = keyOf(taints);
  return harness.commit(async (tx) => {
    const doc = await tx.doc(TaintTagDoc);
    const found = Object.entries(doc.tags).find(([, kept]) => keyOf(kept) === key)?.[0];
    if (found) return `${TAINT_TAG}${found}`;
    const id = crypto.randomUUID();
    doc.tags[id] = distinctTaints(taints);
    return `${TAINT_TAG}${id}`;
  }, context);
}

export async function taggedTaints(
  harness: Pick<Harness, 'snapshot'>,
  tags: readonly string[],
  context: Context
): Promise<InheritedTaint[]> {
  const ours = tags.filter((tag) => tag.startsWith(TAINT_TAG));
  if (!ours.length) return [];
  const kept = (await harness.snapshot(TaintTagDoc, context))?.tags ?? {};
  return distinctTaints(
    ours.flatMap((tag) => kept[tag.slice(TAINT_TAG.length)] ?? [{ seat: null, tier: '' }])
  );
}

export function runTag(
  harness: () => Pick<Harness, 'commit' | 'submission' | 'snapshot'> | undefined
) {
  return async (conversationId: number, context: Context): Promise<string | undefined> => {
    const held = harness();
    if (!held) return undefined;
    const taints = await runTaints(held, conversationId as ConversationId, context);
    return taints.length ? taintTag(held, taints, context) : undefined;
  };
}
