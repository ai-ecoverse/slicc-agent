import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTask,
  type Extension,
  type NextTaskState,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import type { Approval, Approvals, ApprovalsState } from '../approvals/index.ts';
import { ApprovalsDoc } from '../approvals/record.ts';
import {
  GUEST_INPUT_KIND,
  type GuestInput,
  type GuestOutcome,
  type GuestReviewed,
  guestContent,
  REVIEWED_KIND,
} from './attribution.ts';
import { GUEST_REQUEST } from './guard.ts';
import { type GuestGate, GuestsDoc, liveSeat } from './seats.ts';

export type ReviewState =
  | 'queued'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'unanswered'
  | 'withdrawn';

export type Review = {
  id: string;
  seat: string;
  agentId: string;
  label: string;
  text: string;
  request: string;
  tier: GuestGate;
  tools: GuestGate;
  n: number;
  task: number;
  state: ReviewState;
  reason: string | null;
  createdAt: number;
  decidedAt: number | null;
  submissionId: string | null;
  ended: boolean;
  conversation: number;
  auto?: boolean;
  told?: boolean;
};

export type ReviewsState = { next: number; reviews: Record<string, Review> };

export const GuestReviewsDoc = defineDoc<ReviewsState>({
  kind: 'slicc.guest-reviews',
  version: 1,
  scope: 'session',
  initial: () => ({ next: 1, reviews: {} }),
});

export const GUEST_REVIEWS = 'slicc-guest-reviews';
export const REVIEW_TASK = 'slicc.guest-review';
export const MAX_QUEUED = 8;
export const KEPT_REVIEWS = 100;
export const KEPT_SUBMISSIONS = 100;

export interface ReviewHost {
  approvals: Pick<Approvals, 'request' | 'expire' | 'withdraw'>;
  agents: Pick<Agents, 'conversation'>;
  line<T>(seat: string, run: () => Promise<T>): Promise<T>;
  alwaysAllowed(): boolean;
}

type Input = { review: string };
type Phase =
  | { phase: 'turn'; after?: number }
  | { phase: 'ask' }
  | { phase: 'decide' }
  | { phase: 'deliver' };
type Runtime = TaskRuntime<Input, Phase, null, object>;
type Next = NextTaskState<Phase, null>;

const DONE: Next = { status: 'terminal', outcome: { status: 'completed', result: null } };

export const liveReviews = (state: ReviewsState | null | undefined, seat: string): Review[] =>
  Object.values(state?.reviews ?? {})
    .filter((review) => review.seat === seat && !review.ended)
    .sort((a, b) => a.n - b.n);

export function endReview(review: Review, state: ReviewState, reason: string | null, at: number) {
  review.state = state;
  review.reason = reason;
  review.decidedAt = review.decidedAt ?? at;
  review.ended = true;
}

export async function told(tx: Pick<Tx, 'appendEntry'>, review: Review): Promise<void> {
  if (review.told) return;
  review.told = true;
  const data: GuestReviewed = { review: review.id, outcome: review.state as GuestOutcome };
  await tx.appendEntry(review.conversation as unknown as ConversationId, {
    kind: REVIEWED_KIND,
    data: { ...data },
  });
}

export function pruneReviews(state: ReviewsState, kept = KEPT_REVIEWS) {
  const ended = Object.values(state.reviews)
    .filter((review) => review.ended)
    .sort((a, b) => a.n - b.n);
  for (const review of ended.slice(0, Math.max(0, ended.length - kept)))
    delete state.reviews[review.id];
}

export const deliveryId = (seat: string, review: string): string =>
  `${GUEST_REQUEST}${seat}:${review}`;

const reviewOf = async (tx: Tx, id: string) => (await tx.doc(GuestReviewsDoc)).reviews[id];

const ended = (task: { status: string }) =>
  task.status === 'terminal' || task.status === 'completing';

