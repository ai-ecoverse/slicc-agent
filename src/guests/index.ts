import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type DocumentState, type Harness, InboxDoc } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import type { Approvals } from '../approvals/index.ts';
import type { ApprovalPolicies } from '../approvals/policy.ts';
import { scrubText } from '../secrets/scrub.ts';
import type { GuestPrincipal } from '../serving.ts';
import {
  ASKED_KIND,
  GUEST_INPUT_KIND,
  type GuestAsked,
  type GuestInput,
  guestContent,
} from './attribution.ts';
import { GUEST_REQUEST } from './guard.ts';
import { DEFAULT_GUEST_POLICY, type GuestPolicy } from './policy.ts';
import {
  endReview,
  type GuestReviews,
  GuestReviewsDoc,
  KEPT_SUBMISSIONS,
  liveReviews,
  MAX_QUEUED,
  pruneReviews,
  type ReviewsState,
  told,
} from './review.ts';
import {
  checkDraft,
  cleanLabel,
  type GuestDraft,
  type GuestSeat,
  GuestsDoc,
  type GuestsState,
  liveSeat,
  MAX_SEAT_MS,
  type SeatRecord,
} from './seats.ts';

export type GuestOpened = { seat: GuestSeat; error: null } | { seat: null; error: string };

export type Proposed =
  | { state: 'submitted'; submissionId: string; reason: null }
  | { state: 'queued'; submissionId: null; review: string; reason: null }
  | { state: 'unanswered'; submissionId: null; reason: string };

export interface ProposeRequest {
  text: string;
  requestId: string | null;
}

export interface Guests {
  readonly seats: ReplicatedState<GuestSeat[]>;
  readonly reviews: ReplicatedState<ReviewsState | null>;
  open(draft: GuestDraft, context: Context): Promise<GuestOpened>;
  revoke(id: string, context: Context): Promise<{ revoked: boolean }>;
  forgetAlways(id: string, approval: string, context: Context): Promise<{ removed: boolean }>;
  admit(id: string, label: string): GuestPrincipal | null;
  record(id: string): SeatRecord | undefined;
  current(guest: GuestPrincipal): SeatRecord | undefined;
  joined(id: string): () => void;
  onEnd(listener: (id: string) => void): () => void;
  propose(guest: GuestPrincipal, request: ProposeRequest, context: Context): Promise<Proposed>;
  policy(): GuestPolicy;
  dispose(): void;
}

export interface GuestsOptions {
  harness: Pick<Harness, 'commit' | 'abortSubmission' | 'documentState'>;
  agents: Pick<Agents, 'state' | 'conversation'>;
  approvals?: Pick<Approvals, 'state' | 'request' | 'withdrawSeat' | 'expire' | 'withdraw'>;
  policy?: Pick<ApprovalPolicies, 'current'>;
  reviews?: Pick<GuestReviews, 'task' | 'bind'>;
  now?: () => number;
  context?: Context;
}

export const MAX_PROPOSAL = 32_000;
const MAX_REQUEST = 128;
const LONGEST_TIMER = 2 ** 31 - 1;

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const unanswered = (reason: string): Proposed => ({
  state: 'unanswered',
  submissionId: null,
  reason,
});

function prune(all: Record<string, SeatRecord>, at: number) {
  for (const [id, record] of Object.entries(all)) {
    const over = record.revoked ?? record.expiresAt;
    if (over !== null && at - over > MAX_SEAT_MS) delete all[id];
  }
}

async function withdrawQueued(
  harness: GuestsOptions['harness'],
  agents: GuestsOptions['agents'],
  record: SeatRecord,
  using: Context
) {
  const conversation = await agents.conversation(record.agentId, using);
  if (!conversation) return;
  const queued = await harness.commit(
    async (tx) =>
      (await tx.doc(InboxDoc, conversation.id)).items
        .filter((item) => {
          const entry = item.entry as { kind?: string; data?: { seat?: unknown } } | undefined;
          return entry?.kind === GUEST_INPUT_KIND && entry.data?.seat === record.id;
        })
        .map((item) => item.id),
    using
  );
  for (const id of queued) await harness.abortSubmission(id, using, conversation.id);
}

