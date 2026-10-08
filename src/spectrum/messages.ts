import type {
  AssistantMessage,
  AssistantStatus,
  ErrorAction,
  LickMessage,
  Message,
  MessagePart,
  SystemMessage,
  ToolCall,
  ToolStatus,
  Usage,
  UserMessage,
} from '@ai-ecoverse/slicc-spectrum/ui';
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable';
import { parseLick } from '../licks/lick.ts';
import { entryLick, LICK_TOOLS, type LickDecision, lickDecisions } from '../licks/state.ts';
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
  details?: { patch?: unknown };
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

interface Replacement {
  oldText?: string;
  newText?: string;
}

const GAP = '…';

function seconds(value: unknown): string | undefined {
  return typeof value === 'number' ? `timeout ${value}s` : undefined;
}

function lines(args: Json): string | undefined {
  const { offset, limit } = args as { offset?: number; limit?: number };
  if (typeof offset === 'number' && typeof limit === 'number')
    return `lines ${offset}–${offset + limit - 1}`;
  if (typeof offset === 'number') return `from line ${offset}`;
  return typeof limit === 'number' ? `first ${limit} lines` : undefined;
}

function edits(args: Json): ToolCall['diff'] {
  const list = Array.isArray(args.edits) ? (args.edits as Replacement[]) : [];
  if (list.length === 0) return undefined;
  return {
    before: list.map((edit) => edit.oldText ?? '').join(`\n${GAP}\n`),
    after: list.map((edit) => edit.newText ?? '').join(`\n${GAP}\n`),
  };
}

export function fromPatch(patch: string): ToolCall['diff'] {
  const before: string[] = [];
  const after: string[] = [];
  let hunks = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      if (hunks++ > 0) {
        before.push(GAP);
        after.push(GAP);
      }
      continue;
    }
    if (hunks === 0 || line === '' || line.startsWith('\\')) continue;
    const text = line.slice(1);
    if (line.startsWith('-')) before.push(text);
    else if (line.startsWith('+')) after.push(text);
    else {
      before.push(text);
      after.push(text);
    }
  }
  return hunks ? { before: before.join('\n'), after: after.join('\n') } : undefined;
}

function shape(name: string, args: Json): Pick<ToolCall, 'input' | 'meta' | 'diff'> {
  const path = typeof args.path === 'string' ? args.path : '';
  const meta = name === 'bash' ? seconds(args.timeout) : name === 'read' ? lines(args) : undefined;
  const base = meta ? { meta } : {};
  if (name === 'bash' && typeof args.command === 'string') return { input: args.command, ...base };
  if (name === 'read' || name === 'write') return { input: path, ...base };
  if (name === 'edit') {
    const diff = edits(args);
    return { input: path, ...(diff ? { diff } : {}) };
  }
  return { input: JSON.stringify(args, null, 2) };
}

