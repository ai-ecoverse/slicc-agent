import type { Context } from '@earendil-works/chord';
import {
  type Conversation,
  defineDoc,
  type Harness,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import {
  formatLick,
  type Lick,
  type LickAction,
  type LickChannel,
  type LickTarget,
  lickId,
} from './lick.ts';
import { entryLick, LICK_STATE_KIND, type LickDecision, lickDecisions } from './state.ts';

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
  eventId?: string;
  at?: number;
}

type Pending = {
  lick: Lick;
  items: string[];
  body: string | null;
};

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
}

export interface LicksHost {
  harness: Harness;
  resolve(target: LickTarget, context: Context): Promise<Conversation>;
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

function merge(pending: Pending, event: LickEvent, now: number): Pending {
  const items = [...pending.items];
  for (const item of event.items ?? []) if (!items.includes(item)) items.push(item);
  return {
    lick: {
      ...pending.lick,
      title: event.title,
      text: event.text,
      count: pending.lick.count + (event.count ?? 1),
      at: event.at ?? now,
    },
    items,
    body: event.body ?? pending.body,
  };
}

function keyOf(event: LickEvent): string {
  const base = `${event.target}|${event.channel}|${event.source}`;
  return event.coalesce === false ? `${base}|${event.eventId ?? lickId()}` : base;
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

  async function queued(harness: Harness, id: number | null, context: Context): Promise<boolean> {
    if (id === null) return false;
    const submission = await harness.submission(id as SubmissionId, context);
    return (await submission?.status(context))?.status === 'queued';
  }

  async function flushKey(key: string, context: Context): Promise<void> {
    const { harness, resolve } = await host;
    const queue = (await harness.snapshot(LicksOutbox, context))?.queues[key];
    if (!queue) return;
    if (await queued(harness, queue.submission, context)) return;
    if (!queue.pending) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(LicksOutbox);
        if (doc.queues[key] && !doc.queues[key].pending) delete doc.queues[key];
      }, context);
      return;
    }
    const lick = render(queue.pending);
    const target = key.split('|')[0] as LickTarget;
    const conversation = await resolve(target, context);
    const submission = await conversation.submit(
      {
        type: 'input',
        content: formatLick(lick),
        whenBusy: 'followUp',
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

  return {
    deliver(event, context) {
      return serial(async () => {
        const { harness } = await host;
        const key = keyOf(event);
        const stream = `${event.channel}|${event.source}`;
        const now = event.at ?? Date.now();
        const accepted = await harness.commit(async (tx) => {
          const doc = await tx.doc(LicksOutbox);
          const seen = doc.events[stream] ?? [];
          if (event.eventId !== undefined) {
            if (seen.includes(event.eventId)) return false;
            doc.events[stream] = [...seen, event.eventId].slice(-MAX_EVENTS);
          }
          const queue = doc.queues[key] ?? { submission: null, pending: null };
          const listed = actions(event.channel);
          queue.pending = queue.pending
            ? merge(queue.pending, event, now)
            : {
                lick: {
                  id: lickId(),
                  channel: event.channel,
                  source: event.source,
                  title: event.title,
                  text: event.text,
                  count: event.count ?? 1,
                  at: now,
                  ...(listed ? { actions: listed } : {}),
                },
                items: [...new Set(event.items ?? [])],
                body: event.body ?? null,
              };
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
    async pending(context) {
      const { harness } = await host;
      const queues = (await harness.snapshot(LicksOutbox, context))?.queues ?? {};
      return Object.values(queues).filter((queue) => queue.submission !== null || queue.pending)
        .length;
    },
  };
}

export { LICK_STATE_KIND };