async function deliver(
  record: SeatRecord,
  text: string,
  requestId: string,
  options: GuestsOptions,
  using: Context
): Promise<Proposed> {
  const conversation = await options.agents.conversation(record.agentId, using);
  if (!conversation) return unanswered('gone');
  const data: GuestInput = { seat: record.id, name: record.label, approval: null };
  const submitted = await conversation.submit(
    {
      type: 'input',
      content: guestContent(record.label, text),
      whenBusy: 'followUp',
      entry: { kind: GUEST_INPUT_KIND, data: { ...data } },
      requestId,
    },
    using
  );
  const id = String(submitted.id);
  await options.harness.commit(async (tx) => {
    const kept = (await tx.doc(GuestsDoc)).seats[record.id];
    if (!kept || kept.submissions?.some((entry) => entry.id === id)) return;
    kept.submissions = [
      ...(kept.submissions ?? []),
      { id, approval: null, tools: record.gates.tools },
    ].slice(-KEPT_SUBMISSIONS);
  }, using);
  return { state: 'submitted', submissionId: id, reason: null };
}

type Prepared = { text: string; requestId: string };

async function prepare(record: SeatRecord, request: ProposeRequest): Promise<Prepared | Proposed> {
  const text = typeof request?.text === 'string' ? request.text.trim() : '';
  if (!text) return unanswered('empty');
  if (text.length > MAX_PROPOSAL) return unanswered('too-long');
  const asked =
    typeof request.requestId === 'string' &&
    request.requestId &&
    request.requestId.length <= MAX_REQUEST
      ? request.requestId
      : crypto.randomUUID();
  return { text: await scrubText(text), requestId: `${GUEST_REQUEST}${record.id}:${asked}` };
}

async function place(
  record: SeatRecord,
  prepared: Prepared,
  options: GuestsOptions,
  using: Context,
  at: number
): Promise<Proposed> {
  const gate = record.gates.messages;
  if (gate === 'off') return deliver(record, prepared.text, prepared.requestId, options, using);
  const { reviews } = options;
  if (!reviews || !options.approvals) return unanswered('unavailable');
  const conversation = await options.agents.conversation(record.agentId, using);
  if (!conversation) return unanswered('gone');
  return options.harness.commit(async (tx): Promise<Proposed> => {
    const doc = await tx.doc(GuestReviewsDoc);
    const again = Object.values(doc.reviews).find(
      (review) => review.seat === record.id && review.request === prepared.requestId
    );
    if (again) return { state: 'queued', submissionId: null, review: again.id, reason: null };
    if (liveReviews(doc, record.id).length > MAX_QUEUED) return unanswered('overflow');
    const id = `apr-${crypto.randomUUID()}`;
    const task = await tx.createTask(
      reviews.task,
      { review: id },
      { ownership: { kind: 'conversation' }, conversationId: conversation.id, background: true }
    );
    doc.reviews[id] = {
      id,
      seat: record.id,
      agentId: record.agentId,
      label: record.label,
      text: prepared.text,
      request: prepared.requestId,
      tier: gate,
      tools: record.gates.tools,
      n: doc.next,
      task: Number(task),
      state: 'queued',
      reason: null,
      createdAt: at,
      decidedAt: null,
      submissionId: null,
      ended: false,
      conversation: Number(conversation.id),
    };
    doc.next += 1;
    pruneReviews(doc);
    const asked: GuestAsked = {
      seat: record.id,
      name: record.label,
      review: id,
      text: prepared.text,
      at,
    };
    await tx.appendEntry(conversation.id, { kind: ASKED_KIND, data: { ...asked } });
    return { state: 'queued', submissionId: null, review: id, reason: null };
  }, using);
}

