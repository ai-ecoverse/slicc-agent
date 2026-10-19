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
import { splitUser } from '../attachments.ts';
import {
  ASKED_KIND,
  askedLine,
  GUEST_INPUT_KIND,
  type GuestAsked,
  type GuestInput,
  type GuestOutcome,
  type GuestReviewed,
  guestText,
  REVIEWED_KIND,
} from '../guests/attribution.ts';
import { parseLick } from '../licks/lick.ts';
import { entryLick, LICK_TOOLS, type LickDecision, lickDecisions } from '../licks/state.ts';
import { mcpLabel } from '../mcp/label.ts';
import { FROM_KIND, type From } from '../scoops/from.ts';
import type { SecretName } from '../secrets/names.ts';
import { listedLine, SECRETS_KIND } from '../secrets/view.ts';
import type { Delivered } from '../services.ts';
import { SPRINKLE_KIND } from '../sprinkles/kind.ts';
import { warn } from './attempt.ts';

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
    title: mcpLabel(block.name ?? '') ?? title(block.arguments),
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

const providerNames: Record<string, string> = { 'amazon-bedrock': 'Bedrock', adobe: 'Adobe' };
const filtered =
  /Provider (?:stopped with|finish_reason): (?:content_filter(?:ed)?|guardrail_intervened|sensitive)|content[_ ]filter(?:ed|ing)?\b|guardrail[_ ]intervened/i;
const refused =
  /refused to complete the request|Provider (?:stopped with|finish_reason): refusal|\bstop_?reason\W+refusal\b/i;
const unconnected = /no api key|not configured|no credentials/i;
const missing = /missing/i;
const adobeAuth =
  /\b401\b|authenticat|unauthori[sz]ed|expired|invalid[_ ]?(?:token|credentials?|api[_ ]key)|token verification/i;

function proxyRefusal(error: string): { message: string; detail: string } {
  try {
    const body = JSON.parse(error.match(/\{.*\}/s)?.[0] ?? '') as {
      error?: { type?: unknown; message?: unknown };
    };
    const { type, message } = body.error ?? {};
    const status = error.match(/^\s*(\d{3})\b/)?.[1];
    return {
      message: typeof message === 'string' ? message : error,
      detail: typeof type === 'string' ? [status, type].filter(Boolean).join(' ') : error,
    };
  } catch {
    return { message: error, detail: error };
  }
}

export const CONNECT_IT = 'Connect it in Settings › Accounts.';
export const LOG_IN_AGAIN = 'Log in again to continue.';

const logged = new Set<string>();

function logOnce(error: string): void {
  if (logged.has(error)) return;
  logged.add(error);
  warn(`slicc-agent: the Adobe session expired: ${error}`);
}

export function providerName(provider: string | undefined, fallback = 'The provider'): string {
  return providerNames[provider ?? ''] ?? fallback;
}

export function errorPart(error: string, provider?: string): MessagePart {
  const action = errorAction(error);
  if (action === 'drop-turn') {
    return {
      type: 'error',
      message: filtered.test(error)
        ? "The model's content filter stopped this reply."
        : 'The model refused to answer this turn.',
      detail: error,
      action,
    };
  }
  const name = providerName(provider);
  const account = provider ? { account: provider } : {};
  if (unconnected.test(error))
    return {
      type: 'error',
      message: `${name} isn't connected.`,
      detail: CONNECT_IT,
      action: 'settings',
      ...account,
    };
  if (action === 'settings' && provider === 'adobe') {
    if (!adobeAuth.test(error)) return { type: 'error', ...proxyRefusal(error), action: 'retry' };
    logOnce(error);
    return {
      type: 'error',
      message: 'Your Adobe session has expired.',
      detail: LOG_IN_AGAIN,
      action: 'login',
      ...account,
    };
  }
  if (action === 'settings') {
    const lead = missing.test(error)
      ? `${name} needs an API key.`
      : `${name} rejected the API key.`;
    return { type: 'error', message: lead, detail: error, action, ...account };
  }
  return action === 'change-model'
    ? {
        type: 'error',
        message: "This model isn't available with the current account.",
        detail: error,
        action,
      }
    : { type: 'error', message: error, action };
}

