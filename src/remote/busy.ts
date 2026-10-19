import type { Context } from '@earendil-works/chord';
import {
  type CommitPublication,
  type ConversationId,
  type Harness,
  InboxDoc,
  type InboxState,
  LiveDoc,
  type LiveState,
  type SnapshotEvent,
} from '@earendil-works/pi-durable';
import { AgentsDoc, type AgentsState, live } from '../agents.ts';
import { LicksOutbox } from '../licks/licks.ts';
import { coneOf, ScoopWorkDoc } from '../scoops/service.ts';
import type { RemoteEvent } from './events.ts';

export interface BusyState {
  busy: boolean;
  why: string[];
}

type Work = {
  feeds: Record<string, { scoop: string }>;
  waits: Record<string, { cone: string }>;
};

type Outbox = {
  queues: Record<string, { pending: { lick: { channel: string } } | null }>;
};

const KINDS = {
  live: LiveDoc.definition.kind,
  inbox: InboxDoc.definition.kind,
  agents: AgentsDoc.definition.kind,
  work: ScoopWorkDoc.definition.kind,
  outbox: LicksOutbox.definition.kind,
};

function running(value: unknown): boolean {
  return Boolean((value as LiveState | null)?.run);
}

function waiting(value: unknown): boolean {
  return ((value as InboxState | null)?.items ?? []).some((item) => item.mode !== 'write');
}

function mark(set: Set<number>, id: number, on: boolean): void {
  if (on) set.add(id);
  else set.delete(id);
}

export function snapshotBusy(snapshot: SnapshotEvent): boolean {
  return Boolean(snapshot.run) || snapshot.inbox.some((item) => item.mode !== 'write');
}

export class BusyTracker {
  readonly #conversation: number;
  readonly #running = new Set<number>();
  readonly #waiting = new Set<number>();
  #agents: Readonly<AgentsState> | undefined;
  #work: Readonly<Work> | undefined;
  #outbox: Readonly<Outbox> | undefined;
  #cone: string | undefined;

  constructor(conversation: number) {
    this.#conversation = conversation;
  }

  seed(agents: unknown, work: unknown, outbox: unknown): void {
    this.#agents = agents as AgentsState | undefined;
    this.#work = work as Work | undefined;
    this.#outbox = outbox as Outbox | undefined;
    this.#cone = this.#agents ? coneOf(this.#agents, this.#conversation) : undefined;
  }