async function turn(id: string, runtime: Runtime, context: Context) {
  await runtime.commit(async (tx): Promise<Next> => {
    const doc = await tx.doc(GuestReviewsDoc);
    const review = doc.reviews[id];
    if (!review || review.ended) return DONE;
    const seat = (await tx.doc(GuestsDoc)).seats[review.seat];
    if (!liveSeat(seat, runtime.now())) {
      endReview(review, 'withdrawn', 'revoked', runtime.now());
      await told(tx, review);
      return DONE;
    }
    const before = liveReviews(doc, review.seat)
      .filter((other) => other.n < review.n)
      .reverse();
    for (const prior of before) {
      const record = await tx.task(prior.task as unknown as TaskId);
      if (record && !ended(record.state))
        return {
          status: 'waiting',
          checkpoint: { phase: 'turn', after: prior.task },
          on: [prior.task as unknown as TaskId],
          policy: 'allSettled',
        };
      endReview(prior, 'unanswered', 'failed', runtime.now());
      await told(tx, prior);
    }
    return { status: 'running', checkpoint: { phase: 'ask' } };
  }, context);
}

async function ask(id: string, runtime: Runtime, host: ReviewHost, context: Context) {
  const review = (await runtime.snapshot(GuestReviewsDoc, context))?.reviews[id];
  const seat = review && (await runtime.snapshot(GuestsDoc, context))?.seats[review.seat];
  if (seat?.gates.messages === 'off')
    return runtime.commit(async (tx): Promise<Next> => {
      const kept = await reviewOf(tx, id);
      if (!kept || kept.ended) return DONE;
      kept.state = 'approved';
      kept.reason = 'always';
      kept.auto = true;
      kept.decidedAt = runtime.now();
      await told(tx, kept);
      return { status: 'running', checkpoint: { phase: 'deliver' } };
    }, context);
  if (review && !review.ended)
    await host.approvals.request(
      {
        id: review.id,
        kind: 'guest-message',
        seat: review.seat,
        agentId: review.agentId,
        requester: { kind: 'guest', name: review.label, seat: review.seat },
        tier: review.tier,
        detail: { text: review.text, attachments: [] },
      },
      BACKGROUND_CONTEXT
    );
  await runtime.commit(async (tx): Promise<Next> => {
    const kept = await reviewOf(tx, id);
    if (!kept || kept.ended) return DONE;
    kept.state = 'pending';
    return { status: 'running', checkpoint: { phase: 'decide' } };
  }, context);
}

const itemIn = (doc: Readonly<ApprovalsState> | null | undefined, id: string) =>
  doc?.items.find((item) => item.id === id);

async function settledOrDue(
  runtime: Runtime,
  id: string,
  context: Context
): Promise<{ item: Approval | undefined } | null> {
  const { context: using, cancel } = withCancel(context);
  const watch = await runtime.watchDoc(ApprovalsDoc, using);
  try {
    const now = itemIn(watch?.value, id);
    if (now?.state !== 'pending' || now.expiresAt <= runtime.now()) return { item: now };
    const slept = runtime.sleep(now.expiresAt, using);
    slept.catch(() => undefined);
    const changed = new Promise<void>((resolve) => {
      watch?.start(async (value) => {
        if (itemIn(value, id)?.state !== 'pending') resolve();
      });
    });
    await Promise.race([slept, changed]);
    return null;
  } finally {
    cancel();
    await watch?.stop();
  }
}

async function decide(id: string, runtime: Runtime, host: ReviewHost, context: Context) {
  let item: Approval | undefined;
  for (;;) {
    const seen = await settledOrDue(runtime, id, context);
    if (!seen) continue;
    item = seen.item;
    if (item?.state !== 'pending') break;
    item = await host.approvals.expire(id, BACKGROUND_CONTEXT);
    if (item?.state !== 'pending') break;
  }
  const settled = item;
  await runtime.commit(async (tx): Promise<Next> => {
    const review = await reviewOf(tx, id);
    if (!review || review.ended) return DONE;
    const at = settled?.decidedAt ?? runtime.now();
    if (settled?.state === 'approved') {
      review.state = 'approved';
      review.decidedAt = at;
      await told(tx, review);
      if (settled.answer === 'always' && host.alwaysAllowed()) {
        const record = (await tx.doc(GuestsDoc)).seats[review.seat];
        if (record && liveSeat(record, runtime.now())) {
          record.gates.messages = 'off';
          record.always = { by: settled.decidedBy, approval: settled.id, at };
        }
      }
      return { status: 'running', checkpoint: { phase: 'deliver' } };
    }
    endReview(review, settled?.state ?? 'unanswered', settled?.reason ?? null, at);
    await told(tx, review);
    return DONE;
  }, context);
}