function forgotten(
  harness: GuestsOptions['harness'],
  id: string,
  approval: string,
  using: Context
): Promise<{ removed: boolean }> {
  return harness.commit(async (tx) => {
    const record = (await tx.doc(GuestsDoc)).seats[id];
    const kept = record?.alwaysTools?.filter((rule) => rule.approval !== approval);
    if (!record || !kept || kept.length === record.alwaysTools?.length) return { removed: false };
    record.alwaysTools = kept;
    return { removed: true };
  }, using);
}

function keyedLine() {
  const locks = new Map<string, Promise<unknown>>();
  return <T>(id: string, run: () => Promise<T>): Promise<T> => {
    const next = (locks.get(id) ?? Promise.resolve()).then(run, run);
    const settled = next.catch(() => undefined);
    locks.set(id, settled);
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id);
    });
    return next;
  };
}

const pendingIn =
  (approvals: GuestsOptions['approvals'], reviews: DocumentState<ReviewsState>) =>
  (id: string): number =>
    (approvals?.state.value ?? []).filter((item) => item.seat === id && item.state === 'pending')
      .length + liveReviews(reviews.value, id).filter((review) => review.state === 'queued').length;

function shownSeats(
  records: Record<string, SeatRecord>,
  links: ReadonlyMap<string, number>,
  at: number,
  pendingOf: (id: string) => number
): GuestSeat[] {
  return Object.values(records)
    .filter((record) => liveSeat(record, at))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((record) => ({
      id: record.id,
      label: record.label,
      agentId: record.agentId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      gates: { ...record.gates },
      connected: (links.get(record.id) ?? 0) > 0,
      pending: pendingOf(record.id),
      alwaysTools: copy(record.alwaysTools ?? []),
    }));
}

