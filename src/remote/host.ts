import type { Context, ReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import {
  type Conversation,
  ConversationTranscript,
  type ConversationView,
  type EntryRecord,
  type Harness,
  InboxDoc,
  LiveDoc,
  type LiveRun,
  type LiveState,
  type SubmissionId,
  type SubmissionRecord,
} from '@earendil-works/pi-durable';
import type { SendAttachment } from '../attachments.ts';
import { holdText, type VaultState } from '../secrets/vault.ts';
import type { Delivered, SendMode, SendRequest, SendResponse } from '../services.ts';
import { watchBusy } from './busy.ts';
import {
  arrange,
  clip,
  type EndReason,
  idOf,
  Mapper,
  type RemoteEvent,
  replayOf,
} from './events.ts';
import { historyFrom, historyOf, type RemoteHistory } from './history.ts';

export const VAULT_BACK = 'the vault is answering again';

export function vaultNotices(
  vault: ReplicatedState<VaultState> | undefined,
  push: (events: RemoteEvent[]) => void
): () => void {
  if (!vault) return () => undefined;
  let shown = vault.value ? holdText(vault.value) : undefined;
  let serial = 0;
  const notice = (text: string) => push([{ t: 'notice', id: `vault-${++serial}`, text }]);
  if (shown) notice(shown);
  return vault.subscribe((value) => {
    const next = holdText(value);
    if (next === shown) return;
    shown = next;
    notice(next ?? VAULT_BACK);
  });
}

export const MAX_QUEUED = 10000;
export const IDLE_MS = 120000;

export type RemoteOpened =
  | {
      ok: true;
      stream: string;
      delivered: Delivered | null;
      head: string | null;
      gap: boolean;
      history?: string | null;
      busy?: boolean;
    }
  | { ok: false; code: string; message: string };

export interface RemoteBatch {
  events: RemoteEvent[];
  done: boolean;
}

export interface AgentRemote {
  prompt(
    request: {
      agentId: string | null;
      text: string;
      whenBusy: SendMode;
      thinking: boolean;
      attachments?: SendAttachment[];
    },
    context: Context
  ): Promise<RemoteOpened>;
  watch(
    request: { agentId: string | null; since: string | null; thinking: boolean; busy?: boolean },
    context: Context
  ): Promise<RemoteOpened>;
  history(
    request: { agentId: string | null; before: string | null; limit?: number; thinking: boolean },
    context: Context
  ): Promise<RemoteHistory>;
  next(stream: string, waitMs: number, context: Context): Promise<RemoteBatch>;
  close(stream: string, context: Context): Promise<void>;
  abort(agentId: string | null, context: Context): Promise<{ aborted: boolean }>;
}

export interface RemoteHost {
  harness: Harness;
  conversation(agentId: string | null, context: Context): Promise<Conversation>;
  send(request: SendRequest, context: Context): Promise<SendResponse>;
  vault?: ReplicatedState<VaultState>;
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

const LIVE = LiveDoc.definition.kind;
const INBOX = InboxDoc.definition.kind;
const PAGES = 40;

function liveOf(view: ConversationView): LiveState | undefined {
  return view.docs[LIVE] as LiveState | undefined;
}

function inboxOf(view: ConversationView): readonly { mode?: string }[] {
  const inbox = view.docs[INBOX] as { items?: readonly { mode?: string }[] } | undefined;
  return inbox?.items ?? [];
}

function entryId(record: SubmissionRecord | undefined): number | undefined {
  if (record && 'entry' in record && typeof record.entry === 'number') return record.entry;
  return undefined;
}

function abandoned(record: SubmissionRecord | undefined): boolean {
  return record !== undefined && record.status !== 'queued' && record.status !== 'placed';
}

function settled(record: SubmissionRecord | undefined, user: number | undefined): boolean {
  if (!record || user === undefined) return false;
  return record.status === 'done' || record.status === 'unanswered';
}

function endReason(record: SubmissionRecord | undefined, mapper: Mapper): EndReason {
  if (record?.status === 'unanswered') return record.reason === 'aborted' ? 'aborted' : 'error';
  return mapper.reason;
}

function endMessage(
  record: SubmissionRecord | undefined,
  mapper: Mapper,
  reason: EndReason
): string | undefined {
  if (reason !== 'error') return undefined;
  if (mapper.error) return mapper.error;
  if (record?.status !== 'unanswered') return 'error';
  const detail = record.detail;
  return clip(typeof detail === 'string' && detail ? detail : record.reason, 1000);
}

async function submissionOf(
  harness: Harness,
  id: SubmissionId,
  context: Context
): Promise<SubmissionRecord | undefined> {
  const submission = await harness.submission(id, context);
  return submission?.status(context);
}

async function caughtUp(
  transcript: ConversationTranscript,
  view: ConversationView,
  context: Context
): Promise<EntryRecord[]> {
  let merged = transcript.merge(view);
  for (let page = 0; page < PAGES; page++) {
    const gap = merged.items.find((item) => item.kind === 'gap');
    if (gap?.kind !== 'gap') break;
    merged = await transcript.fillGap(gap, context);
  }
  return merged.items.flatMap((item) => (item.kind === 'entry' ? [item.entry] : []));
}

async function recall(
  transcript: ConversationTranscript,
  view: ConversationView,
  since: string | null,
  thinking: boolean,
  context: Context
): Promise<{
  entries: EntryRecord[];
  events: RemoteEvent[];
  partial: RemoteEvent[];
  gap: boolean;
}> {
  let merged = transcript.merge(view);
  const partial = liveOf(view)?.generation?.message as never;
  const pack = () => {
    const entries = merged.items.flatMap((item) => (item.kind === 'entry' ? [item.entry] : []));
    return { entries, ...replayOf(entries, partial, thinking) };
  };
  let packed = pack();
  const has = () => since !== null && packed.events.some((event) => idOf(event) === since);
  for (let page = 0; page < PAGES && since !== null && !has(); page++) {
    const gap = merged.items.find((item) => item.kind === 'gap');
    if (gap?.kind === 'gap') merged = await transcript.fillGap(gap, context);
    else if (merged.items[0]?.kind === 'earlier') merged = await transcript.loadEarlier(context);
    else break;
    packed = pack();
  }
  return { ...packed, gap: since !== null && !has() };
}

function sealFolded(
  events: RemoteEvent[],
  announced: boolean,
  submission: number,
  record: SubmissionRecord | undefined,
  mapper: Mapper
): { reason: EndReason; message: string | undefined } {
  const reason = endReason(record, mapper);
  const message = endMessage(record, mapper, reason);
  if (!announced && !events.some((event) => event.t === 'run' && event.state === 'start')) {
    const at = events.findIndex((event) => event.t !== 'user');
    const start: RemoteEvent = { t: 'run', state: 'start' };
    if (at < 0) events.push(start);
    else events.splice(at, 0, start);
  }
  if (reason === 'error' && message && !events.some((event) => event.t === 'error'))
    events.push({ t: 'error', id: `run-${submission}`, message });
  events.push({ t: 'run', state: 'end', reason });
  return { reason, message };
}

export class Follower {
  readonly #mapper: Mapper;
  readonly #submission: number;
  readonly #delivered: Delivered;
  readonly #out: RemoteEvent[] = [];
  #user: number | undefined;
  #started = false;
  #announced = false;
  #oursFirst: string | undefined;

  constructor(mapper: Mapper, submission: SubmissionId, delivered: Delivered) {
    this.#mapper = mapper;
    this.#submission = Number(submission);
    this.#delivered = delivered;
  }

  drain(): RemoteEvent[] {
    return this.#out.splice(0);
  }

  #end(reason: EndReason, message?: string): true {
    this.#out.push({ t: 'end', reason, ...(message ? { message } : {}) });
    return true;
  }

  #claim(run: LiveRun | undefined): void {
    if (!run || this.#user === undefined) return;
    const task = String(run.taskId);
    const first = run.first === undefined ? undefined : String(run.first);
    const key = first ?? `task:${task}`;
    if (this.#oursFirst === `task:${task}`) {
      this.#oursFirst = key;
      return;
    }
    if (this.#oursFirst !== undefined) return;
    const owns = run.inputs.some((id) => Number(id) === this.#submission);
    if (owns || first === String(this.#user)) this.#oursFirst = key;
  }

  take(
    entries: readonly EntryRecord[],
    live: LiveState | undefined,
    record: SubmissionRecord | undefined
  ): boolean {
    const placed = entryId(record);
    if (placed !== undefined) this.#user = placed;
    if (this.#user === undefined && abandoned(record)) return this.#end('aborted');
    if (this.#user !== undefined) this.#mapper.deliverAs(this.#user, this.#delivered);
    this.#claim(live?.run);
    const mapped = this.#mapper.apply(entries, live);
    const done = settled(record, this.#user);
    const endedOurs = this.#oursFirst !== undefined && this.#mapper.endedFirst === this.#oursFirst;
    let events = arrange(
      mapped.entryEvents,
      mapped.liveEvents,
      this.#user === undefined ? undefined : String(this.#user)
    );
    if (!(endedOurs || done))
      events = events.filter((event) => event.t !== 'run' || event.state !== 'end');
    if (!this.#started) {
      if (this.#user === undefined || !entries.some((entry) => entry.id === this.#user))
        return false;
      this.#started = true;
    }
    if (events.some((event) => event.t === 'run' && event.state === 'start'))
      this.#announced = true;
    const hasEnd = events.some((event) => event.t === 'run' && event.state === 'end');
    if (this.#started && done && live?.run === undefined && !hasEnd) {
      const sealed = sealFolded(events, this.#announced, this.#submission, record, this.#mapper);
      this.#out.push(...events);
      return this.#end(sealed.reason, sealed.message);
    }
    this.#out.push(...events);
    if (hasEnd && (endedOurs || (done && live?.run === undefined)))
      return this.#end(this.#mapper.endedReason, this.#mapper.endedError);
    return false;
  }
}

type Watched = {
  conversation: Conversation;
  view: ConversationView;
  transcript: ConversationTranscript;
  open(
    onView: (view: ConversationView, context: Context) => Promise<void>,
    ended?: () => void
  ): { id: string; stream: Stream };
  stop(): Promise<void>;
};

async function attachWatch(
  host: RemoteHost,
  agentId: string | null,
  context: Context,
  now: number,
  track: (stream: Stream) => string
): Promise<Watched> {
  const conversation = await host.conversation(agentId, context);
  const cancel = withCancel(BACKGROUND_CONTEXT);
  let watch: Awaited<ReturnType<Conversation['watch']>>;
  try {
    watch = await conversation.watch(cancel.context);
  } catch (error) {
    cancel.cancel();
    throw error;
  }
  const view = watch.value;
  const transcript = new ConversationTranscript((query, limit, ctx) =>
    conversation.entries(query, limit, undefined, ctx)
  );
  const open = (
    onView: (next: ConversationView, frame: Context) => Promise<void>,
    ended?: () => void
  ) => {
    let off = () => undefined as void;
    const stream = new Stream<RemoteEvent>(
      async () => {
        off();
        ended?.();
        await watch.stop();
        cancel.cancel();
      },
      now,
      host.limit ?? MAX_QUEUED,
      [{ t: 'end', reason: 'error', message: 'the stream fell too far behind' }]
    );
    const id = track(stream);
    off = vaultNotices(host.vault, (notices) => stream.push(notices));
    watch.start(async (call, frame) => {
      if (call.kind !== 'value') return;
      try {
        await onView(call.value, frame);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'the stream failed';
        stream.push([{ t: 'end', reason: 'error', message: clip(message, 1000) }]);
        await stream.finish();
      }
    });
    return { id, stream };
  };
  return {
    conversation,
    view,
    transcript,
    open,
    stop: async () => {
      await watch.stop();
      cancel.cancel();
    },
  };
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
  const track = (stream: Stream) => {
    const id = `s${++serial}-${crypto.randomUUID()}`;
    streams.set(id, stream);
    timer ??= setInterval(sweep, host.sweepMs ?? IDLE_MS / 4);
    return id;
  };
  const watching = (agentId: string | null, context: Context) =>
    attachWatch(host, agentId, context, now(), track);
  return {
    async prompt(request, context) {
      sweep();
      const watched = await watching(request.agentId, context);
      const live = liveOf(watched.view);
      const busy = Boolean(live?.run);
      const response = await host.send(
        {
          text: request.text,
          whenBusy: request.whenBusy,
          requestId: null,
          ...(request.attachments?.length ? { attachments: request.attachments } : {}),
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
      const record = await submissionOf(host.harness, submission, context);
      const delivered = deliveredOf(record, request.whenBusy, busy);
      const mapper = new Mapper(request.thinking);
      watched.transcript.merge(watched.view);
      for (const entry of watched.view.entries) mapper.entry(entry);
      mapper.see(live);
      mapper.holdUsers = true;
      const follower = new Follower(mapper, submission, delivered);
      const { id, stream } = watched.open(async (view, frame) => {
        const status = await submissionOf(host.harness, submission, frame);
        const entries = await caughtUp(watched.transcript, view, frame);
        const ended = follower.take(entries, liveOf(view), status);
        stream.push(follower.drain());
        if (ended) await stream.finish();
      });
      return { ok: true, stream: id, delivered, head: null, gap: false };
    },
    async watch(request, context) {
      sweep();
      const watched = await watching(request.agentId, context);
      const recalled = await recall(
        watched.transcript,
        watched.view,
        request.since,
        request.thinking,
        context
      );
      const head = headOf(recalled.events);
      const at =
        request.since === null
          ? -1
          : recalled.events.findIndex((event) => idOf(event) === request.since);
      const mapper = new Mapper(request.thinking);
      for (const entry of recalled.entries) mapper.entry(entry);
      mapper.see(liveOf(watched.view));
      let sink: Stream<RemoteEvent> | undefined;
      const busy = request.busy
        ? await watchBusy(
            host.harness,
            {
              conversation: watched.conversation,
              snapshot: { run: liveOf(watched.view)?.run, inbox: inboxOf(watched.view) },
              stop: () => watched.stop(),
            },
            (events) => sink?.push(events),
            context
          ).catch(async (error) => {
            await watched.stop();
            throw error;
          })
        : undefined;
      const { id, stream } = watched.open(async (view, frame) => {
        const entries = await caughtUp(watched.transcript, view, frame);
        const mapped = mapper.apply(entries, liveOf(view));
        const events = arrange(mapped.entryEvents, mapped.liveEvents);
        stream.push(busy ? busy.gate.before(events) : events);
      }, busy?.stop);
      sink = stream;
      if (at >= 0) {
        const own = recalled.events[at] as RemoteEvent;
        const sinceId = idOf(own);
        let last = at;
        while (
          last + 1 < recalled.events.length &&
          idOf(recalled.events[last + 1] as RemoteEvent) === sinceId
        )
          last++;
        const replay = own.t === 'text' || own.t === 'thinking' ? [own] : [];
        stream.push([...replay, ...recalled.events.slice(last + 1)]);
      } else if (request.since === null) stream.push(recalled.partial);
      return {
        ok: true,
        stream: id,
        delivered: null,
        head,
        gap: recalled.gap,
        history: historyFrom(recalled.entries, watched.view.before),
        ...(busy ? { busy: busy.opened } : {}),
      };
    },
    async history(request, context) {
      const conversation = await host.conversation(request.agentId, context);
      return historyOf(conversation, request, context);
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
      const watched = await conversation.watch(context);
      const busy = Boolean(liveOf(watched.value)?.run);
      try {
        if (busy) await conversation.abort(context);
      } finally {
        await watched.stop();
      }
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