async function deliver(id: string, runtime: Runtime, host: ReviewHost, context: Context) {
  const review = (await runtime.snapshot(GuestReviewsDoc, context))?.reviews[id];
  if (!review || review.ended) return runtime.commit(async () => DONE, context);
  await host.line(review.seat, async () => {
    const seat = (await runtime.snapshot(GuestsDoc, context))?.seats[review.seat];
    const live = liveSeat(seat, runtime.now());
    const conversation = live
      ? await host.agents.conversation(review.agentId, BACKGROUND_CONTEXT)
      : undefined;
    const approval = review.auto ? null : review.id;
    const data: GuestInput = { seat: review.seat, name: review.label, approval };
    const submitted = conversation
      ? await conversation.submit(
          {
            type: 'input',
            content: guestContent(review.label, review.text),
            whenBusy: 'followUp',
            entry: { kind: GUEST_INPUT_KIND, data: { ...data } },
            requestId: deliveryId(review.seat, review.id),
          },
          BACKGROUND_CONTEXT
        )
      : undefined;
    await runtime.commit(async (tx): Promise<Next> => {
      const kept = await reviewOf(tx, id);
      if (!kept) return DONE;
      kept.ended = true;
      if (!submitted) {
        kept.reason = live ? 'gone' : 'revoked';
        return DONE;
      }
      kept.submissionId = String(submitted.id);
      const record = (await tx.doc(GuestsDoc)).seats[kept.seat];
      if (record) {
        record.delivered = [...(record.delivered ?? []), kept.id].slice(-KEPT_SUBMISSIONS);
        record.submissions = [
          ...(record.submissions ?? []),
          { id: kept.submissionId, approval, tools: kept.tools },
        ].slice(-KEPT_SUBMISSIONS);
      }
      return DONE;
    }, context);
  });
}

export interface GuestReviews {
  readonly extension: Extension;
  readonly task: ReturnType<typeof reviewTask>;
  bind(host: ReviewHost): void;
}

function reviewTask(lookup: () => Promise<ReviewHost>) {
  return defineTask<Input, Phase, null>({
    name: REVIEW_TASK,
    version: 1,
    initial: () => ({ phase: 'turn' }),
    phases: {
      turn: (task, runtime, context) => turn(task.input.review, runtime, context),
      ask: async (task, runtime, context) =>
        ask(task.input.review, runtime, await lookup(), context),
      decide: async (task, runtime, context) =>
        decide(task.input.review, runtime, await lookup(), context),
      deliver: async (task, runtime, context) =>
        deliver(task.input.review, runtime, await lookup(), context),
    },
    async abort(task, runtime, context) {
      const host = await lookup();
      await host.approvals.withdraw(task.input.review, 'aborted', BACKGROUND_CONTEXT);
      await runtime.commit(async (tx) => {
        const review = await reviewOf(tx, task.input.review);
        if (review && !review.ended) {
          endReview(review, 'withdrawn', 'aborted', runtime.now());
          await told(tx, review);
        }
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context);
    },
  });
}

export function guestReviews(): GuestReviews {
  let bind: (host: ReviewHost) => void;
  const bound = new Promise<ReviewHost>((resolve) => {
    bind = resolve;
  });
  const task = reviewTask(() => bound);
  return {
    extension: defineExtension({ name: GUEST_REVIEWS, tasks: [task] }),
    task,
    bind: (host) => bind(host),
  };
}
