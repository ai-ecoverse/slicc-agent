import { defineDoc } from '@earendil-works/pi-durable';
import { boundedDeltas } from '../checkpoints.ts';

export type ApprovalKind = 'guest-message' | 'guest-tool' | 'sudo';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'unanswered' | 'withdrawn';

export type ApprovalTier = 'user' | 'agent' | 'cone' | `scoop:${string}`;

export type ApprovalAnswer = 'once' | 'always' | 'deny';

export type DecidedBy = 'owner' | 'follower' | 'judge' | 'host' | `scoop:${string}`;

export type ApprovalRequester = {
  kind: 'guest' | 'agent' | 'user';
  name: string;
  seat?: string;
  agentId?: string;
  where?: string;
  device?: string;
};

export type ApprovalVerdict = {
  decision: 'allow' | 'deny' | 'unsure';
  reason: string;
  risk?: number;
  aligned?: number;
  model?: string;
};

export type ApprovalAttachment = { name: string; mimeType: string; size: number };

export type GuestMessageDetail = { text: string; attachments: ApprovalAttachment[] };

export type GuestToolDetail = { tool: string; summary: string; arguments?: string; task?: number };

export type SudoDetail = {
  command: string;
  target?: string;
  cwd?: string;
  alwaysScope?: 'cwd';
};

type Base = {
  id: string;
  seat?: string;
  agentId: string;
  requester: ApprovalRequester;
  tier: string;
  state: ApprovalState;
  decidedBy: DecidedBy | null;
  device?: string;
  answer?: 'once' | 'always';
  reviewer?: string;
  reason?: string;
  verdict?: ApprovalVerdict;
  always: boolean;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
};

export type GuestMessageApproval = Base & { kind: 'guest-message'; detail: GuestMessageDetail };
export type GuestToolApproval = Base & { kind: 'guest-tool'; detail: GuestToolDetail };
export type SudoApproval = Base & { kind: 'sudo'; detail: SudoDetail };

export type Approval = GuestMessageApproval | GuestToolApproval | SudoApproval;

type DraftOf<T extends Approval> = Pick<T, 'kind' | 'detail' | 'agentId' | 'requester'> & {
  seat?: string;
  tier: string;
  always?: boolean;
  expiresAt?: number;
};

export type ApprovalDraft =
  | DraftOf<GuestMessageApproval>
  | DraftOf<GuestToolApproval>
  | DraftOf<SudoApproval>;

export type ApprovalsState = { items: Approval[] };

export const ApprovalsDoc = defineDoc<ApprovalsState>({
  kind: 'slicc.approvals',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ items: [] }),
});

export const APPROVAL_MS = 300_000;
export const APPROVALS_KEPT = 100;
export const MAX_DELAY = 2_147_483_647;
export const REASON_LENGTH = 500;

export const REASONS = {
  timeout: 'timeout',
  unknownTier: 'unknown-tier',
  unroutable: 'unroutable',
  unknownAnswer: 'unknown-answer',
  restart: 'restart',
  revoked: 'revoked',
  aborted: 'aborted',
  disconnected: 'disconnected',
  noScoop: 'no-scoop',
  scoopStopped: 'scoop-stopped',
  scoopAsked: 'scoop-asked',
  scoopUndecided: 'scoop-undecided',
} as const;

export const guestKind = (kind: ApprovalKind): boolean => kind !== 'sudo';

export const scoopTier = (tier: unknown): tier is `scoop:${string}` =>
  typeof tier === 'string' && /^scoop:\S+$/.test(tier);

export function knownTier(tier: unknown): tier is ApprovalTier {
  if (tier === 'user' || tier === 'agent' || tier === 'cone') return true;
  return scoopTier(tier);
}

export function routable(kind: ApprovalKind, tier: ApprovalTier): boolean {
  return !(kind === 'guest-tool' && tier === 'cone');
}

export function answerOf(value: unknown): ApprovalAnswer | null {
  return value === 'once' || value === 'always' || value === 'deny' ? value : null;
}

export const personal = (by: DecidedBy): boolean => by === 'owner' || by === 'follower';

export function answerer(by: DecidedBy, item: Pick<Approval, 'tier' | 'reviewer'>): boolean {
  if (personal(by)) return item.tier === 'user';
  if (by === 'judge') return item.tier === 'agent';
  if (scoopTier(by)) return scoopTier(item.tier) && item.reviewer === by;
  return true;
}

export type SudoApprover = 'user' | 'agent';

export const sudoApprover = (value: unknown): SudoApprover =>
  value === 'agent' ? 'agent' : 'user';

export const tierOf = (kind: ApprovalKind, tier: string, sudo: SudoApprover): string =>
  kind === 'sudo' ? sudo : tier;

export function gone(state: ApprovalState): string {
  if (state === 'unanswered') return 'This request timed out.';
  if (state === 'withdrawn') return 'This request was withdrawn.';
  return 'Someone else already answered this.';
}

export function cleanReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const text = reason.trim().slice(0, REASON_LENGTH);
  return text || undefined;
}

const decided = (item: Approval) => item.decidedAt ?? item.createdAt;

export function prune(items: Approval[], kept = APPROVALS_KEPT): Approval[] {
  const settled = items.filter((item) => item.state !== 'pending');
  settled.sort((a, b) => decided(a) - decided(b));
  const drop = new Set(settled.slice(0, Math.max(0, settled.length - kept)));
  return items.filter((item) => !drop.has(item));
}

export type Settle = { state: Exclude<ApprovalState, 'pending'>; by: DecidedBy; reason?: string };

export type Ruling = { error?: string; settle?: Settle; answer?: 'once' | 'always' };

const why = (reason: string | undefined) => (reason ? { reason } : {});

export function ruled(
  item: Approval,
  answer: unknown,
  reason: unknown,
  by: DecidedBy,
  at: number
): Ruling {
  if (item.state !== 'pending') return { error: gone(item.state) };
  if (item.expiresAt <= at)
    return {
      error: gone('unanswered'),
      settle: { state: 'unanswered', by: 'host', reason: REASONS.timeout },
    };
  if (!answerer(by, item)) return { error: "This request isn't yours to answer." };
  const known = answerOf(answer);
  if (known === 'always' && scoopTier(by)) return { error: 'A scoop answers once or deny.' };
  if (known === 'always' && !item.always)
    return { error: "Always isn't offered for this request." };
  if (!known) return { settle: { state: 'rejected', by, reason: REASONS.unknownAnswer } };
  const given = why(cleanReason(reason));
  if (known === 'deny') return { settle: { state: 'rejected', by, ...given } };
  return { settle: { state: 'approved', by, ...given }, answer: known };
}
