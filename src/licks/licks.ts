import type { Context } from '@earendil-works/chord';
import {
  type Conversation,
  defineDoc,
  type Harness,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import { distinctTaints, type InheritedTaint, LickTaintDoc } from '../guests/guard.ts';
import { scrubTexts } from '../secrets/scrub.ts';
import {
  clip,
  formatLick,
  type Lick,
  type LickAction,
  type LickChannel,
  type LickSeverity,
  type LickTarget,
  lickId,
} from './lick.ts';
import { entryLick, LICK_STATE_KIND, type LickDecision, lickDecisions } from './state.ts';
import { skipEntry, skips, type Triage, type Verdict } from './triage.ts';

export interface LickEvent {
  channel: LickChannel;
  source: string;
  title: string;
  text: string;
  body?: string;
  items?: string[];
  count?: number;
  target: LickTarget;
  coalesce?: boolean;
  severity?: LickSeverity;
  eventId?: string;
  at?: number;
  triage?: string;
  summary?: string;
  report?: string;
  taints?: readonly InheritedTaint[];
}

function card(event: LickEvent): Pick<Lick, 'summary' | 'report'> {
  return {
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.report ? { report: event.report } : {}),
  };
}

type Pending = {
  lick: Lick;
  items: string[];
  body: string | null;
  taints?: InheritedTaint[];
};

function tainted(taints: readonly InheritedTaint[]): Pick<Pending, 'taints'> {
  return taints.length ? { taints: distinctTaints(taints) } : {};
}

type Queue = {
  submission: number | null;
  pending: Pending | null;
};

type OutboxState = {
  queues: Record<string, Queue>;
  events: Record<string, string[]>;
};

export const LicksOutbox = defineDoc<OutboxState>({
  kind: 'slicc.licks',
  version: 1,
  scope: 'session',
  initial: () => ({ queues: {}, events: {} }),
});

export interface LickHandler {
  confirm?(lick: Lick, reason: string | undefined, context: Context): Promise<string | undefined>;
  dismiss?(lick: Lick, reason: string | undefined, context: Context): Promise<string | undefined>;
}

export interface LickFound {
  lick: Lick;
  decision: LickDecision | undefined;
}

export interface Licks {
  deliver(event: LickEvent, context: Context): Promise<void>;
  flush(context: Context): Promise<void>;
  find(conversation: Conversation, id: string, context: Context): Promise<LickFound | undefined>;
  decide(
    conversation: Conversation,
    id: string,
    action: LickAction,
    reason: string | undefined,
    context: Context
  ): Promise<string>;
  handle(channel: LickChannel, handler: LickHandler): void;
  pending(context: Context): Promise<number>;
  forget(target: LickTarget, channel: LickChannel, source: string, context: Context): Promise<void>;
  guard(check: (target: LickTarget) => Blocked | undefined): void;
  triage(judge: Triage): void;
}

export type Blocked = { id: string; name: string; at: number };

export function frozenNotice(event: LickEvent, blocked: Blocked): LickEvent {
  return {
    channel: event.channel,
    source: `frozen:${event.source}`,
    title: `${blocked.name} is frozen`,
    text: `${event.title} was skipped`,
    body: `${event.target} belongs to ${blocked.name}, which is frozen (${blocked.id}). Thaw it in the Freezer to get its licks again.`,
    target: 'cone',
    severity: 'warn',
    eventId: `${blocked.id}|${event.target}|${event.channel}|${event.source}|${blocked.at}`,
    ...(event.taints ? { taints: event.taints } : {}),
  };
}

export interface LicksHost {
  harness: Harness;
  resolve(target: LickTarget, channel: LickChannel, context: Context): Promise<Conversation>;
  runnable?(conversation: Conversation, context: Context): Promise<boolean>;
}

export const MAX_ITEMS = 50;
export const MAX_EVENTS = 64;

export function render(pending: Pending): Lick {
  const shown = pending.items.slice(0, MAX_ITEMS);
  const more = pending.items.length - shown.length;
  const lines = [
    ...(pending.body ? [pending.body] : []),
    ...shown,
    ...(more > 0 ? [`… and ${more} more`] : []),
  ];
  const { body: _, ...lick } = pending.lick;
  return lines.length ? { ...lick, body: lines.join('\n') } : lick;
}

const RANK: Record<LickSeverity, number> = { warn: 1, error: 2 };

