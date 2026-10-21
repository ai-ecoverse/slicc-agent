import type { Context } from '@earendil-works/chord';
import { type ConversationId, type Harness, LiveDoc } from '@earendil-works/pi-durable';
import { type AgentsState, live } from '../agents.ts';
import { distinctTaints, type InheritedTaint, runTaints } from '../guests/guard.ts';

type Reader = Pick<Harness, 'submission' | 'snapshot'>;

export interface TaintedCaller {
  fromAgent: boolean;
  cone: string;
  scoop: string | null;
}

function conversations(state: Readonly<AgentsState>): number[] {
  return [
    ...Object.values(state.cones).map((cone) => cone.conversation),
    ...Object.values(state.scoops)
      .filter(live)
      .map((scoop) => scoop.conversation),
  ];
}

export async function callerTaints(
  harness: Reader,
  state: Readonly<AgentsState>,
  who: TaintedCaller,
  claim: string,
  context: Context
): Promise<InheritedTaint[]> {
  if (who.fromAgent) {
    const own = who.scoop
      ? state.scoops[who.scoop]?.conversation
      : state.cones[who.cone]?.conversation;
    if (own === undefined) throw new Error("can't tell which agent run is asking");
    return runTaints(harness, own as ConversationId, context);
  }
  if (claim) throw new Error(`there is no agent ${claim} to ask for`);
  const found: InheritedTaint[] = [];
  for (const conversation of conversations(state)) {
    const id = conversation as ConversationId;
    if ((await harness.snapshot(LiveDoc, id, context))?.run)
      found.push(...(await runTaints(harness, id, context)));
  }
  return distinctTaints(found);
}
