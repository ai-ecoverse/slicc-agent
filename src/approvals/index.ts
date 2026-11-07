import {
  type Context,
  type ReplicatedState,
  replicatedState,
  type WatchHandle,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { Clock } from '../clock.ts';
import {
  type ApprovalJudge,
  ASK_MIN_MS,
  JUDGE_RESTARTED,
  type Judgement,
  type Reasoned,
} from './judge.ts';
import {
  APPROVAL_MS,
  type Approval,
  type ApprovalDraft,
  type ApprovalKind,
  type ApprovalState,
  ApprovalsDoc,
  type ApprovalsState,
  alwaysOffered,
  cleanReason,
  type DecidedBy,
  gateOf,
  guestKind,
  heldKind,
  knownTier,
  MAX_DELAY,
  prune,
  REASONS,
  type Routed,
  routable,
  route,
  ruled,
  type Settle,
  scoopTier,
  sudoApprover,
  tierOf,
} from './record.ts';

export * from './intent.ts';
export * from './judge.ts';
export * from './present.ts';
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
  assign(id: string, reviewer: string, context: Context): Promise<Approval | undefined>;
  withdraw(id: string, reason: string | null, context: Context): Promise<Approval | undefined>;
  withdrawSeat(seat: string, context: Context): Promise<number>;
  expire(id: string, context: Context): Promise<Approval | undefined>;
  close(): void;
}

export interface ScoopRouter {
  route(item: Approval): Promise<void>;
}

export interface ApprovalsAttach {
  harness: Pick<Harness, 'commit' | 'watchDoc'>;
  now?: () => number;
  setTimer?: Clock['setTimer'];
  ttlMs?: number;
  judge?: ApprovalJudge;
  scoops?: ScoopRouter;
  guestAlways?: (kind: ApprovalKind) => boolean;
  sudoApprover?: () => unknown;
  present?: (item: Approval, context: Context) => Promise<boolean>;
}

const copy = (items: readonly Approval[]): Approval[] => JSON.parse(JSON.stringify(items));

function mark(item: Approval, how: Settle, at: number) {
  item.state = how.state;
  item.decidedBy = how.by;
  item.decidedAt = at;
  delete item.judging;
  if (how.reason) item.reason = how.reason;
}

const offered = (options: ApprovalsAttach, draft: ApprovalDraft): boolean =>
  guestKind(draft.kind) && draft.kind !== 'capture'
    ? options.guestAlways?.(draft.kind) === true
    : false;

const judgedKind = (kind: ApprovalKind, tier: string) =>
  kind === 'sudo' || tier === 'agent' || tier === 'user';

function detailOf(draft: ApprovalDraft): ApprovalDraft['detail'] {
  if (draft.kind !== 'sudo' || draft.always !== false) return draft.detail;
  return { ...draft.detail, writable: false };
}

