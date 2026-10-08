import type {
  AssistantMessage,
  AssistantStatus,
  ErrorAction,
  Message,
  MessagePart,
  SystemMessage,
  ToolCall,
  ToolStatus,
  Usage,
  UserMessage,
} from '@ai-ecoverse/slicc-spectrum/ui';
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable';
import type { Delivered } from '../services.ts';

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
  role: string;
  content?: string | Block[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  toolCallId?: string;
  isError?: boolean;
}

interface Slot {
  callId: string;
  status: string;
  output?: string;
}

interface Live {
  run?: unknown;
  generation?: { message?: ModelMessage; retry?: { at: number; error: string } };
  tools?: Slot[];
  compactions?: { taskId: number; reason: string }[];
}

export function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}

const paths = (args: Json | undefined): string[] =>
  typeof args?.path === 'string' ? [args.path] : [];

function title(args: Json | undefined): string {
  const subject = args?.command ?? args?.path;
  return typeof subject === 'string' ? subject : '';
}

function toolCall(block: Block): ToolCall {
  return {
    id: block.id ?? '',
    name: block.name ?? 'tool',
    title: title(block.arguments),
    input: JSON.stringify(block.arguments ?? {}),
    output: '',
    status: 'running',
    paths: paths(block.arguments),
  };
}

function part(block: Block): MessagePart | undefined {
  if (block.type === 'text') return { type: 'text', text: block.text ?? '' };
  if (block.type === 'thinking') return { type: 'thinking', text: block.thinking ?? '' };
  if (block.type === 'toolCall') return { type: 'tool', tool: toolCall(block) };
  return undefined;
}

function usage(message: ModelMessage): Usage | undefined {
  const used = message.usage;
  if (!used) return undefined;
  return {
    input: used.input ?? 0,
    output: used.output ?? 0,
    cost: used.cost?.total ?? 0,
    cacheRead: used.cacheRead ?? 0,
    cacheWrite: used.cacheWrite ?? 0,
  };
}

const statuses: Record<string, AssistantStatus> = { error: 'error', aborted: 'stopped' };

const credentials =
  /security token|unrecognizedclient|not authori[sz]ed|unauthori[sz]ed|forbidden|\b40[13]\b|api key|credential|bearer/i;
const models = /model/i;
const unavailable = /access|invalid|not found|identifier|unsupported|not available/i;

export function errorAction(message: string): ErrorAction {
  if (credentials.test(message)) return 'settings';
  if (models.test(message) && unavailable.test(message)) return 'change-model';
  return 'retry';
}

export function assistant(
  id: string,
  message: ModelMessage,
  status?: AssistantStatus
): AssistantMessage {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const parts = blocks.map(part).filter((item): item is MessagePart => item !== undefined);
  if (message.errorMessage)
    parts.push({
      type: 'error',
      message: message.errorMessage,
      action: errorAction(message.errorMessage),
    });
  const used = usage(message);
  return {
    id,
    role: 'assistant',
    parts,
    status: status ?? statuses[message.stopReason ?? ''] ?? 'done',
    createdAt: message.timestamp ?? 0,
    ...(message.provider && message.model ? { model: `${message.provider}/${message.model}` } : {}),
    ...(used ? { usage: used } : {}),
  };
}

function user(id: string, message: ModelMessage, delivered: Delivered | undefined): UserMessage {
  return {
    id,
    role: 'user',
    text: textOf(message.content),
    createdAt: message.timestamp ?? 0,
    ...(delivered ? { delivered } : {}),
  };
}

function system(id: string, entry: EntryRecord, text: string): SystemMessage {
  const reason = (entry.data as Json | undefined)?.reason as SystemMessage['trigger'] | undefined;
  return {
    id,
    role: 'system',
    kind: 'compaction',
    text,
    createdAt: 0,
    state: 'summarized',
    ...(reason ? { trigger: reason } : {}),
  };
}

function tools(messages: Message[]): Map<string, ToolCall> {
  const found = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const item of message.parts) if (item.type === 'tool') found.set(item.tool.id, item.tool);
  }
  return found;
}

function settle(calls: Map<string, ToolCall>, result: ModelMessage): void {
  const call = calls.get(result.toolCallId ?? '');
  if (!call) return;
  call.output = textOf(result.content);
  call.status = result.isError ? 'error' : 'done';
}

function entryMessage(
  entry: EntryRecord,
  out: Message[],
  calls: Map<string, ToolCall>,
  delivered: Delivered | undefined
): void {
  const id = `e${entry.id}`;
  const model = entry.model?.[0] as ModelMessage | undefined;
  if (entry.kind === 'pi.user' && model) out.push(user(id, model, delivered));
  else if (entry.kind === 'pi.assistant' && model) {
    const message = assistant(id, model);
    out.push(message);
    for (const [key, value] of tools([message])) calls.set(key, value);
  } else if (entry.kind === 'pi.tool-result' && model) settle(calls, model);
  else if (entry.kind === 'pi.compaction') out.push(system(id, entry, textOf(model?.content)));
}

const slotStatus: Record<string, ToolStatus> = {
  pending: 'running',
  running: 'running',
  done: 'done',
};

function live(view: ConversationView, out: Message[], calls: Map<string, ToolCall>): void {
  const state = view.docs['pi.live'] as Live | undefined;
  for (const slot of state?.tools ?? []) {
    const call = calls.get(slot.callId);
    if (call && call.status === 'running') {
      call.status = slotStatus[slot.status] ?? 'running';
      call.output = slot.output ?? call.output;
    }
  }
  const partial = state?.generation?.message;
  if (partial) out.push(assistant('live', partial, 'streaming'));
  for (const compaction of state?.compactions ?? []) {
    out.push({
      id: `compaction-${compaction.taskId}`,
      role: 'system',
      kind: 'compaction',
      text: '',
      createdAt: 0,
      state: 'summarizing',
      trigger: compaction.reason as SystemMessage['trigger'],
    });
  }
  const retry = state?.generation?.retry;
  if (retry)
    out.push({
      id: 'retry',
      role: 'system',
      kind: 'notice',
      text: retry.error,
      createdAt: retry.at,
    });
}

export function toMessages(
  view: ConversationView | undefined,
  deliveries: Readonly<Record<string, Delivered>> = {}
): Message[] {
  const out: Message[] = [];
  if (!view) return out;
  const calls = new Map<string, ToolCall>();
  let previous: EntryRecord | undefined;
  for (const entry of view.entries) {
    const steered = previous?.kind === 'pi.tool-result' ? 'steer' : undefined;
    entryMessage(entry, out, calls, deliveries[String(entry.id)] ?? steered);
    previous = entry;
  }
  live(view, out, calls);
  return out;
}

export function isBusy(view: ConversationView | undefined): boolean {
  return Boolean((view?.docs['pi.live'] as Live | undefined)?.run);
}

export function queued(view: ConversationView | undefined): UserMessage[] {
  const items = ((view?.docs['pi.inbox'] as { items?: Json[] } | undefined)?.items ?? []) as {
    id: number;
    mode: string;
    content?: ModelMessage['content'];
  }[];
  return items
    .filter((item) => item.mode !== 'write')
    .map((item) => ({
      id: `q${item.id}`,
      role: 'user',
      text: textOf(item.content),
      createdAt: 0,
      queued: true,
      mode: item.mode === 'steer' ? 'steer' : 'queue',
    }));
}
