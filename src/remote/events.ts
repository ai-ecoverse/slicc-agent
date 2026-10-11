import type { AgentEvent, EntryRecord } from '@earendil-works/pi-durable';
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
  #current: string | undefined;
  #previous: string | undefined;
  #ending: readonly number[] = [];
  readonly #stamps = new Map<number, number[]>();
  reason: EndReason = 'stop';
  error: string | undefined;

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

  #delivered(entry: EntryRecord): Delivered {
    if (entry.byTaskId === undefined) return 'run';
    return this.#previous === 'pi.tool-result' ? 'steer' : 'follow-up';
  }

  entry(entry: EntryRecord, delivered: Delivered = this.#delivered(entry)): RemoteEvent[] {
    if (this.#seen.has(entry.id)) return [];
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

  #ended(reason: EndReason): RemoteEvent[] {
    if (!this.#ending.length) return [];
    this.#ending = [];
    this.reason = reason;
    return [{ t: 'run', state: 'end', reason }];
  }

  #settled(record: { id: number; status: string; reason?: unknown }): RemoteEvent[] {
    if (!this.#ending.includes(record.id) || ['queued', 'placed'].includes(record.status))
      return [];
    if (record.status !== 'unanswered') return this.#ended(this.reason);
    if (record.reason === 'aborted') return this.#ended('aborted');
    this.error ??= clip(String(record.reason ?? 'error'), 1000);
    return this.#ended('error');
  }

  last(): number {
    return Math.max(0, ...this.#seen);
  }

  event(event: AgentEvent): RemoteEvent[] {
    switch (event.type) {
      case 'run_start': {
        const ended = this.#ended(this.reason);
        this.reason = 'stop';
        this.error = undefined;
        return [...ended, { t: 'run', state: 'start' }];
      }
      case 'run_end':
        this.#ending = event.inputs;
        return [];
      case 'submission':
        return this.#settled(event.record);
      case 'message_start':
        if ((event.message as ModelMessage).role === 'assistant')
          this.#current = this.#key(event.message as ModelMessage);
        return [];
      case 'message_update':
        return event.changes.flatMap((change) => {
          if (change.type !== 'text_delta' && change.type !== 'thinking_delta') return [];
          const id = `${this.#current}.${change.contentIndex}`;
          const t = change.type === 'text_delta' ? 'text' : 'thinking';
          const done = this.#emitted.get(id) ?? 0;
          if (t === 'thinking' && !this.#thinking) return [];
          this.#emitted.set(id, done + change.delta.length);
          return [{ t, id, delta: change.delta }];
        });
      case 'message_end':
        return this.entry(event.entry);
      case 'tool_execution_end':
        return event.entry
          ? this.entry(event.entry)
          : [
              {
                t: 'tool-result',
                id: `x${event.toolCallId}`,
                call: event.toolCallId,
                ok: false,
                summary: 'the tool did not finish',
              },
            ];
      case 'auto_retry_start':
        return [
          {
            t: 'notice',
            id: `retry-${event.at}`,
            text: clip(`retrying (attempt ${event.attempt}): ${event.errorMessage}`),
          },
        ];
      case 'compaction_start':
        return [{ t: 'notice', id: `compaction-${event.taskId}`, text: 'compacting' }];
      case 'task_failed':
        return [{ t: 'error', id: `task-${event.taskId}`, message: clip(event.message, 1000) }];
      default:
        return [];
    }
  }
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
