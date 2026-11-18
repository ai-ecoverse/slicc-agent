import type { Context } from '@earendil-works/chord/context';
import { awaitWithContext, BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  type Extension,
  type Harness,
  type HookApi,
  hook,
  type ToolHookCall,
  ToolTask,
} from '@earendil-works/pi-durable';
import { AgentsDoc, type AgentsState } from '../agents.ts';
import { boundedDeltas } from '../checkpoints.ts';
import {
  argumentsHash,
  canonical,
  runTaints,
  scrubbedArguments,
  summaryOf,
  taskWatcher,
} from '../guests/guard.ts';
import type { AlwaysTool, ShownAlwaysTool } from '../guests/seats.ts';
import { withoutIntent } from '../intent/said.ts';
import type { Approvals } from './index.ts';
import { ApprovalPolicyDoc, type OwnerTools, resolvedPolicy } from './policy.ts';
import { type Approval, REASONS } from './record.ts';

export const OWNER_GUARD = 'slicc-owner-tool-gate';
export const OWNER_TOOL_MEMO = 'slicc.owner-tool';

export const OWNER_REASONS = {
  rejected: 'The owner declined this tool call.',
  judged: 'The automatic check declined this tool call',
  unanswered: 'Nobody approved this tool call in time.',
  withdrawn: 'The review of this tool call was withdrawn.',
} as const;

export const OwnerAlwaysDoc = defineDoc<{ tools: AlwaysTool[] }>({
  kind: 'slicc.owner-always',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ tools: [] }),
});

export interface OwnerGateHost {
  approvals: Pick<Approvals, 'state' | 'request' | 'settled' | 'withdraw'>;
  tools(): OwnerTools;
  now?: () => number;
}

export interface OwnerToolGate {
  readonly extension: Extension;
  bind(host: OwnerGateHost): void;
}

type Held = Pick<Harness, 'submission' | 'commit' | 'waitForTask' | 'snapshot'>;

export function ownerReasonOf(item: Approval): string {
  if (item.state === 'rejected' && item.decidedBy === 'judge')
    return item.verdict
      ? `${OWNER_REASONS.judged}: ${item.verdict.reason}`
      : `${OWNER_REASONS.judged}.`;
  if (item.state === 'rejected')
    return item.reason && item.reason !== REASONS.unknownAnswer
      ? `${OWNER_REASONS.rejected} ${item.reason}`
      : OWNER_REASONS.rejected;
  if (item.state === 'withdrawn') return OWNER_REASONS.withdrawn;
  return OWNER_REASONS.unanswered;
}

export function agentOf(
  state: Readonly<AgentsState> | undefined,
  conversationId: ConversationId
): { agentId: string; name: string } | undefined {
  const id = Number(conversationId);
  for (const [agentId, cone] of Object.entries(state?.cones ?? {}))
    if (cone.conversation === id) return { agentId, name: cone.name };
  for (const [agentId, scoop] of Object.entries(state?.scoops ?? {}))
    if (scoop.conversation === id) return { agentId, name: scoop.name };
  return undefined;
}

export async function ownerAlways(
  harness: Pick<Harness, 'snapshot'>,
  context: Context
): Promise<ShownAlwaysTool[]> {
  const rules = (await harness.snapshot(OwnerAlwaysDoc, context))?.tools ?? [];
  return rules.map(({ argumentsHash: _hash, ...rule }) => rule);
}

export function ownerAlwaysForget(
  harness: Pick<Harness, 'commit'>,
  approval: string,
  context: Context
): Promise<{ removed: boolean }> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(OwnerAlwaysDoc);
    const kept = doc.tools.filter((rule) => rule.approval !== approval);
    if (kept.length === doc.tools.length) return { removed: false };
    doc.tools = kept;
    return { removed: true };
  }, context);
}

async function storedTier(api: HookApi, context: Context): Promise<OwnerTools> {
  const overrides = (await api.snapshot(ApprovalPolicyDoc, context))?.overrides ?? {};
  return resolvedPolicy(overrides).owner.tools;
}

export function ownerToolGate(harness: () => Held | undefined): OwnerToolGate {
  let current: OwnerGateHost | undefined;
  let resolveHost: (host: OwnerGateHost) => void = () => {};
  const bound = new Promise<OwnerGateHost>((resolve) => {
    resolveHost = resolve;
  });
  const watch = taskWatcher(harness);
  const remember = (rule: AlwaysTool) =>
    (harness() as Held).commit(async (tx) => {
      const doc = await tx.doc(OwnerAlwaysDoc);
      const kept = doc.tools.filter(
        (entry) => entry.tool !== rule.tool || entry.argumentsHash !== rule.argumentsHash
      );
      doc.tools = [...kept, rule];
    }, BACKGROUND_CONTEXT);
  const review = async (
    call: ToolHookCall,
    api: HookApi,
    context: Context
  ): Promise<string | undefined> => {
    const agent = agentOf(await api.snapshot(AgentsDoc, context), api.conversationId);
    if (!agent) return undefined;
    const held = harness() as Held;
    if ((await runTaints(held, api.conversationId, context)).length) return undefined;
    const host = await awaitWithContext(bound, context);
    const tier = host.tools();
    if (tier === 'off') return undefined;
    const now = host.now ?? Date.now;
    const args = withoutIntent(call.name, call.arguments);
    const hash = await argumentsHash(canonical(args));
    const rules = (await api.snapshot(OwnerAlwaysDoc, context))?.tools ?? [];
    if (rules.some((rule) => rule.tool === call.name && rule.argumentsHash === hash))
      return undefined;
    const id = await api.memo<string>(OWNER_TOOL_MEMO, `apr-${crypto.randomUUID()}`, context);
    const task = Number(api.taskId);
    const shown = await scrubbedArguments(args);
    const asked = await host.approvals.request(
      {
        id,
        kind: 'owner-tool',
        agentId: agent.agentId,
        requester: { kind: 'agent', name: agent.name, agentId: agent.agentId },
        tier,
        detail: {
          tool: call.name,
          summary: summaryOf(shown),
          arguments: canonical(shown),
          task,
        },
      },
      BACKGROUND_CONTEXT
    );
    watch(host, id, task);
    const item = asked.state === 'pending' ? await host.approvals.settled(id, context) : asked;
    if (item.state !== 'approved') return ownerReasonOf(item);
    if (item.answer === 'always')
      await remember({
        approval: item.id,
        tool: call.name,
        argumentsHash: hash,
        arguments: canonical(shown),
        by: item.decidedBy,
        at: item.decidedAt ?? now(),
      });
    return undefined;
  };
  return {
    extension: defineExtension({
      name: OWNER_GUARD,
      hooks: [
        hook(ToolTask, {
          async beforeTool(call, api, context) {
            const tier = current ? current.tools() : await storedTier(api, context);
            if (tier === 'off') return undefined;
            const block = await review(call, api, context);
            return block ? { block } : undefined;
          },
        }),
      ],
    }),
    bind(host) {
      current = host;
      resolveHost(host);
      for (const item of host.approvals.state.value ?? [])
        if (item.kind === 'owner-tool' && item.state === 'pending' && item.detail.task)
          watch(host, item.id, item.detail.task);
    },
  };
}
