import { type AttachedReplicatedState, type Context, replicatedState } from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { Agent } from './agent.ts';
import { type AgentsState, live } from './agents.ts';
import type { AgentsSummary } from './services.ts';

export function summarize(state: Readonly<AgentsState>): AgentsSummary {
  const cones = Object.entries(state.cones).map(([id, cone]) => ({
    id,
    name: cone.name,
    kind: 'cone' as const,
    parentId: null,
    role: null,
  }));
  const scoops = Object.entries(state.scoops)
    .filter(([, scoop]) => live(scoop))
    .map(([id, scoop]) => ({
      id,
      name: scoop.name,
      kind: 'scoop' as const,
      parentId: scoop.parent ?? scoop.cone,
      role: scoop.role,
    }));
  return { active: state.active, agents: [...cones, ...scoops] };
}

function wanted(state: Readonly<AgentsState>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, cone] of Object.entries(state.cones)) out.set(id, cone.conversation);
  for (const [id, scoop] of Object.entries(state.scoops))
    if (live(scoop)) out.set(id, scoop.conversation);
  return out;
}

interface Mounted {
  conversation: number;
  attached: AttachedReplicatedState<ConversationView>;
  off: () => void;
}

export async function agentViews(agent: Agent, context: Context) {
  const agents = replicatedState<AgentsSummary>(summarize(agent.agents.state()));
  const views = replicatedState<Record<string, ConversationView>>({});
  const mounted = new Map<string, Mounted>();
  let lock: Promise<unknown> = Promise.resolve();
  const sync = () => {
    lock = lock
      .then(async () => {
        const state = agent.agents.state();
        agents.replace(context, summarize(state));
        const target = wanted(state);
        for (const [id, entry] of [...mounted]) {
          if (target.get(id) === entry.conversation) continue;
          entry.off();
          entry.attached.dispose();
          mounted.delete(id);
          if (!target.has(id))
            views.change(context, (draft) => {
              delete draft[id];
            });
        }
        for (const [id, conversation] of target) {
          if (mounted.has(id)) continue;
          const handle = await agent.agents.conversation(id, context);
          if (!handle) continue;
          const attached = await handle.viewState(context);
          const put = (value: ConversationView) =>
            views.change(context, (draft) => {
              (draft as Record<string, unknown>)[id] = value;
            });
          put(attached.value);
          mounted.set(id, {
            conversation,
            attached,
            off: attached.subscribe((value) => put(value)),
          });
        }
      })
      .catch(() => undefined);
    return lock;
  };
  await sync();
  const offChange = agent.agents.onChange(() => void sync());
  const offCone = agent.agents.onCone(async () => {
    await sync();
  });
  return {
    agents,
    views,
    sync,
    dispose() {
      offChange();
      offCone();
      for (const entry of mounted.values()) {
        entry.off();
        entry.attached.dispose();
      }
      mounted.clear();
    },
  };
}
