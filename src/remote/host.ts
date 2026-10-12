import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type EntryRecord,
  type Harness,
  type SnapshotEvent,
  type SubmissionId,
  watchEvents,
} from '@earendil-works/pi-durable';
import type { Delivered, SendMode, SendRequest, SendResponse } from '../services.ts';
import { type EndReason, idOf, Mapper, type RemoteEvent, replayOf } from './events.ts';

export const MAX_QUEUED = 10000;
export const IDLE_MS = 120000;

export type RemoteOpened =
  | { ok: true; stream: string; delivered: Delivered | null; head: string | null; gap: boolean }
  | { ok: false; code: string; message: string };

export interface RemoteBatch {
  events: RemoteEvent[];
  done: boolean;
}

export interface AgentRemote {
  prompt(
    request: { agentId: string | null; text: string; whenBusy: SendMode; thinking: boolean },
    context: Context
  ): Promise<RemoteOpened>;
  watch(
    request: { agentId: string | null; since: string | null; thinking: boolean },
    context: Context
  ): Promise<RemoteOpened>;
  next(stream: string, waitMs: number, context: Context): Promise<RemoteBatch>;
  close(stream: string, context: Context): Promise<void>;
  abort(agentId: string | null, context: Context): Promise<{ aborted: boolean }>;
}

export interface RemoteHost {
  harness: Harness;
  conversation(agentId: string | null, context: Context): Promise<Conversation>;
  send(request: SendRequest, context: Context): Promise<SendResponse>;
  now?: () => number;
  limit?: number;
  sweepMs?: number;
}

export class Stream<T = RemoteEvent> {
  readonly queue: T[] = [];
  done = false;
  touched: number;
  #wake: (() => void) | undefined;
  readonly #stop: () => Promise<unknown>;
  readonly #limit: number;
  readonly #overflow: readonly T[];

  constructor(stop: () => Promise<unknown>, now: number, limit: number, overflow: readonly T[]) {
    this.#stop = stop;
    this.touched = now;
    this.#limit = limit;
    this.#overflow = overflow;
  }

  push(events: readonly T[]): void {
    if (this.done || !events.length) return;
    this.queue.push(...events);
    if (this.queue.length > this.#limit) {
      this.queue.length = 0;
      this.queue.push(...this.#overflow);
      void this.finish();
    }
    this.#wake?.();
  }

  async finish(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.#wake?.();
    await this.#stop().catch(() => undefined);
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.queue.length || this.done) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      this.#wake = () => {
        this.#wake = undefined;
        done();
      };
    });
  }
}

function deliveredOf(
  status: { status: string } | undefined,
  whenBusy: SendMode,
  busy: boolean
): Delivered {
  if (status?.status === 'queued') return whenBusy === 'followUp' ? 'follow-up' : 'steer';
  return busy ? 'steer' : 'run';
}

function headOf(events: readonly RemoteEvent[]): string | null {
  for (let at = events.length - 1; at >= 0; at--) {
    const id = idOf(events[at] as RemoteEvent);
    if (id) return id;
  }
  return null;
}

export function followed(mapper: Mapper, event: AgentEvent): RemoteEvent[] {
  return event.type === 'snapshot' ? resync(mapper, event) : mapper.event(event);
}

export function resync(mapper: Mapper, snapshot: SnapshotEvent): RemoteEvent[] {
  const last = mapper.last();
  return [
    ...snapshot.entries.filter((entry) => entry.id > last).flatMap((entry) => mapper.entry(entry)),
    ...mapper.partial(snapshot.generation?.message as never),
  ];
}

function placedEntry(value: unknown): number | undefined {
  const entry = (value as { entry?: unknown } | undefined)?.entry;
  return typeof entry === 'number' ? entry : undefined;
}

export class Follower {
  readonly #mapper: Mapper;
  readonly #entries: Map<number, EntryRecord>;
  readonly #submission: SubmissionId;
  readonly #delivered: Delivered;
  readonly #out: RemoteEvent[] = [];
  #user: number | undefined;
  #started = false;

  constructor(
    mapper: Mapper,
    entries: readonly EntryRecord[],
    submission: SubmissionId,
    delivered: Delivered,
    record: unknown
  ) {
    this.#mapper = mapper;
    this.#entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.#submission = submission;
    this.#delivered = delivered;
    this.#user = placedEntry(record);
  }

  drain(): RemoteEvent[] {
    return this.#out.splice(0);
  }

  #begin(): void {
    const entry = this.#user === undefined ? undefined : this.#entries.get(this.#user);
    if (!entry) return;
    this.#started = true;
    this.#out.push(...this.#mapper.entry(entry, this.#delivered));
  }

  #end(reason: EndReason, message?: string): true {
    this.#out.push({ t: 'end', reason, ...(message ? { message } : {}) });
    return true;
  }

  #ours(event: AgentEvent): boolean {
    if (event.type !== 'submission' || event.record.id !== this.#submission) return false;
    this.#user = placedEntry(event.record) ?? this.#user;
    return this.#user === undefined && !['queued', 'placed'].includes(event.record.status);
  }

  take(batch: readonly AgentEvent[]): boolean {
    for (const event of batch) {
      if (event.type === 'message_end') this.#entries.set(event.entry.id, event.entry);
      if (this.#ours(event)) return this.#end('aborted');
      if (!this.#started) {
        this.#begin();
        continue;
      }
      const mapped = this.#mapper.event(event).filter((item) => item.t !== 'user');
      this.#out.push(...mapped);
      if (mapped.some((item) => item.t === 'run' && item.state === 'end'))
        return this.#end(this.#mapper.reason, this.#mapper.error);
    }
    return false;
  }
}