export async function createGuests(options: GuestsOptions): Promise<Guests> {
  const { harness, agents } = options;
  const now = options.now ?? Date.now;
  const context = options.context ?? BACKGROUND_CONTEXT;
  const guestPolicy = () => options.policy?.current().guests ?? DEFAULT_GUEST_POLICY;
  const records: Record<string, SeatRecord> = await harness.commit(async (tx) => {
    await tx.doc(GuestReviewsDoc);
    return copy((await tx.doc(GuestsDoc)).seats);
  }, context);
  const seatsDoc = (await harness.documentState(GuestsDoc, context)) as DocumentState<GuestsState>;
  const reviews = (await harness.documentState(
    GuestReviewsDoc,
    context
  )) as DocumentState<ReviewsState>;
  const links = new Map<string, number>();
  const ended = new Set<(id: string) => void>();
  const gone = new Map<string, Promise<void>>();
  const shown = () => shownSeats(records, links, now(), pendingIn(options.approvals, reviews));
  const seats = replicatedState<GuestSeat[]>(shown());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const locked = keyedLine();
  const cleanup = (record: SeatRecord, using: Context) =>
    locked(record.id, async () => {
      await withdrawQueued(harness, agents, record, using);
      await harness.commit(async (tx) => {
        const doc = await tx.doc(GuestReviewsDoc);
        for (const review of liveReviews(doc, record.id))
          if (review.state === 'queued') {
            endReview(review, 'withdrawn', 'revoked', now());
            await told(tx, review);
          }
      }, using);
      await options.approvals?.withdrawSeat(record.id, using);
    });
  const end = (id: string, using: Context = context): Promise<void> => {
    const going = gone.get(id);
    if (going !== undefined) return going;
    const cleaning = cleanup(records[id] as SeatRecord, using);
    gone.set(id, cleaning);
    for (const listener of [...ended]) listener(id);
    return cleaning;
  };
  const publish = () => {
    const at = now();
    for (const record of Object.values(records))
      if (!liveSeat(record, at)) void end(record.id).catch(() => undefined);
    seats.replace(context, shown());
    if (timer) clearTimeout(timer);
    timer = undefined;
    const next = Math.min(
      ...Object.values(records)
        .filter((record) => liveSeat(record, at) && record.expiresAt !== null)
        .map((record) => record.expiresAt as number)
    );
    if (Number.isFinite(next))
      timer = setTimeout(publish, Math.min(Math.max(0, next - at), LONGEST_TIMER));
  };
  publish();
  const offSeats = seatsDoc.subscribe((value) => {
    for (const id of Object.keys(records)) delete records[id];
    Object.assign(records, copy((value as GuestsState).seats));
    publish();
  });
  const write = (change: (seats: Record<string, SeatRecord>) => SeatRecord | undefined) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(GuestsDoc);
      const changed = change(doc.seats);
      return changed ? copy(changed) : undefined;
    }, context);
  const recount = () => seats.replace(context, shown());
  const offPending = options.approvals?.state.subscribe(recount);
  const offReviews = reviews.subscribe(recount);
  options.reviews?.bind({
    approvals: options.approvals as NonNullable<GuestsOptions['approvals']>,
    agents,
    line: locked,
    alwaysAllowed: () => guestPolicy().always.messages,
  });
  const current = (guest: GuestPrincipal) => {
    const record = records[guest.id];
    return record && liveSeat(record, now()) && record.epoch === guest.epoch ? record : undefined;
  };
  return {
    seats,
    reviews,
    async open(draft, using) {
      const at = now();
      const problem = checkDraft(draft, at, guestPolicy());
      if (problem) return { seat: null, error: problem };
      if (!agents.state().cones[draft.agentId])
        return { seat: null, error: `There is no cone ${draft.agentId}.` };
      const record: SeatRecord = {
        id: draft.id,
        label: cleanLabel(draft.label),
        agentId: draft.agentId,
        expiresAt: draft.expiresAt,
        gates: { messages: draft.gates.messages, tools: draft.gates.tools },
        createdAt: at,
        epoch: 1,
        revoked: null,
      };
      const kept = await harness.commit(async (tx) => {
        const doc = await tx.doc(GuestsDoc);
        if (doc.seats[record.id]) return null;
        prune(doc.seats, at);
        doc.seats[record.id] = copy(record);
        return copy(doc.seats);
      }, using);
      if (!kept) return { seat: null, error: 'That guest seat already exists.' };
      for (const id of Object.keys(records)) delete records[id];
      Object.assign(records, kept);
      publish();
      return { seat: shown().find((seat) => seat.id === record.id) as GuestSeat, error: null };
    },
    async revoke(id, using) {
      const at = now();
      const changed = await write((all) => {
        const record = all[id];
        if (!record || record.revoked !== null) return undefined;
        return Object.assign(record, { revoked: at, epoch: record.epoch + 1, alwaysTools: [] });
      });
      if (!changed) return { revoked: false };
      records[id] = changed;
      const ending = end(id, using);
      publish();
      await ending;
      return { revoked: true };
    },
    forgetAlways: (id, approval, using) => forgotten(harness, id, approval, using),
    admit(id, label) {
      const record = records[id];
      if (!record || !liveSeat(record, now()) || record.label !== cleanLabel(label)) return null;
      return { id: record.id, name: record.label, epoch: record.epoch };
    },
    record: (id) => records[id],
    current,
    joined(id) {
      links.set(id, (links.get(id) ?? 0) + 1);
      seats.replace(context, shown());
      let left = false;
      return () => {
        if (left) return;
        left = true;
        links.set(id, (links.get(id) ?? 1) - 1);
        seats.replace(context, shown());
      };
    },
    onEnd(listener) {
      ended.add(listener);
      return () => ended.delete(listener);
    },
    async propose(guest, request, using) {
      const record = current(guest);
      if (!record) return unanswered('revoked');
      const prepared = await prepare(record, request);
      if ('state' in prepared) return prepared;
      return locked(record.id, async () => {
        const still = current(guest);
        return still ? place(still, prepared, options, using, now()) : unanswered('revoked');
      });
    },
    policy: guestPolicy,
    dispose() {
      if (timer) clearTimeout(timer);
      offPending?.();
      offReviews();
      offSeats();
      seatsDoc.dispose();
      reviews.dispose();
      ended.clear();
    },
  };
}
