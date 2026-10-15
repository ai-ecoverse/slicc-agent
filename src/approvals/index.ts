import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import {
  APPROVAL_MS,
  type Approval,
  type ApprovalDraft,
  type ApprovalState,
  ApprovalsDoc,
  type ApprovalsState,
  cleanReason,
  type DecidedBy,
  guestKind,
  knownTier,
  prune,
  REASONS,
  routable,
  ruled,
  type Settle,
} from './record.ts';

export * from './record.ts';

export type ApprovalDecided =
  | { done: true; state: ApprovalState; error: null }
  | { done: false; state: null; error: string };

export interface Approvals {
  readonly state: ReplicatedState<Approval[]>;
  request(draft: ApprovalDraft, context: Context): Promise<Approval>;
  decide(
    id: string,
    answer: unknown,
    reason: string | null,
    by: DecidedBy,
    context: Context
  ): Promise<ApprovalDecided>;
  settled(id: string, context: Context): Promise<Approval>;
  withdraw(id: string, reason: string | null, context: Context): Promise<Approval | undefined>;
  withdrawSeat(seat: string, context: Context): Promise<number>;
  close(): void;
}

export interface ApprovalsAttach {
  harness: Pick<Harness, 'commit'>;
  now?: () => number;
  ttlMs?: number;
}

const copy = (items: readonly Approval[]): Approval[] => JSON.parse(JSON.stringify(items));

export async function attachApprovals(
  options: ApprovalsAttach,
  context: Context = BACKGROUND_CONTEXT
): Promise<Approvals> {
  const { harness } = options;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? APPROVAL_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let line: Promise<unknown> = Promise.resolve();
  let closed = false;
  const settle = (item: Approval, how: Settle) => {
    item.state = how.state;
    item.decidedBy = how.by;
    item.decidedAt = now();
    if (how.reason) item.reason = how.reason;
  };
  const write = <R>(
    change: (doc: ApprovalsState) => R,
    using: Context
  ): Promise<{ result: R; items: Approval[] }> =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(ApprovalsDoc);
      const result = change(doc);
      doc.items = prune(doc.items);
      return { result, items: copy(doc.items) };
    }, using);
  const startup = await write((doc) => {
    for (const item of doc.items) {
      if (item.state !== 'pending') continue;
      if (item.kind === 'sudo')
        settle(item, { state: 'withdrawn', by: 'host', reason: REASONS.restart });
      else if (item.expiresAt <= now())
        settle(item, { state: 'unanswered', by: 'host', reason: REASONS.timeout });
    }
  }, context);
  const state = replicatedState<Approval[]>(startup.items);
  const serial = <R>(change: (doc: ApprovalsState) => R, using: Context): Promise<R> => {
    const run = line.then(async () => {
      const { result, items } = await write(change, using);
      state.replace(using, items);
      arm(items);
      return result;
    });
    line = run.catch(() => undefined);
    return run;
  };
  const expire = (id: string) => {
    timers.delete(id);
    void serial((doc) => {
      const item = doc.items.find((entry) => entry.id === id);
      if (item?.state === 'pending' && item.expiresAt <= now())
        settle(item, { state: 'unanswered', by: 'host', reason: REASONS.timeout });
    }, BACKGROUND_CONTEXT).catch(() => undefined);
  };
  function arm(items: readonly Approval[]) {
    const pending = new Set<string>();
    for (const item of items) {
      if (item.state !== 'pending') continue;
      pending.add(item.id);
      if (timers.has(item.id) || closed) continue;
      timers.set(
        item.id,
        setTimeout(() => expire(item.id), Math.max(0, item.expiresAt - now()))
      );
    }
    for (const [id, timer] of timers)
      if (!pending.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
  }
  arm(startup.items);
  const withdrawWhere =
    (match: (item: Approval) => boolean, reason: string | undefined) => (doc: ApprovalsState) => {
      const hit = doc.items.filter((item) => item.state === 'pending' && match(item));
      for (const item of hit)
        settle(item, { state: 'withdrawn', by: 'host', ...(reason ? { reason } : {}) });
      return hit.map((item) => copy([item])[0] as Approval);
    };
  return {
    state,
    request(draft, using) {
      return serial((doc) => {
        const at = now();
        const item = {
          ...draft,
          id: `apr-${crypto.randomUUID()}`,
          state: 'pending',
          decidedBy: null,
          always: guestKind(draft.kind) ? false : draft.always === true,
          createdAt: at,
          expiresAt: draft.expiresAt ?? at + ttl,
        } as Approval;
        if (!knownTier(draft.tier))
          settle(item, { state: 'unanswered', by: 'host', reason: REASONS.unknownTier });
        else if (!routable(draft.kind, draft.tier))
          settle(item, { state: 'unanswered', by: 'host', reason: REASONS.unroutable });
        doc.items.push(item);
        return copy([item])[0] as Approval;
      }, using);
    },
    decide(id, answer, reason, by, using) {
      return serial((doc): ApprovalDecided => {
        const item = doc.items.find((entry) => entry.id === id);
        const ruling = item
          ? ruled(item, answer, reason, by, now())
          : { error: `There is no approval ${id}.` };
        if (item && ruling.settle) {
          if (ruling.answer) item.answer = ruling.answer;
          settle(item, ruling.settle);
        }
        if ('error' in ruling && ruling.error)
          return { done: false, state: null, error: ruling.error };
        return { done: true, state: (item as Approval).state, error: null };
      }, using);
    },
    settled(id, using) {
      return new Promise((resolve, reject) => {
        const signal = using.abortSignal;
        let done = false;
        let off: (() => void) | undefined;
        const finish = (end: () => void) => {
          done = true;
          off?.();
          signal?.removeEventListener('abort', abort);
          end();
        };
        const abort = () => finish(() => reject(signal?.reason));
        const check = (items: readonly Approval[] | undefined) => {
          const item = items?.find((entry) => entry.id === id);
          if (!item) finish(() => reject(new Error(`There is no approval ${id}.`)));
          else if (item.state !== 'pending') finish(() => resolve(item));
        };
        if (signal?.aborted) return abort();
        check(state.value);
        if (done) return;
        signal?.addEventListener('abort', abort, { once: true });
        off = state.subscribe((items) => check(items));
      });
    },
    async withdraw(id, reason, using) {
      const [hit] = await serial(
        withdrawWhere((item) => item.id === id, cleanReason(reason)),
        using
      );
      return hit;
    },
    async withdrawSeat(seat, using) {
      return (
        await serial(
          withdrawWhere((item) => item.seat === seat, REASONS.revoked),
          using
        )
      ).length;
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