export function errorAction(message: string): ErrorAction {
  if (filtered.test(message) || refused.test(message)) return 'drop-turn';
  if (credentials.test(message)) return 'settings';
  if (models.test(message) && unavailable.test(message)) return 'change-model';
  return 'retry';
}

function sprinkleMessage(id: string, entry: EntryRecord): AssistantMessage {
  const data = (entry.data ?? {}) as { sprinkle?: unknown; at?: unknown };
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'sprinkle', sprinkle: String(data.sprinkle ?? '') }],
    status: 'done',
    createdAt: typeof data.at === 'number' ? data.at : 0,
  };
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

function user(
  id: string,
  message: ModelMessage,
  delivered: Delivered | undefined,
  from: From | undefined
): UserMessage {
  return {
    id,
    role: 'user',
    ...shownUser(message.content, `ref:${id.slice(1)}:0`),
    createdAt: message.timestamp ?? 0,
    ...(delivered ? { delivered } : {}),
    ...(from ? { from: from.from } : {}),
    ...(from?.agent ? { origin: 'agent' as const } : {}),
  };
}

function guestUser(
  id: string,
  message: ModelMessage,
  delivered: Delivered | undefined,
  data: unknown
): UserMessage {
  const input = data as Partial<GuestInput> | undefined;
  const name = String(input?.name ?? '');
  const shown = shownUser(message.content, `ref:${id.slice(1)}:0`);
  return {
    id,
    role: 'user',
    ...shown,
    text: guestText(shown.text, name),
    createdAt: message.timestamp ?? 0,
    ...(delivered ? { delivered } : {}),
    from: name,
    origin: 'guest',
    ...(typeof input?.seat === 'string' ? { seat: input.seat } : {}),
  };
}

export function origins(entries: readonly EntryRecord[]): Map<number, From> {
  const out = new Map<number, From>();
  for (const entry of entries)
    if (entry.kind === FROM_KIND) {
      const note = entry.data as From;
      out.set(note.entry, note);
    }
  return out;
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

interface Diagnostic {
  severity: string;
  message: string;
}

interface Note {
  severity: 'error' | 'warn' | 'info';
  text: string;
}

type Card = ToolCall & { notes?: Note[] };

const RANK: Note['severity'][] = ['error', 'warn', 'info'];

const LINE = /^\[(error|warn|info)\] (.*)$/;

function rendered(diagnostics: readonly Diagnostic[]): string {
  return `<harness>\n${diagnostics.map((item) => `[${item.severity}] ${item.message}`).join('\n')}\n</harness>`;
}

function parsed(text: string): Diagnostic[] | undefined {
  const body = /^<harness>\n([\s\S]*)\n<\/harness>$/.exec(text)?.[1];
  if (body === undefined) return undefined;
  const found = body.split('\n').map((line) => LINE.exec(line));
  if (!found.every((match): match is RegExpExecArray => match !== null)) return undefined;
  return found.map(([, severity, message]) => ({ severity, message }) as Diagnostic);
}

function harness(
  content: ModelMessage['content'],
  data: unknown
): { content: ModelMessage['content']; diagnostics: Diagnostic[] } {
  const last = Array.isArray(content) ? content.at(-1) : undefined;
  const stored = (data as { diagnostics?: unknown } | undefined)?.diagnostics;
  const listed = Array.isArray(stored) ? (stored as Diagnostic[]) : parsed(last?.text ?? '');
  if (!listed?.length || last?.type !== 'text' || last.text !== rendered(listed))
    return { content, diagnostics: [] };
  return { content: (content as Block[]).slice(0, -1), diagnostics: listed };
}

const count = (value: string | undefined): string => Number(value).toLocaleString('en');

const ends: Record<string, string> = { end: ' from the start', beginning: ' from the end' };

const phrasings: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^Command exited with code (-?\d+)$/, (match) => `Exited with code ${match[1]}`],
  [/^Command timed out after (.+)$/, (match) => `Timed out after ${match[1]}`],
  [/^Command aborted$/, () => 'Aborted'],
  [/^Full output: (.+)$/, (match) => `Full output in ${match[1]}`],
  [
    /^Output truncated(?: to its (beginning|end))?: (\d+) lines, (\d+) bytes dropped$/,
    (match) =>
      `Output truncated: ${count(match[2])} lines and ${count(match[3])} bytes dropped${ends[match[1] ?? ''] ?? ''}`,
  ],
];

