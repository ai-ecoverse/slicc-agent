import type { Context } from '@earendil-works/chord';
import type { ApprovalDecided, Decider } from '../approvals/index.ts';
import { type ApprovalDecision, answerOf, noApproval } from '../approvals/record.ts';

export interface RemoteDecide {
  id: string;
  answer: string;
  reason: string | null;
  device: string | null;
}

export type RemoteDecided =
  | { ok: true }
  | { ok: false; code: 'EINVAL' | 'ENOENT' | 'EACCES' | 'EOPNOTSUPP'; message: string };

export const BAD_ANSWER = 'An answer is once, always, deny or stop.';

type Decide = (
  id: string,
  decision: ApprovalDecision,
  reason: string | null,
  context: Context
) => Promise<ApprovalDecided>;

const named = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

export function linkDecide(
  decide: (by: Decider) => Decide,
  linked: string | undefined
): (request: RemoteDecide, context: Context) => Promise<RemoteDecided> {
  return async (request, context) => {
    const id = named(request?.id);
    if (!id) return { ok: false, code: 'EINVAL', message: 'An answer needs the approval id.' };
    const answer = answerOf(request.answer);
    if (!answer) return { ok: false, code: 'EINVAL', message: BAD_ANSWER };
    const device = linked ?? named(request.device);
    const reason = typeof request.reason === 'string' ? request.reason : null;
    const by: Decider = { by: 'follower', ...(device ? { device } : {}) };
    const decided = await decide(by)(id, answer, reason, context);
    if (decided.done) return { ok: true };
    const code = decided.error === noApproval(id) ? 'ENOENT' : 'EINVAL';
    return { ok: false, code, message: decided.error };
  };
}
