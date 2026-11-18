import type { Approval, ApprovalKind } from '../approvals/record.ts';
import { stoppable } from '../approvals/stoppable.ts';
import { verdictOf } from '../approvals/verdict-shown.ts';
import type { AgentsSummary } from '../services.ts';

export interface LinkApproval {
  id: string;
  kind: ApprovalKind;
  agentId?: string;
  agentName?: string;
  requester: { kind: Approval['requester']['kind']; name: string; where?: string };
  detail: Approval['detail'];
  tier: string;
  always: boolean;
  stoppable: boolean;
  verdict?: { level?: 1 | 2 | 3; aligned?: boolean; reason: string };
  judging?: boolean;
  verdictError?: string;
  createdAt: number;
  expiresAt: number;
}

function linked(item: Approval, agentName: string | undefined): LinkApproval {
  const { kind, name, where } = item.requester;
  return {
    id: item.id,
    kind: item.kind,
    ...(item.agentId ? { agentId: item.agentId } : {}),
    ...(agentName ? { agentName } : {}),
    requester: { kind, name, ...(where ? { where } : {}) },
    detail: structuredClone(item.detail),
    tier: item.tier,
    always: item.always === true,
    stoppable: stoppable(item),
    ...verdictOf(item),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export function pendingApprovals(
  items: readonly Approval[] | undefined,
  agents: AgentsSummary | undefined
): LinkApproval[] {
  const names = new Map((agents?.agents ?? []).map((agent) => [agent.id, agent.name]));
  return (items ?? [])
    .filter((item) => item.state === 'pending' && item.tier === 'user')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((item) => linked(item, names.get(item.agentId)));
}