export function strongest(
  a: LickSeverity | undefined,
  b: LickSeverity | undefined
): LickSeverity | undefined {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

function merge(pending: Pending, event: LickEvent, now: number): Pending {
  const items = [...pending.items];
  for (const item of event.items ?? []) if (!items.includes(item)) items.push(item);
  const { severity: _, summary: __, report: ___, ...lick } = pending.lick;
  const severity = strongest(pending.lick.severity, event.severity);
  const taints = tainted([...(pending.taints ?? []), ...(event.taints ?? [])]);
  return {
    lick: {
      ...lick,
      title: event.title,
      text: event.text,
      count: pending.lick.count + (event.count ?? 1),
      at: event.at ?? now,
      ...(severity ? { severity } : {}),
      ...card(event),
    },
    items,
    body: event.body ?? pending.body,
    ...taints,
  };
}

function fresh(event: LickEvent, now: number, listed: LickAction[] | undefined): Pending {
  return {
    lick: {
      id: lickId(),
      channel: event.channel,
      source: event.source,
      title: event.title,
      text: event.text,
      count: event.count ?? 1,
      at: now,
      ...(listed ? { actions: listed } : {}),
      ...(event.severity ? { severity: event.severity } : {}),
      ...card(event),
    },
    items: [...new Set(event.items ?? [])],
    body: event.body ?? null,
    ...tainted(event.taints ?? []),
  };
}

function keyOf(event: LickEvent): string {
  const base = `${event.target}|${event.channel}|${event.source}`;
  return event.coalesce === false ? `${base}|${event.eventId ?? lickId()}` : base;
}

export async function scrubbedLick(event: LickEvent): Promise<LickEvent> {
  const fields = (['title', 'text', 'body', 'triage', 'summary', 'report'] as const).filter(
    (key) => event[key] !== undefined
  );
  const items = event.items ?? [];
  const scrubbed = await scrubTexts([...fields.map((key) => event[key] as string), ...items]);
  const out: LickEvent = { ...event };
  fields.forEach((key, at) => {
    out[key] = scrubbed[at] as string;
  });
  if (event.items) out.items = scrubbed.slice(fields.length);
  if (out.summary !== undefined) out.summary = clip(out.summary);
  return out;
}

async function marked(harness: Harness, pending: Pending, id: string, context: Context) {
  const taints = pending.taints;
  if (!taints) return;
  await harness.commit(async (tx) => {
    (await tx.doc(LickTaintDoc)).licks[id] = taints;
  }, context);
}

export function createLicks(host: Promise<LicksHost>): Licks {
  const handlers = new Map<LickChannel, LickHandler>();
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lock.then(operation, operation);
    lock = run.catch(() => undefined);
    return run;
  };

  const actions = (channel: LickChannel): LickAction[] | undefined => {
    const handler = handlers.get(channel);
    const list: LickAction[] = [];
    if (handler?.confirm) list.push('confirm');
    if (handler?.dismiss) list.push('dismiss');
    return list.length ? list : undefined;
  };

  async function previous(
    harness: Harness,
    id: number | null,
    context: Context
  ): Promise<'queued' | 'withdrawn' | 'gone'> {
    if (id === null) return 'gone';
    const submission = await harness.submission(id as SubmissionId, context);
    const record = await submission?.status(context);
    if (record?.status === 'queued') return 'queued';
    return record?.status === 'unanswered' && record.reason === 'aborted' ? 'withdrawn' : 'gone';
  }

  async function settled(key: string, context: Context): Promise<Queue | undefined> {
    const { harness } = await host;
    const queue = (await harness.snapshot(LicksOutbox, context))?.queues[key];
    if (!queue) return undefined;
    const before = await previous(harness, queue.submission, context);
    if (before === 'queued') return undefined;
    if (queue.pending && before === 'gone') return queue;
    await harness.commit(async (tx) => {
      const doc = await tx.doc(LicksOutbox);
      if (doc.queues[key]?.submission === queue.submission) delete doc.queues[key];
    }, context);
    return undefined;
  }

  async function flushKey(key: string, context: Context): Promise<void> {
    const { harness, resolve, runnable } = await host;
    const queue = await settled(key, context);
    if (!queue?.pending) return;
    const lick = render(queue.pending);
    const target = key.split('|')[0] as LickTarget;
    const conversation = await resolve(target, queue.pending.lick.channel, context);
    if (runnable && !(await runnable(conversation, context))) return;
    await marked(harness, queue.pending, lick.id, context);
    const submission = await conversation.submit(
      {
        type: 'input',
        content: formatLick(lick),
        whenBusy: 'steer',
        requestId: `lick:${lick.id}`,
      },
      context
    );
    await harness.commit(async (tx) => {
      const doc = await tx.doc(LicksOutbox);
      doc.queues[key] = { submission: submission.id, pending: null };
    }, context);
  }

  async function flushAll(context: Context): Promise<void> {
    const { harness } = await host;
    const keys = Object.keys((await harness.snapshot(LicksOutbox, context))?.queues ?? {});
    for (const key of keys) await flushKey(key, context);
  }

  async function find(
    conversation: Conversation,
    id: string,
    context: Context
  ): Promise<LickFound | undefined> {
    const { entries } = await conversation.context(context);
    const lick = entries.map(entryLick).find((candidate) => candidate?.id === id);
    if (!lick) return undefined;
    return { lick, decision: lickDecisions(entries).get(id) };
  }

  async function judged(event: LickEvent, context: Context): Promise<Verdict | undefined> {
    if (!judge || !event.triage) return undefined;
    return judge(event, context).catch(() => undefined);
  }

  async function seenBefore(event: LickEvent, context: Context): Promise<boolean> {
    if (event.eventId === undefined) return false;
    const { harness } = await host;
    const events = (await harness.snapshot(LicksOutbox, context))?.events ?? {};
    return (events[`${event.channel}|${event.source}`] ?? []).includes(event.eventId);
  }

  async function record(event: LickEvent, verdict: Verdict, now: number, context: Context) {
    const conversation = await (await host).resolve(event.target, event.channel, context);
    await conversation.submit(skipEntry(event, verdict, now), context);
  }

  let check: ((target: LickTarget) => Blocked | undefined) | undefined;
  let judge: Triage | undefined;
  return {
    guard(next) {
      check = next;
    },
    triage(next) {
      judge = next;
    },
    async deliver(raw, context) {
      const incoming = await scrubbedLick(raw);
      const blocked = check?.(incoming.target);
      const event = blocked ? frozenNotice(incoming, blocked) : incoming;
      if (judge && event.triage && (await seenBefore(event, context))) return;
      const verdict = await judged(event, context);
      const skipped = skips(verdict);
      return serial(async () => {
        const { harness } = await host;
        const key = keyOf(event);
        await settled(key, context);
        const stream = `${event.channel}|${event.source}`;
        const now = event.at ?? Date.now();
        if (skipped) {
          if (await seenBefore(event, context)) return;
          await record(event, verdict, now, context);
        }
        const accepted = await harness.commit(async (tx) => {
          const doc = await tx.doc(LicksOutbox);
          const seen = doc.events[stream] ?? [];
          if (event.eventId !== undefined) {
            if (seen.includes(event.eventId)) return false;
            doc.events[stream] = [...seen, event.eventId].slice(-MAX_EVENTS);
          }
          if (skipped) return false;
          const queue = doc.queues[key] ?? { submission: null, pending: null };
          queue.pending = queue.pending
            ? merge(queue.pending, event, now)
            : fresh(event, now, actions(event.channel));
          doc.queues[key] = queue;
          return true;
        }, context);
        if (accepted) await flushKey(key, context);
      });
    },
    flush: (context) => serial(() => flushAll(context)),
    find,
    async decide(conversation, id, action, reason, context) {
      const found = await find(conversation, id, context);
      if (!found) throw new Error(`There is no lick ${id} in this conversation.`);
      if (found.decision) throw new Error(`Lick ${id} is already ${found.decision}.`);
      if (!found.lick.actions?.includes(action))
        throw new Error(`Lick ${id} (${found.lick.channel}) has no ${action} action.`);
      const run = handlers.get(found.lick.channel)?.[action];
      if (!run) throw new Error(`Lick ${id} (${found.lick.channel}) has no ${action} action.`);
      return (await run(found.lick, reason, context)) ?? `Lick ${id} ${action}ed.`;
    },
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    forget(target, channel, source, context) {
      return serial(async () => {
        const { harness } = await host;
        const key = `${target}|${channel}|${source}`;
        await harness.commit(async (tx) => {
          const doc = await tx.doc(LicksOutbox);
          const queue = doc.queues[key];
          if (queue?.pending) queue.pending = null;
        }, context);
      });
    },
    async pending(context) {
      const { harness } = await host;
      const queues = (await harness.snapshot(LicksOutbox, context))?.queues ?? {};
      return Object.values(queues).filter((queue) => queue.submission !== null || queue.pending)
        .length;
    },
  };
}

export { LICK_STATE_KIND };
