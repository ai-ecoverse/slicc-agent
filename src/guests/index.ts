import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type Harness, InboxDoc } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import { scrubText } from '../secrets/scrub.ts';
import type { GuestPrincipal } from '../serving.ts';
import { GUEST_INPUT_KIND, type GuestInput, guestContent } from './attribution.ts';
import {
  checkDraft,
  cleanLabel,
  type GuestDraft,
  type GuestSeat,
  GuestsDoc,
  liveSeat,
  MAX_SEAT_MS,
  type SeatRecord,
} from './seats.ts';

export type GuestOpened = { seat: GuestSeat; error: null } | { seat: null; error: string };

export type Proposed =
  | { state: 'submitted'; submissionId: string; reason: null }
  | { state: 'unanswered'; submissionId: null; reason: string };

export interface ProposeRequest {
  text: string;
  requestId: string | null;
}

export interface Pending {
  seat?: string;
  state: string;
}

export interface Guests {
  readonly seats: ReplicatedState<GuestSeat[]>;
  open(draft: GuestDraft, context: Context): Promise<GuestOpened>;
  revoke(id: string, context: Context): Promise<{ revoked: boolean }>;
  admit(id: string, label: string): GuestPrincipal | null;
  record(id: string): SeatRecord | undefined;
  current(guest: GuestPrincipal): SeatRecord | undefined;
  joined(id: string): () => void;
  onEnd(listener: (id: string) => void): () => void;
  propose(guest: GuestPrincipal, request: ProposeRequest, context: Context): Promise<Proposed>;
  dispose(): void;
}

export interface GuestsOptions {
  harness: Pick<Harness, 'commit' | 'abortSubmission'>;
  agents: Pick<Agents, 'state' | 'conversation'>;
  pending?: ReplicatedState<readonly Pending[]>;
  withdrawSeat?: (seat: string, context: Context) => Promise<unknown>;
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

async function submitGuest(
  record: SeatRecord,
  request: ProposeRequest,
  agents: GuestsOptions['agents'],
  using: Context
): Promise<Proposed> {
  const text = typeof request?.text === 'string' ? request.text.trim() : '';
  if (!text) return unanswered('empty');
  if (text.length > MAX_PROPOSAL) return unanswered('too-long');
  if (record.gates.messages !== 'off') return unanswered('unavailable');
  const conversation = await agents.conversation(record.agentId, using);
  if (!conversation) return unanswered('gone');
  const requestId =
    typeof request.requestId === 'string' && request.requestId.length <= MAX_REQUEST
      ? `guest:${record.id}:${request.requestId}`
      : undefined;
  const data: GuestInput = { seat: record.id, name: record.label, approval: null };
  const submitted = await conversation.submit(
    {
      type: 'input',
      content: guestContent(record.label, await scrubText(text)),
      whenBusy: 'followUp',
      entry: { kind: GUEST_INPUT_KIND, data: { ...data } },
      ...(requestId ? { requestId } : {}),
    },
    using
  );
  return { state: 'submitted', submissionId: String(submitted.id), reason: null };
}

export async function createGuests(options: GuestsOptions): Promise<Guests> {
  const { harness, agents } = options;
  const now = options.now ?? Date.now;
  const context = options.context ?? BACKGROUND_CONTEXT;
  const records: Record<string, SeatRecord> = await harness.commit(
    async (tx) => copy((await tx.doc(GuestsDoc)).seats),
    context
  );
  const links = new Map<string, number>();
  const ended = new Set<(id: string) => void>();
  const gone = new Set<string>();
  const pendingOf = (id: string) =>
    (options.pending?.value ?? []).filter((item) => item.seat === id && item.state === 'pending')
      .length;
  const shown = (): GuestSeat[] =>
    Object.values(records)
      .filter((record) => liveSeat(record, now()))
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
      }));
  const seats = replicatedState<GuestSeat[]>(shown());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (id: string) => {
    if (gone.has(id)) return;
    gone.add(id);
    for (const listener of [...ended]) listener(id);
  };
  const publish = () => {
    const at = now();
    for (const record of Object.values(records)) if (!liveSeat(record, at)) end(record.id);
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
  const offPending = options.pending?.subscribe(() => seats.replace(context, shown()));
  const write = (change: (seats: Record<string, SeatRecord>) => SeatRecord | undefined) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(GuestsDoc);
      const changed = change(doc.seats);
      return changed ? copy(changed) : undefined;
    }, context);
  const current = (guest: GuestPrincipal) => {
    const record = records[guest.id];
    return record && liveSeat(record, now()) && record.epoch === guest.epoch ? record : undefined;
  };
  return {
    seats,
    async open(draft, using) {
      const at = now();
      const problem = checkDraft(draft, at);
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
        record.revoked = at;
        record.epoch += 1;
        return record;
      });
      if (!changed) return { revoked: false };
      records[id] = changed;
      end(id);
      publish();
      await withdrawQueued(harness, agents, changed, using);
      await options.withdrawSeat?.(id, using);
      return { revoked: true };
    },
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
      return record ? submitGuest(record, request, agents, using) : unanswered('revoked');
    },
    dispose() {
      if (timer) clearTimeout(timer);
      offPending?.();
      ended.clear();
    },
  };
}