  conversations(): number[] {
    return [this.#conversation, ...this.#scoops().map(([, record]) => record.conversation)];
  }

  conversation(id: number, live: unknown, inbox: unknown): void {
    mark(this.#running, id, running(live));
    mark(this.#waiting, id, waiting(inbox));
  }

  apply(publication: CommitPublication): boolean {
    let touched = false;
    for (const change of publication.changes) {
      if (change.type !== 'document' || change.record.key !== undefined) continue;
      const { kind } = change.record;
      const id = change.conversationId;
      if (kind === KINDS.live && id !== undefined) mark(this.#running, id, running(change.value));
      else if (kind === KINDS.inbox && id !== undefined)
        mark(this.#waiting, id, waiting(change.value));
      else if (kind === KINDS.agents && id === undefined)
        this.#agents = (change.value ?? undefined) as AgentsState | undefined;
      else if (kind === KINDS.work && id === undefined)
        this.#work = (change.value ?? undefined) as Work | undefined;
      else if (kind === KINDS.outbox && id === undefined)
        this.#outbox = (change.value ?? undefined) as Outbox | undefined;
      else continue;
      touched = true;
    }
    return touched;
  }

  #scoops() {
    const cone = this.#cone;
    if (cone === undefined) return [];
    return Object.entries(this.#agents?.scoops ?? {}).filter(
      ([, record]) => record.cone === cone && live(record)
    );
  }

  #busy(id: number): boolean {
    return this.#running.has(id) || this.#waiting.has(id);
  }

  #lands(target: string, channel: string): number | undefined {
    const state = this.#agents;
    if (!state) return undefined;
    const active = state.cones[state.active]?.conversation;
    if (target === 'cone') return active;
    if (target.startsWith('cone:'))
      return state.cones[target.slice('cone:'.length)]?.conversation ?? active;
    if (channel === 'webhook') return active;
    const scoop = state.scoops[target];
    return scoop && live(scoop) ? scoop.conversation : active;
  }

  #pending(ours: Set<number>): boolean {
    const cone = this.#cone;
    if (cone !== undefined && Object.values(this.#work?.waits ?? {}).some((w) => w.cone === cone))
      return true;
    return Object.entries(this.#outbox?.queues ?? {}).some(([key, queue]) => {
      if (!queue.pending) return false;
      const lands = this.#lands(key.split('|')[0] as string, queue.pending.lick.channel);
      return lands !== undefined && ours.has(lands);
    });
  }

  value(): BusyState {
    const why: string[] = [];
    if (this.#busy(this.#conversation)) why.push('cone');
    const scoops = this.#scoops();
    const feeds = Object.values(this.#work?.feeds ?? {});
    for (const [id, record] of scoops)
      if (this.#busy(record.conversation) || feeds.some((feed) => feed.scoop === id))
        why.push(`scoop:${record.name}`);
    const ours = new Set([this.#conversation, ...scoops.map(([, record]) => record.conversation)]);
    if (this.#pending(ours)) why.push('pending-lick');
    return { busy: why.length > 0, why };
  }
}

export async function trackBusy(
  harness: Harness,
  conversation: number,
  context: Context
): Promise<{ tracker: BusyTracker; listen(listener: () => void): void; stop(): void }> {
  const tracker = new BusyTracker(conversation);
  const buffer: CommitPublication[] = [];
  let ready = false;
  let listener: () => void = () => undefined;
  const stop = harness.subscribeCommits((publication) => {
    if (!ready) buffer.push(publication);
    else if (tracker.apply(publication)) listener();
  });
  try {
    const [agents, work, outbox] = await Promise.all([
      harness.snapshot(AgentsDoc, context),
      harness.snapshot(ScoopWorkDoc, context),
      harness.snapshot(LicksOutbox, context),
    ]);
    tracker.seed(agents, work, outbox);
    await Promise.all(
      tracker.conversations().map(async (id) => {
        const [liveDoc, inboxDoc] = await Promise.all([
          harness.snapshot(LiveDoc, id as ConversationId, context),
          harness.snapshot(InboxDoc, id as ConversationId, context),
        ]);
        tracker.conversation(id, liveDoc, inboxDoc);
      })
    );
  } catch (error) {
    stop();
    throw error;
  }
  for (const publication of buffer.splice(0)) tracker.apply(publication);
  ready = true;
  return {
    tracker,
    listen(next) {
      listener = next;
    },
    stop,
  };
}

export function busyLine(state: BusyState): RemoteEvent {
  return state.busy ? { t: 'busy', busy: true, why: state.why } : { t: 'busy', busy: false };
}

export class BusyGate {
  readonly #tracker: BusyTracker;
  readonly #push: (events: RemoteEvent[]) => void;
  #sent: boolean;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(tracker: BusyTracker, push: (events: RemoteEvent[]) => void, sent: boolean) {
    this.#tracker = tracker;
    this.#push = push;
    this.#sent = sent;
  }

  before(events: RemoteEvent[]): RemoteEvent[] {
    if (this.#sent || !events.some((event) => event.t === 'run' && event.state === 'start'))
      return events;
    this.#sent = true;
    const now = this.#tracker.value();
    return [busyLine(now.busy ? now : { busy: true, why: ['cone'] }), ...events];
  }

  changed(): void {
    if (this.#timer !== undefined || this.#tracker.value().busy === this.#sent) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const now = this.#tracker.value();
      if (now.busy === this.#sent) return;
      this.#sent = now.busy;
      this.#push([busyLine(now)]);
    }, 0);
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export async function watchBusy(
  harness: Harness,
  watched: { conversation: { id: number }; snapshot: SnapshotEvent; stop(): Promise<unknown> },
  push: (events: RemoteEvent[]) => void,
  context: Context
): Promise<{ opened: boolean; gate: BusyGate; stop(): void }> {
  const busy = await trackBusy(harness, watched.conversation.id, context).catch(async (error) => {
    await watched.stop();
    throw error;
  });
  const opened = busy.tracker.value().busy || snapshotBusy(watched.snapshot);
  const gate = new BusyGate(busy.tracker, push, opened);
  busy.listen(() => gate.changed());
  gate.changed();
  return {
    opened,
    gate,
    stop() {
      busy.stop();
      gate.stop();
    },
  };
}