function fresh(
  draft: ApprovalDraft & { id?: string },
  at: number,
  ttl: number,
  options: ApprovalsAttach
): Approval {
  const tier = tierOf(draft.kind, draft.tier, sudoApprover(options.sudoApprover?.()));
  const item = {
    ...draft,
    detail: detailOf(draft),
    tier,
    id: draft.id ?? `apr-${crypto.randomUUID()}`,
    state: 'pending',
    decidedBy: null,
    always: offered(options, draft),
    ...(options.judge && judgedKind(draft.kind, tier) ? { judging: true } : {}),
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

type Judged = { judgement: Judgement; present: boolean; offer?: boolean };

const routeOf = (item: Approval, { judgement, present }: Judged): Routed =>
  route(judgement.verdict, item.requester, gateOf(item.tier), present);

const judgedIn = (id: string, judged: Judged, now: () => number) => (doc: ApprovalsState) => {
  const { judgement } = judged;
  const item = doc.items.find((entry) => entry.id === id);
  if (!item) return undefined;
  const late = item.state === 'unanswered' && item.reason === REASONS.timeout && !item.verdict;
  if (item.state !== 'pending' && !(late && judgement.verdict)) return undefined;
  delete item.judging;
  if (judgement.verdict) item.verdict = judgement.verdict;
  else item.verdictError = judgement.error ?? 'the judge gave no verdict';
  if (late) return copy([item])[0] as Approval;
  const routed = routeOf(item, judged);
  if (routed === 'ask') {
    item.tier = 'user';
    if (item.kind === 'sudo') item.always = alwaysOffered(item);
    if (item.kind === 'capture') item.always = alwaysOffered(item) && judged.offer === true;
    return copy([item])[0] as Approval;
  }
  const at = now();
  const ruling = ruled(item, routed === 'approve' ? 'once' : 'deny', null, 'judge', at);
  if (ruling.answer) item.answer = ruling.answer;
  if (ruling.settle) mark(item, ruling.settle, at);
  return copy([item])[0] as Approval;
};

const reasonIn = (id: string, reasoned: Reasoned) => (doc: ApprovalsState) => {
  const item = doc.items.find((entry) => entry.id === id);
  if (item?.verdict && reasoned.reason) item.verdict.reason = reasoned.reason;
};

const withReason = (judgement: Judgement, reasoned: Reasoned): Judgement => ({
  ...judgement,
  ...(judgement.verdict && reasoned.reason
    ? { verdict: { ...judgement.verdict, reason: reasoned.reason } }
    : {}),
  cost:
    judgement.cost == null && reasoned.cost == null
      ? null
      : (judgement.cost ?? 0) + (reasoned.cost ?? 0),
});

async function judgedBy(
  judge: ApprovalJudge,
  present: ApprovalsAttach['present'],
  item: Approval,
  using: Context,
  now: () => number
): Promise<Judged> {
  const judgement = await judge
    .judge(item, using)
    .catch((error: unknown): Judgement => ({ error: String(error) }));
  if (judgement.verdict?.level !== 3 || !present || item.tier !== 'agent')
    return { judgement, present: false };
  const there = await present(item, using).catch(() => false);
  return { judgement, present: there && item.expiresAt - now() >= ASK_MIN_MS };
}

type Serial = <R>(change: (doc: ApprovalsState) => R, using: Context) => Promise<R>;

function judgeRunner(run: {
  serial: Serial;
  present: ApprovalsAttach['present'];
  guestAlways: ApprovalsAttach['guestAlways'];
  now: () => number;
  closed: () => boolean;
}) {
  const { serial, now } = run;
  return async (judge: ApprovalJudge, item: Approval, using: Context) => {
    const signal = using.abortSignal;
    let gone = false;
    const abort = () => {
      gone = true;
      void serial(
        withdrawIn((entry) => entry.id === item.id && entry.tier === 'agent', REASONS.aborted, now),
        BACKGROUND_CONTEXT
      ).catch(() => undefined);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    let judged = await judgedBy(judge, run.present, item, using, now);
    const pending = judged.judgement.reason;
    const ready = pending ? await Promise.race([pending, Promise.resolve(undefined)]) : undefined;
    const early =
      ready ?? (pending && routeOf(item, judged) === 'deny' ? await pending : undefined);
    if (early) judged = { ...judged, judgement: withReason(judged.judgement, early) };
    signal?.removeEventListener('abort', abort);
    if (gone || run.closed()) return;
    judged = { ...judged, offer: run.guestAlways?.(item.kind) === true };
    const after = await serial(judgedIn(item.id, judged, now), BACKGROUND_CONTEXT).catch(
      () => undefined
    );
    if (!after) return;
    const reasoned = early ? {} : ((await pending) ?? {});
    const final = withReason(judged.judgement, reasoned);
    if (reasoned.reason && !run.closed())
      await serial(reasonIn(item.id, reasoned), BACKGROUND_CONTEXT).catch(() => undefined);
    const recorded = final.verdict ? { ...after, verdict: final.verdict } : after;
    await judge.record?.(recorded, final, BACKGROUND_CONTEXT).catch(() => undefined);
  };
}

function following(
  watch: WatchHandle<Readonly<ApprovalsState>>,
  changed: (using: Context, items: Approval[]) => void
) {
  const items = () => watch.value.items;
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

const systemTimer: Clock['setTimer'] = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export async function attachApprovals(
  options: ApprovalsAttach,
  context: Context = BACKGROUND_CONTEXT
): Promise<Approvals> {
  const { harness } = options;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? APPROVAL_MS;
  const setTimer = options.setTimer ?? systemTimer;
  const timers = new Map<string, () => void>();
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
      if (heldKind(item.kind))
        settle(item, { state: 'withdrawn', by: 'host', reason: REASONS.restart });
      else if (item.expiresAt <= now())
        settle(item, { state: 'unanswered', by: 'host', reason: REASONS.timeout });
      else if (options.judge && item.tier === 'agent') item.tier = 'user';
      if (item.state === 'pending' && item.judging) {
        delete item.judging;
        item.verdictError = JUDGE_RESTARTED;
      }
    }
  }, context);
  const state = replicatedState<Approval[]>(startup.items);
  const watch = await harness.watchDoc(ApprovalsDoc, context);
  if (!watch) throw new Error('approvals document is missing');
  const follow = following(watch, (using, items) => {
    state.replace(using, items);
    arm(items);
  });
  follow(context);
  watch.start(async (call, using) => {
    if (call.kind === 'value') follow(using);
  });
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
        setTimer(() => expire(item.id), Math.min(MAX_DELAY, Math.max(0, item.expiresAt - now())))
      );
    }
    for (const [id, timer] of timers)
      if (!pending.has(id)) {
        timer();
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
  const judging = judgeRunner({
    serial,
    present: options.present,
    guestAlways: options.guestAlways,
    now,
    closed: () => closed,
  });
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
      if (created && options.judge && made.state === 'pending' && judgedKind(made.kind, made.tier))
        void judging(options.judge, made, made.tier === 'agent' ? using : BACKGROUND_CONTEXT);
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
    assign(id, reviewer, using) {
      return serial((doc) => {
        const item = doc.items.find((entry) => entry.id === id);
        if (item?.state === 'pending' && scoopTier(item.tier)) item.reviewer ??= reviewer;
        return item ? (copy([item])[0] as Approval) : undefined;
      }, using);
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
      for (const timer of timers.values()) timer();
      timers.clear();
      void watch.stop();
    },
  };
}