function toolCall(block: Block): ToolCall {
  const args = block.arguments ?? {};
  return {
    id: block.id ?? '',
    name: block.name ?? 'tool',
    title: title(block.arguments),
    ...shape(block.name ?? 'tool', args),
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
const unavailable =
  /access|invalid|not found|identifier|unsupported|not supported|isn['’]t supported|not available|isn['’]t available/i;

const providerNames: Record<string, string> = { 'amazon-bedrock': 'Bedrock' };
const filtered =
  /Provider (?:stopped with|finish_reason): (?:content_filter(?:ed)?|guardrail_intervened|sensitive)|refused to complete the request/i;
const missing = /no api key|missing|not configured|no credentials/i;

export function errorPart(error: string, provider?: string): MessagePart {
  const action = errorAction(error);
  if (action === 'drop-turn') {
    return {
      type: 'error',
      message: "The model's content filter stopped this reply.",
      detail: error,
      action,
    };
  }
  if (action === 'settings' && provider === 'adobe') {
    return {
      type: 'error',
      message: 'Your Adobe session has expired.',
      detail: error,
      action: 'login',
    };
  }
  const name = providerNames[provider ?? ''] ?? 'The provider';
  const lead =
    action === 'settings'
      ? missing.test(error)
        ? `${name} needs an API key.`
        : `${name} rejected the API key.`
      : action === 'change-model'
        ? "This model isn't available with the current account."
        : null;
  return lead
    ? { type: 'error', message: lead, detail: error, action }
    : { type: 'error', message: error, action };
}

export function errorAction(message: string): ErrorAction {
  if (filtered.test(message)) return 'drop-turn';
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
  if (message.errorMessage) parts.push(errorPart(message.errorMessage, message.provider));
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

function lickMessage(
  id: string,
  entry: EntryRecord,
  decisions: ReadonlyMap<string, LickDecision>
): LickMessage | undefined {
  const lick = entryLick(entry);
  if (!lick) return undefined;
  const state = lick.actions?.length ? (decisions.get(lick.id) ?? 'pending') : undefined;
  return {
    id,
    role: 'lick',
    channel: lick.channel,
    title: lick.title,
    text: lick.text,
    createdAt: lick.at,
    ...(lick.body ? { body: lick.body } : {}),
    ...(lick.count > 1 ? { count: lick.count } : {}),
    ...(state ? { state } : {}),
    ...(lick.severity ? { severity: lick.severity } : {}),
  };
}

function withoutLickTools(message: AssistantMessage): AssistantMessage {
  const parts = message.parts.filter((item) => item.type !== 'tool' || !LICK_TOOLS[item.tool.name]);
  return parts.length === message.parts.length ? message : { ...message, parts };
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
  const patch = result.details?.patch;
  const diff = typeof patch === 'string' ? fromPatch(patch) : undefined;
  if (diff) call.diff = diff;
  else if (result.isError) delete call.diff;
}

function rewound(id: string, entry: EntryRecord): SystemMessage {
  const data = (entry.data ?? {}) as { stopped?: string[]; restored?: string[] };
  const notes = [
    'Its prompt is back in the composer.',
    ...(data.stopped?.length
      ? [`Stopped ${data.stopped.map((name) => `scoop ${name}`).join(', ')}.`]
      : []),
    ...(data.restored?.length
      ? [`Restored ${data.restored.map((name) => `scoop ${name}`).join(', ')}.`]
      : []),
  ];
  return {
    id,
    role: 'system',
    kind: 'notice',
    title: 'Rewound 1 turn',
    text: notes.join(' '),
    createdAt: 0,
  };
}

function entryMessage(
  entry: EntryRecord,
  out: Message[],
  calls: Map<string, ToolCall>,
  delivered: Delivered | undefined,
  decisions: ReadonlyMap<string, LickDecision>
): void {
  const id = `e${entry.id}`;
  const model = entry.model?.[0] as ModelMessage | undefined;
  if (entry.kind === 'slicc.rewound') out.push(rewound(id, entry));
  else if (entry.kind === 'pi.user' && model)
    out.push(lickMessage(id, entry, decisions) ?? user(id, model, delivered));
  else if (entry.kind === 'pi.assistant' && model) {
    const message = assistant(id, model);
    out.push(withoutLickTools(message));
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
  const decisions = lickDecisions(view.entries);
  let previous: EntryRecord | undefined;
  for (const entry of view.entries) {
    const steered = previous?.kind === 'pi.tool-result' ? 'steer' : undefined;
    entryMessage(entry, out, calls, deliveries[String(entry.id)] ?? steered, decisions);
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
    .filter((item) => item.mode !== 'write' && !parseLick(textOf(item.content)))
    .map((item) => ({
      id: `q${item.id}`,
      role: 'user',
      text: textOf(item.content),
      createdAt: 0,
      queued: true,
      mode: item.mode === 'steer' ? 'steer' : 'queue',
    }));
}
