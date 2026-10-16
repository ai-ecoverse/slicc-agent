import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { DocumentState, Harness } from '@earendil-works/pi-durable';
import type { ApprovalJudge, Judgement } from './judge.ts';
import {
  APPROVAL_MS,
  type Approval,
  type ApprovalDraft,
  type ApprovalKind,
  type ApprovalState,
  ApprovalsDoc,
  type ApprovalsState,
  cleanReason,
  type DecidedBy,
  guestKind,
  knownTier,
  MAX_DELAY,
  prune,
  REASONS,
  routable,
  ruled,
  type Settle,
  scoopTier,
  sudoApprover,
  tierOf,
} from './record.ts';

export * from './intent.ts';
export * from './judge.ts';
export * from './record.ts';

export type ApprovalDecided =
  | { done: true; state: ApprovalState; error: null }
  | { done: false; state: null; error: string };

export type Decider = DecidedBy | { by: DecidedBy; device?: string };

const deciderOf = (decider: Decider) => (typeof decider === 'string' ? { by: decider } : decider);

export interface Approvals {
  readonly state: ReplicatedState<Approval[]>;
  request(draft: ApprovalDraft & { id?: string }, context: Context): Promise<Approval>;
  decide(
    id: string,
    answer: unknown,
    reason: string | null,
    by: Decider,
    context: Context
  ): Promise<ApprovalDecided>;
  settled(id: string, context: Context): Promise<Approval>;
  withdraw(id: string, reason: string | null, context: Context): Promise<Approval | undefined>;
  withdrawSeat(seat: string, context: Context): Promise<number>;
  expire(id: string, context: Context): Promise<Approval | undefined>;
  close(): void;
}

export interface ScoopRouter {
  route(item: Approval): Promise<void>;
}

export interface ApprovalsAttach {
  harness: Pick<Harness, 'commit' | 'documentState'>;
  now?: () => number;
  ttlMs?: number;
  judge?: ApprovalJudge;
  scoops?: ScoopRouter;
  guestAlways?: (kind: ApprovalKind) => boolean;
  sudoApprover?: () => unknown;
}

const copy = (items: readonly Approval[]): Approval[] => JSON.parse(JSON.stringify(items));

function mark(item: Approval, how: Settle, at: number) {
  item.state = how.state;
  item.decidedBy = how.by;
  item.decidedAt = at;
  if (how.reason) item.reason = how.reason;
}

const offered = (options: ApprovalsAttach, draft: ApprovalDraft): boolean =>
  guestKind(draft.kind) ? options.guestAlways?.(draft.kind) === true : draft.always === true;

function fresh(
  draft: ApprovalDraft & { id?: string },
  at: number,
  ttl: number,
  options: ApprovalsAttach
): Approval {
  const item = {
    ...draft,
    tier: tierOf(draft.kind, draft.tier, sudoApprover(options.sudoApprover?.())),
    id: draft.id ?? `apr-${crypto.randomUUID()}`,
    state: 'pending',
    decidedBy: null,
    always: offered(options, draft),
    createdAt: at,
    expiresAt: draft.expiresAt ?? at + ttl,
  } as Approval;
  if (!knownTier(item.tier))
    mark(item, { state: 'unanswered', by: 'host', reason: REASONS.unknownTier }, at);
  else if (!routable(draft.kind, item.tier))
    mark(item, { state: 'unanswered', by: 'host', reason: REASONS.unroutable }, at);
  return item;
}

const withdrawIn =
  (match: (item: Approval) => boolean, reason: string | undefined, now: () => number) =>
  (doc: ApprovalsState) => {
    const hit = doc.items.filter((item) => item.state === 'pending' && match(item));
    for (const item of hit)
      mark(item, { state: 'withdrawn', by: 'host', ...(reason ? { reason } : {}) }, now());
    return hit.map((item) => copy([item])[0] as Approval);
  };

const judgedIn = (id: string, judgement: Judgement, now: () => number) => (doc: ApprovalsState) => {
  const item = doc.items.find((entry) => entry.id === id);
  if (item?.tier !== 'agent') return undefined;
  const late = item.state === 'unanswered' && item.reason === REASONS.timeout && !item.verdict;
  if (item.state !== 'pending' && !(late && judgement.verdict)) return undefined;
  if (judgement.verdict) item.verdict = judgement.verdict;
  if (late) return copy([item])[0] as Approval;
  if (judgement.outcome === 'ask') item.tier = 'user';
  else {
    const at = now();
    const ruling = ruled(
      item,
      judgement.outcome === 'approve' ? 'once' : 'deny',
      null,
      'judge',
      at
    );
    if (ruling.answer) item.answer = ruling.answer;
    if (ruling.settle) mark(item, ruling.settle, at);
  }
  return copy([item])[0] as Approval;
};

