import type { EntryRecord, LiveState } from '@earendil-works/pi-durable';
import { entryLick } from '../licks/state.ts';
import { mcpLabel } from '../mcp/label.ts';
import { redactSecrets } from '../memory/format.ts';
import type { Delivered } from '../services.ts';

export const SUMMARY = 200;

export type EndReason = 'stop' | 'aborted' | 'error';

export type RemoteEvent =
  | { t: 'user'; id: string; text: string; delivered: Delivered }
  | { t: 'text'; id: string; delta: string }
  | { t: 'thinking'; id: string; delta: string }
  | { t: 'tool'; id: string; call: string; name: string; summary: string }
  | { t: 'tool-result'; id: string; call: string; ok: boolean; summary: string }
  | { t: 'run'; state: 'start' | 'end'; reason?: EndReason }
  | { t: 'notice'; id: string; text: string }
  | { t: 'error'; id: string; message: string; detail?: string }
  | { t: 'busy'; busy: boolean; why?: string[] }
  | { t: 'end'; reason: EndReason; message?: string };

type Json = Record<string, unknown>;

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Json;
}

interface ModelMessage {
  role?: string;
  content?: string | Block[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function clip(text: string, limit = SUMMARY): string {
  const flat = redactSecrets(text).text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}

const SUBJECTS = ['command', 'path', 'pattern', 'url', 'query', 'code', 'name'];

export function toolSummary(name: string, args: Json | undefined): string {
  const subject = SUBJECTS.map((key) => args?.[key]).find((value) => typeof value === 'string');
  const detail = typeof subject === 'string' ? subject : JSON.stringify(args ?? {});
  return clip(`${mcpLabel(name) ?? name} ${detail}`);
}

export function resultSummary(message: ModelMessage): string {
  const text = textOf(message.content);
  if (message.isError)
    return clip(
      text.split('\n').find((line) => line.trim() && !/^<\/?harness>$/.test(line.trim())) ??
        'failed'
    );
  const lines = text ? text.split('\n').length : 0;
  return lines === 1 ? '1 line' : `${lines} lines`;
}

export function keyOf(timestamp: number | undefined, at: number): string {
  return at > 0 ? `a${timestamp ?? 0}~${at}` : `a${timestamp ?? 0}`;
}

function reasonOf(stopReason: string | undefined): EndReason {
  if (stopReason === 'aborted') return 'aborted';
  return stopReason === 'error' ? 'error' : 'stop';
}

export class Mapper {
  readonly #thinking: boolean;
  readonly #emitted = new Map<string, number>();
  readonly #seen = new Set<number>();
  readonly #compactions = new Set<string>();
  readonly #orphans = new Set<string>();
  #current: string | undefined;
  #previous: string | undefined;
  #deliver: { id: number; delivered: Delivered } | undefined;
  #runTask: string | undefined;
  #runFirst: string | undefined;
  #retryAt: number | undefined;
  readonly #stamps = new Map<number, number[]>();
  holdUsers = false;
  reason: EndReason = 'stop';
  error: string | undefined;
  endedRun: string | undefined;
  endedFirst: string | undefined;
  endedReason: EndReason = 'stop';
  endedError: string | undefined;

  constructor(thinking: boolean) {
    this.#thinking = thinking;
  }

  #key(message: ModelMessage | undefined, entry?: number): string {
    const stamp = message?.timestamp ?? 0;
    const list = this.#stamps.get(stamp) ?? [];
    this.#stamps.set(stamp, list);
    if (entry === undefined) return keyOf(stamp, list.length);
    if (!list.includes(entry)) list.push(entry);
    return keyOf(stamp, list.indexOf(entry));
  }

  #delta(t: 'text' | 'thinking', id: string, full: string): RemoteEvent[] {
    if (t === 'thinking' && !this.#thinking) return [];
    const done = this.#emitted.get(id) ?? 0;
    if (full.length <= done) return [];
    this.#emitted.set(id, full.length);
    return [{ t, id, delta: full.slice(done) }];
  }

  partial(message: ModelMessage | undefined): RemoteEvent[] {
    if (!message || !Array.isArray(message.content)) return [];
    const key = this.#key(message);
    this.#current = key;
    return message.content.flatMap((block, at) => {
      if (block.type === 'text') return this.#delta('text', `${key}.${at}`, block.text ?? '');
      if (block.type === 'thinking')
        return this.#delta('thinking', `${key}.${at}`, block.thinking ?? '');
      return [];
    });
  }

  #assistant(message: ModelMessage, entry: EntryRecord): RemoteEvent[] {
    const key = this.#key(message, entry.id);
    const blocks = Array.isArray(message.content) ? message.content : [];
    const out = blocks.flatMap((block, at): RemoteEvent[] => {
      const id = `${key}.${at}`;
      if (block.type === 'text') return this.#delta('text', id, block.text ?? '');
      if (block.type === 'thinking') return this.#delta('thinking', id, block.thinking ?? '');
      if (block.type !== 'toolCall') return [];
      const name = block.name ?? 'tool';
      return [
        { t: 'tool', id, call: block.id ?? '', name, summary: toolSummary(name, block.arguments) },
      ];
    });
    if (typeof message.content === 'string')
      out.push(...this.#delta('text', `${key}.0`, message.content));
    this.reason = reasonOf(message.stopReason);
    this.error =
      message.stopReason === 'error' ? clip(message.errorMessage ?? 'error', 1000) : undefined;
    if (this.error) out.push({ t: 'error', id: String(entry.id), message: this.error });
    return out;
  }

  deliverAs(id: number, delivered: Delivered): void {
    this.#deliver = { id, delivered };
  }

  #delivered(entry: EntryRecord): Delivered {
    if (this.#deliver && Number(entry.id) === this.#deliver.id) return this.#deliver.delivered;
    if (entry.byTaskId === undefined) return 'run';
    return this.#previous === 'pi.tool-result' ? 'steer' : 'follow-up';
  }

  entry(entry: EntryRecord, delivered: Delivered = this.#delivered(entry)): RemoteEvent[] {
    if (this.#seen.has(entry.id)) return [];
    if (
      this.holdUsers &&
      entry.kind === 'pi.user' &&
      (this.#deliver === undefined || Number(entry.id) !== this.#deliver.id)
    )
      return [];
    this.#seen.add(entry.id);
    this.#previous = entry.kind;
    const id = String(entry.id);
    const message = entry.model?.[0] as ModelMessage | undefined;
    if (entry.kind === 'pi.user' && message) {
      const lick = entryLick(entry);
      if (lick) return [{ t: 'notice', id, text: clip(`lick ${lick.channel}: ${lick.title}`) }];
      return [{ t: 'user', id, text: redactSecrets(textOf(message.content)).text, delivered }];
    }
    if (entry.kind === 'pi.assistant' && message) return this.#assistant(message, entry);
    if (entry.kind === 'pi.tool-result' && message)
      return [
        {
          t: 'tool-result',
          id,
          call: message.toolCallId ?? '',
          ok: !message.isError,
          summary: resultSummary(message),
        },
      ];
    if (entry.kind === 'pi.compaction') return [{ t: 'notice', id, text: 'compacted' }];
    if (entry.kind === 'slicc.rewound') return [{ t: 'notice', id, text: 'rewound' }];
    return [];
  }

  last(): number {
    return Math.max(0, ...this.#seen);
  }

  see(live: LiveState | undefined): void {
    this.#project(live, false);
    const message = live?.generation?.message as ModelMessage | undefined;
    if (message) this.partial(message);
  }

  apply(
    entries: readonly EntryRecord[],
    live: LiveState | undefined
  ): { entryEvents: RemoteEvent[]; liveEvents: RemoteEvent[] } {
    const entryEvents: RemoteEvent[] = [];
    for (const entry of entries) entryEvents.push(...this.entry(entry));
    const liveEvents = this.#project(live, true);
    const message = live?.generation?.message as ModelMessage | undefined;
    if (message) liveEvents.push(...this.partial(message));
    return { entryEvents, liveEvents };
  }

  #same(nextFirst: string | undefined): boolean {
    if (this.#runFirst !== undefined && nextFirst === undefined) return false;
    if (this.#runFirst !== undefined && nextFirst !== undefined)
      return this.#runFirst === nextFirst;
    return true;
  }

  #project(live: LiveState | undefined, emit: boolean): RemoteEvent[] {
    this.endedRun = undefined;
    this.endedFirst = undefined;
    const out: RemoteEvent[] = [];
    const run = live?.run;
    const nextTask = run === undefined ? undefined : String(run.taskId);
    const nextFirst = run?.first === undefined ? undefined : String(run.first);
    if (this.#runTask !== undefined && (run === undefined || !this.#same(nextFirst))) {
      this.endedRun = this.#runTask;
      this.endedFirst = this.#runFirst ?? `task:${this.#runTask}`;
      if (emit) out.push(...this.#finish(live));
      this.#runTask = undefined;
      this.#runFirst = undefined;
    }
    if (this.#runTask === undefined && run !== undefined) {
      this.#runTask = nextTask;
      this.#runFirst = nextFirst;
      this.reason = 'stop';
      this.error = undefined;
      if (emit) out.push({ t: 'run', state: 'start' });
    } else if (run !== undefined) {
      this.#runTask = nextTask;
      if (nextFirst !== undefined) this.#runFirst = nextFirst;
    }
    out.push(
      ...this.#retries(live, emit),
      ...this.#compactionsOf(live, emit),
      ...this.#orphansOf(live, emit)
    );
    return out;
  }

  #finish(live: LiveState | undefined): RemoteEvent[] {
    const ended = this.endedRun ?? '';
    const failure = live?.runFailure;
    const matched = failure !== undefined && String(failure.taskId) === ended;
    if (matched && failure.reason === 'aborted') {
      this.reason = 'aborted';
      this.endedReason = 'aborted';
      this.endedError = undefined;
      return [{ t: 'run', state: 'end', reason: 'aborted' }];
    }
    if (matched) {
      this.reason = 'error';
      this.error = clip(failure.detail ?? failure.reason, 1000);
      this.endedReason = 'error';
      this.endedError = this.error;
      return [
        { t: 'error', id: `run-${ended}`, message: this.error },
        { t: 'run', state: 'end', reason: 'error' },
      ];
    }
    this.endedReason = this.reason;
    this.endedError = this.error;
    return [{ t: 'run', state: 'end', reason: this.reason }];
  }

  #retries(live: LiveState | undefined, emit: boolean): RemoteEvent[] {
    const retry = live?.generation?.retry;
    if (retry === undefined) {
      this.#retryAt = undefined;
      return [];
    }
    if (retry.at === this.#retryAt) return [];
    this.#retryAt = retry.at;
    if (!emit) return [];
    const attempt = live?.generation?.attempt ?? 1;
    return [
      {
        t: 'notice',
        id: `retry-${retry.at}`,
        text: clip(`retrying (attempt ${attempt}): ${retry.error}`),
      },
    ];
  }

  #compactionsOf(live: LiveState | undefined, emit: boolean): RemoteEvent[] {
    const out: RemoteEvent[] = [];
    for (const compaction of live?.compactions ?? []) {
      const id = String(compaction.taskId);
      if (this.#compactions.has(id)) continue;
      this.#compactions.add(id);
      if (emit) out.push({ t: 'notice', id: `compaction-${id}`, text: 'compacting' });
    }
    return out;
  }

  #orphansOf(live: LiveState | undefined, emit: boolean): RemoteEvent[] {
    const out: RemoteEvent[] = [];
    for (const slot of live?.tools ?? []) {
      if (slot.status !== 'done' || slot.entry !== undefined || this.#orphans.has(slot.callId))
        continue;
      this.#orphans.add(slot.callId);
      if (!emit) continue;
      out.push({
        t: 'tool-result',
        id: `x${slot.callId}`,
        call: slot.callId,
        ok: false,
        summary: 'the tool did not finish',
      });
    }
    return out;
  }
}

export function arrange(
  entryEvents: readonly RemoteEvent[],
  liveEvents: readonly RemoteEvent[],
  userId?: string
): RemoteEvent[] {
  const own =
    userId === undefined
      ? []
      : entryEvents.filter((event) => event.t === 'user' && event.id === userId);
  const entries =
    userId === undefined ? [...entryEvents] : entryEvents.filter((event) => event.t !== 'user');
  const start = liveEvents.findIndex((event) => event.t === 'run' && event.state === 'start');
  if (start < 0) return [...own, ...entries, ...liveEvents];
  return [...own, ...liveEvents.slice(0, start + 1), ...entries, ...liveEvents.slice(start + 1)];
}

export function replayOf(
  entries: readonly EntryRecord[],
  partial: ModelMessage | undefined,
  thinking: boolean
): RemoteEvent[] {
  const mapper = new Mapper(thinking);
  const out: RemoteEvent[] = [];
  for (const entry of entries) out.push(...mapper.entry(entry));
  out.push(...mapper.partial(partial));
  return out;
}

export function idOf(event: RemoteEvent): string | undefined {
  return 'id' in event ? event.id : undefined;
}
