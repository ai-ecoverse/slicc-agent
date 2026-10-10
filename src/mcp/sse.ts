import {
  type JsonRpcMessage,
  parseJsonRpcMessage,
  StreamableHttpTransport,
} from '@earendil-works/pi-mcp';
import { MCP_SSE_PATCH } from '../patches.ts';

const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const patched = Symbol.for('slicc.agent.mcp-sse');

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export interface SseOptions {
  maxEventBytes?: number;
  onEvent(event: SseEvent): void;
  onId?(id: string): void;
  onRetry?(ms: number): void;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

export function sseField(raw: string): [string, string] | undefined {
  const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (text === '') return ['', ''];
  if (text.startsWith(':')) return undefined;
  const colon = text.indexOf(':');
  if (colon < 0) return [text, ''];
  const rest = text.slice(colon + 1);
  return [text.slice(0, colon), rest.startsWith(' ') ? rest.slice(1) : rest];
}

export async function readSse(
  stream: ReadableStream<Uint8Array>,
  options: SseOptions
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const max = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  let buffered = '';
  let name: string | undefined;
  let id: string | undefined;
  let lines: string[] = [];
  let size = 0;
  const dispatch = () => {
    if (lines.length)
      options.onEvent({
        ...(name ? { event: name } : {}),
        data: lines.join('\n'),
        ...(id ? { id } : {}),
      });
    name = undefined;
    id = undefined;
    lines = [];
    size = 0;
  };
  const line = (raw: string) => {
    const parsed = sseField(raw);
    if (!parsed) return;
    const [field, value] = parsed;
    if (field === '') return dispatch();
    if (field === 'data') {
      size += bytes(value) + (lines.length ? 1 : 0);
      if (size > max) throw new Error(`MCP SSE event exceeds ${max} bytes`);
      lines.push(value);
    } else if (field === 'event') name = value;
    else if (field === 'id' && !value.includes('\0')) {
      id = value;
      options.onId?.(value);
    } else if (field === 'retry' && /^\d+$/.test(value)) options.onRetry?.(Number(value));
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        line(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
      }
      if (bytes(buffered) > max) throw new Error(`MCP SSE event exceeds ${max} bytes`);
    }
    buffered += decoder.decode();
    if (buffered) line(buffered);
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

interface Cursor {
  lastEventId?: string;
  retryMs?: number;
  received: boolean;
}

interface Internals {
  options: { maxMessageBytes?: number };
  emitError(error: unknown): void;
  emitMessage(message: JsonRpcMessage): void;
}

type Consume = (
  this: Internals,
  stream: ReadableStream<Uint8Array>,
  cursor: Cursor,
  onMessage?: (message: JsonRpcMessage) => void
) => Promise<void>;

export function patchSse(target: { prototype: object } = StreamableHttpTransport): void {
  const proto = target.prototype as { consumeSse?: Consume; [patched]?: true };
  if (proto[patched]) return;
  const original = proto.consumeSse;
  if (typeof original !== 'function' || !String(original).includes('consumeSseStream(stream')) {
    throw new Error(
      `${MCP_SSE_PATCH}: StreamableHttpTransport.prototype.consumeSse no longer calls consumeSseStream(stream, …); revisit patches.json`
    );
  }
  proto.consumeSse = async function consumeSse(stream, cursor, onMessage) {
    await readSse(stream, {
      maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_EVENT_BYTES,
      onId: (id) => {
        cursor.lastEventId = id;
      },
      onRetry: (ms) => {
        cursor.retryMs = ms;
      },
      onEvent: (event) => {
        cursor.received = true;
        if (!event.data.trim() || (event.event !== undefined && event.event !== 'message')) return;
        let message: JsonRpcMessage;
        try {
          message = parseJsonRpcMessage(JSON.parse(event.data));
        } catch (error) {
          this.emitError(error);
          return;
        }
        onMessage?.(message);
        this.emitMessage(message);
      },
    });
  };
  proto[patched] = true;
}