export function createRemote(host: RemoteHost): AgentRemote & { dispose(): Promise<void> } {
  const now = host.now ?? Date.now;
  const streams = new Map<string, Stream>();
  let serial = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const sweep = () => {
    for (const [id, stream] of streams)
      if (now() - stream.touched > IDLE_MS) {
        streams.delete(id);
        void stream.finish();
      }
    if (!streams.size && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const track = (id: string, stream: Stream) => {
    streams.set(id, stream);
    timer ??= setInterval(sweep, host.sweepMs ?? IDLE_MS / 4);
  };
  const watching = async (agentId: string | null, context: Context) => {
    const conversation = await host.conversation(agentId, context);
    const cancel = withCancel(BACKGROUND_CONTEXT);
    const events: AgentEventStream = await watchEvents(
      host.harness,
      conversation.id,
      cancel.context
    );
    const open = (onEvents: (batch: readonly AgentEvent[]) => void) => {
      const stream = new Stream<RemoteEvent>(
        async () => {
          await events.stop();
          cancel.cancel();
        },
        now(),
        host.limit ?? MAX_QUEUED,
        [{ t: 'end', reason: 'error', message: 'the stream fell too far behind' }]
      );
      const id = `s${++serial}-${crypto.randomUUID()}`;
      track(id, stream);
      events.start(async (batch) => onEvents(batch));
      return { id, stream };
    };
    return { conversation, snapshot: events.snapshot, open, stop: () => events.stop() };
  };
  return {
    async prompt(request, context) {
      sweep();
      const watched = await watching(request.agentId, context);
      const busy = Boolean(watched.snapshot.run);
      const response = await host.send(
        {
          text: request.text,
          whenBusy: request.whenBusy,
          requestId: null,
          ...(request.agentId ? { agentId: request.agentId } : {}),
        },
        context
      );
      if (!response.accepted) {
        await watched.stop();
        return {
          ok: false,
          code: response.error.code === 'busy' ? 'EBUSY' : 'EIO',
          message: response.error.message,
        };
      }
      const submission = Number(response.submissionId) as SubmissionId;
      const record = await (await host.harness.submission(submission, context))?.status(context);
      const delivered = deliveredOf(record, request.whenBusy, busy);
      const follower = new Follower(
        new Mapper(request.thinking),
        watched.snapshot.entries,
        submission,
        delivered,
        record
      );
      const { id, stream } = watched.open((batch) => {
        const ended = follower.take(batch);
        stream.push(follower.drain());
        if (ended) void stream.finish();
      });
      return { ok: true, stream: id, delivered, head: null, gap: false };
    },
    async watch(request, context) {
      sweep();
      const watched = await watching(request.agentId, context);
      const partial = watched.snapshot.generation?.message as never;
      const all = replayOf(watched.snapshot.entries, partial, request.thinking);
      const head = headOf(all);
      const at = request.since === null ? -1 : all.findIndex((e) => idOf(e) === request.since);
      const gap = request.since !== null && at < 0;
      const mapper = new Mapper(request.thinking);
      for (const entry of watched.snapshot.entries) mapper.entry(entry);
      mapper.partial(partial);
      const { id, stream } = watched.open((batch) =>
        stream.push(batch.flatMap((event) => followed(mapper, event)))
      );
      if (at >= 0) {
        const own = all[at] as RemoteEvent;
        const sinceId = idOf(own);
        let last = at;
        while (last + 1 < all.length && idOf(all[last + 1] as RemoteEvent) === sinceId) last++;
        const replay = own.t === 'text' || own.t === 'thinking' ? [own] : [];
        stream.push([...replay, ...all.slice(last + 1)]);
      }
      return { ok: true, stream: id, delivered: null, head, gap };
    },
    async next(id, waitMs, context) {
      const stream = streams.get(id);
      if (!stream) return { events: [], done: true };
      stream.touched = now();
      await stream.wait(Math.max(0, Math.min(waitMs, 30000)));
      context.abortSignal?.throwIfAborted();
      const events = stream.queue.splice(0);
      const done = stream.done && stream.queue.length === 0;
      if (done) streams.delete(id);
      return { events, done };
    },
    async close(id) {
      const stream = streams.get(id);
      streams.delete(id);
      await stream?.finish();
    },
    async abort(agentId, context) {
      const conversation = await host.conversation(agentId, context);
      const watched = await watchEvents(host.harness, conversation.id, context);
      const busy = Boolean(watched.snapshot.run);
      await watched.stop();
      if (busy) await conversation.abort(context);
      return { aborted: busy };
    },
    async dispose() {
      clearInterval(timer);
      timer = undefined;
      const all = [...streams.values()];
      streams.clear();
      await Promise.all(all.map((stream) => stream.finish()));
    },
  };
}