function phrased(message: string): string {
  const line = message
    .replace(/\n[\s\S]*$/, '')
    .trim()
    .replace(/\.$/, '');
  for (const [pattern, phrase] of phrasings) {
    const match = pattern.exec(line);
    if (match) return phrase(match);
  }
  return line;
}

function note(diagnostic: Diagnostic): Note {
  return { severity: diagnostic.severity as Note['severity'], text: phrased(diagnostic.message) };
}

function settle(calls: Map<string, ToolCall>, result: ModelMessage, data?: unknown): void {
  const call = calls.get(result.toolCallId ?? '') as Card | undefined;
  if (!call) return;
  const split = harness(result.content, data);
  call.output = textOf(split.content);
  if (split.diagnostics.length)
    call.notes = split.diagnostics
      .map(note)
      .sort((a, b) => RANK.indexOf(a.severity) - RANK.indexOf(b.severity));
  call.status = result.isError ? 'error' : 'done';
  const image = Array.isArray(result.content)
    ? (result.content as { type: string; data?: string; mimeType?: string }[]).find(
        (part) => part.type === 'image' && part.data && part.mimeType
      )
    : undefined;
  if (image) call.image = `data:${image.mimeType};base64,${image.data}`;
  const patch = result.details?.patch;
  const diff = typeof patch === 'string' ? fromPatch(patch) : undefined;
  if (diff) call.diff = diff;
  else if (result.isError) delete call.diff;
}