function following(
  committed: DocumentState<ApprovalsState>,
  changed: (using: Context, items: Approval[]) => void
) {
  const items = () => (committed.value as ApprovalsState).items;
  let shown = items();
  return (using: Context) => {
    const now = items();
    if (now === shown) return;
    shown = now;
    changed(using, copy(now));
  };
}

function settledIn(
  state: ReplicatedState<Approval[]>,
  id: string,
  using: Context
): Promise<Approval> {
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
}

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
  const settle = (item: Approval, how: Settle) => mark(item, how, now());
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
      else if (options.judge && item.tier === 'agent') item.tier = 'user';
    }
  }, context);
  const state = replicatedState<Approval[]>(startup.items);
  const committed = (await harness.documentState(
    ApprovalsDoc,
    context
  )) as DocumentState<ApprovalsState>;
  const follow = following(committed, (using, items) => {
    state.replace(using, items);
    arm(items);
  });
  committed.subscribe((_value, using) => follow(using));
  const serial = <R>(change: (doc: ApprovalsState) => R, using: Context): Promise<R> => {
    const run = line.then(async () => {
      const { result } = await write(change, using);
      follow(using);
      return result;
    });
    line = run.catch(() => undefined);
    return run;
  };
  const expire = (id: string) => {
    timers.delete(id);
    const due = (state.value as Approval[]).find((entry) => entry.id === id);
    if (due?.state === 'pending' && due.expiresAt > now()) return arm(state.value as Approval[]);
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
        setTimeout(() => expire(item.id), Math.min(MAX_DELAY, Math.max(0, item.expiresAt - now())))
      );
    }
    for (const [id, timer] of timers)
      if (!pending.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
  }
  arm(startup.items);
  const toScoop = (item: Approval) => {
    if (options.scoops && item.state === 'pending' && scoopTier(item.tier))
      void options.scoops.route(item).catch(() => undefined);
  };
  for (const item of startup.items) toScoop(item);
  const withdrawWhere = (match: (item: Approval) => boolean, reason: string | undefined) =>
    withdrawIn(match, reason, now);
  const judging = async (judge: ApprovalJudge, item: Approval, using: Context) => {
    const signal = using.abortSignal;
    let gone = false;
    const abort = () => {
      gone = true;
      void serial(
        withdrawWhere((entry) => entry.id === item.id && entry.tier === 'agent', REASONS.aborted),
        BACKGROUND_CONTEXT
      ).catch(() => undefined);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    const judgement = await judge
      .judge(item, using)
      .catch((error: unknown): Judgement => ({ outcome: 'ask', error: String(error) }));
    signal?.removeEventListener('abort', abort);
    if (gone || closed) return;
    const after = await serial(judgedIn(item.id, judgement, now), BACKGROUND_CONTEXT).catch(
      () => undefined
    );
    if (after) await judge.record?.(after, judgement, BACKGROUND_CONTEXT).catch(() => undefined);
  };
  return {
    state,
    async request(draft, using) {
      let created = true;
      const made = await serial((doc) => {
        const kept = draft.id && doc.items.find((entry) => entry.id === draft.id);
        if (kept) {
          created = false;
          return copy([kept])[0] as Approval;
        }
        const item = fresh(draft, now(), ttl, options);
        doc.items.push(item);
        return copy([item])[0] as Approval;
      }, using);
      if (created && options.judge && made.state === 'pending' && made.tier === 'agent')
        void judging(options.judge, made, using);
      if (created) toScoop(made);
      return made;
    },
    decide(id, answer, reason, decider, using) {
      const { by, device } = deciderOf(decider);
      return serial((doc): ApprovalDecided => {
        const item = doc.items.find((entry) => entry.id === id);
        const ruling = item
          ? ruled(item, answer, reason, by, now())
          : { error: `There is no approval ${id}.` };
        if (item && ruling.settle) {
          if (ruling.answer) item.answer = ruling.answer;
          if (device && ruling.settle.by === by) item.device = device;
          settle(item, ruling.settle);
        }
        if ('error' in ruling && ruling.error)
          return { done: false, state: null, error: ruling.error };
        return { done: true, state: (item as Approval).state, error: null };
      }, using);
    },
    settled: (id, using) => settledIn(state, id, using),
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
    async expire(id, using) {
      return serial((doc) => {
        const item = doc.items.find((entry) => entry.id === id);
        if (item?.state === 'pending' && item.expiresAt <= now())
          settle(item, { state: 'unanswered', by: 'host', reason: REASONS.timeout });
        return item ? (copy([item])[0] as Approval) : undefined;
      }, using);
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