function rewound(id: string, entry: EntryRecord): SystemMessage {
  const data = (entry.data ?? {}) as { stopped?: string[]; restored?: string[]; files?: boolean };
  const notes = [
    'Its prompt is back in the composer.',
    ...(data.stopped?.length
      ? [`Stopped ${data.stopped.map((name) => `scoop ${name}`).join(', ')}.`]
      : []),
    ...(data.restored?.length
      ? [`Restored ${data.restored.map((name) => `scoop ${name}`).join(', ')}.`]
      : []),
    ...(data.files ? ['Changed files stay; use Changes or git to revert them.'] : []),
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

function thawed(id: string, entry: EntryRecord): SystemMessage {
  const data = (entry.data ?? {}) as { name?: string; kind?: string; v6?: boolean };
  const what = data.v6 ? 'SLICC 6' : data.kind === 'agent' ? 'agent run' : 'scoop';
  return {
    id,
    role: 'system',
    kind: 'notice',
    title: `Thawed from ${what} ${data.name ?? ''}`.trim(),
    text: textOf(entry.model?.[0]?.content ?? ''),
    createdAt: entry.model?.[0]?.timestamp ?? 0,
  };
}

export function reviewed(entries: readonly EntryRecord[]): Map<string, GuestOutcome> {
  const out = new Map<string, GuestOutcome>();
  for (const entry of entries) {
    if (entry.kind !== REVIEWED_KIND) continue;
    const data = (entry.data ?? {}) as Partial<GuestReviewed>;
    if (typeof data.review === 'string' && data.outcome) out.set(data.review, data.outcome);
  }
  return out;
}

function asked(
  id: string,
  entry: EntryRecord,
  outcomes: ReadonlyMap<string, GuestOutcome>
): SystemMessage {
  const data = (entry.data ?? {}) as Partial<GuestAsked>;
  return {
    id,
    role: 'system',
    kind: 'notice',
    text: askedLine(
      String(data.name ?? ''),
      String(data.text ?? ''),
      outcomes.get(String(data.review))
    ),
    createdAt: typeof data.at === 'number' ? data.at : 0,
  };
}

function secrets(id: string, entry: EntryRecord): SystemMessage {
  const data = (entry.data ?? {}) as { names?: SecretName[]; error?: string | null };
  return {
    id,
    role: 'system',
    kind: 'notice',
    title: data.error ? 'Secrets unavailable' : 'Secrets listed',
    text: listedLine({ names: data.names ?? [], error: data.error ?? null }),
    createdAt: entry.model?.[0]?.timestamp ?? 0,
  };
}

const V6_KINDS: Record<string, string> = {
  user: 'pi.user',
  assistant: 'pi.assistant',
  toolResult: 'pi.tool-result',
};

function entryMessage(
  entry: EntryRecord,
  out: Message[],
  calls: Map<string, ToolCall>,
  delivered: Delivered | undefined,
  notes: {
    decisions: ReadonlyMap<string, LickDecision>;
    origins: ReadonlyMap<number, From>;
    outcomes: ReadonlyMap<string, GuestOutcome>;
  }
): void {
  const id = `e${entry.id}`;
  const model = entry.model?.[0] as ModelMessage | undefined;
  if (entry.kind === 'slicc.v6' && model) {
    const kind = V6_KINDS[model.role as string];
    if (kind) entryMessage({ ...entry, kind }, out, calls, delivered, notes);
    return;
  }
  if (entry.kind === 'slicc.rewound') out.push(rewound(id, entry));
  if (entry.kind === 'slicc.thawed') out.push(thawed(id, entry));
  else if (entry.kind === SECRETS_KIND) out.push(secrets(id, entry));
  else if (entry.kind === ASKED_KIND) out.push(asked(id, entry, notes.outcomes));
  else if (entry.kind === SPRINKLE_KIND) out.push(sprinkleMessage(id, entry));
  else if (entry.kind === 'pi.user' && model)
    out.push(
      lickMessage(id, entry, notes.decisions) ??
        user(id, model, delivered, notes.origins.get(entry.id))
    );
  else if (entry.kind === GUEST_INPUT_KIND && model)
    out.push(guestUser(id, model, delivered, entry.data));
  else if (entry.kind === 'pi.assistant' && model) {
    const message = assistant(id, model);
    out.push(withoutLickTools(message));
    for (const [key, value] of tools([message])) calls.set(key, value);
  } else if (entry.kind === 'pi.tool-result' && model) settle(calls, model, entry.data);
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
  const notes = {
    decisions: lickDecisions(view.entries),
    origins: origins(view.entries),
    outcomes: reviewed(view.entries),
  };
  let previous: EntryRecord | undefined;
  for (const entry of view.entries) {
    const steered = previous?.kind === 'pi.tool-result' ? 'steer' : undefined;
    entryMessage(entry, out, calls, deliveries[String(entry.id)] ?? steered, notes);
    previous = entry;
  }
  live(view, out, calls);
  return out;
}

function shownUser(
  content: ModelMessage['content'],
  prefix?: string
): Pick<UserMessage, 'text' | 'attachments'> {
  const { text, attachments } = splitUser(content, prefix);
  return attachments.length ? { text, attachments } : { text };
}

export function isBusy(view: ConversationView | undefined): boolean {
  return Boolean((view?.docs['pi.live'] as Live | undefined)?.run);
}

export function queued(
  view: ConversationView | undefined,
  at: (id: string) => number = () => 0
): UserMessage[] {
  const items = ((view?.docs['pi.inbox'] as { items?: Json[] } | undefined)?.items ?? []) as {
    id: number;
    mode: string;
    content?: ModelMessage['content'];
    entry?: { kind?: string; data?: Partial<GuestInput> };
  }[];
  return items
    .filter((item) => item.mode !== 'write' && !parseLick(textOf(item.content)))
    .map((item) => {
      const shown = shownUser(item.content);
      const data = item.entry?.data;
      const guest = item.entry?.kind === GUEST_INPUT_KIND ? String(data?.name ?? '') : null;
      const seat = typeof data?.seat === 'string' ? { seat: data.seat } : {};
      return {
        id: `q${item.id}`,
        role: 'user' as const,
        ...shown,
        ...(guest === null
          ? {}
          : {
              text: guestText(shown.text, guest),
              from: guest,
              origin: 'guest' as const,
              ...seat,
            }),
        createdAt: at(`q${item.id}`),
        queued: true,
        mode: item.mode === 'steer' ? 'steer' : 'queue',
      };
    });
}
