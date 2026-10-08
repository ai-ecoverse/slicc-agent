import { type Lick, parseLick } from './lick.ts';

export type LickDecision = 'confirmed' | 'dismissed';

export const LICK_TOOLS: Record<string, LickDecision> = {
  lick_confirm: 'confirmed',
  lick_dismiss: 'dismissed',
};

export const LICK_STATE_KIND = 'slicc.lick-state';

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface ModelMessage {
  role?: string;
  content?: string | Block[];
  toolCallId?: string;
  isError?: boolean;
}

interface EntryLike {
  id: number;
  kind: string;
  model?: readonly unknown[];
  data?: unknown;
}

export function userText(entry: EntryLike): string | undefined {
  if (entry.kind !== 'pi.user') return undefined;
  const content = (entry.model?.[0] as ModelMessage | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}

export function entryLick(entry: EntryLike): Lick | undefined {
  const text = userText(entry);
  return text === undefined ? undefined : parseLick(text);
}

type Calls = Map<string, { lick: string; decision: LickDecision }>;

function stateEntry(entry: EntryLike, decisions: Map<string, LickDecision>): void {
  const data = entry.data as { lick?: unknown; state?: unknown } | undefined;
  if (typeof data?.lick !== 'string') return;
  if (data.state === 'confirmed' || data.state === 'dismissed')
    decisions.set(data.lick, data.state);
}

function toolCalls(message: ModelMessage | undefined, calls: Calls): void {
  if (!Array.isArray(message?.content)) return;
  for (const block of message.content) {
    const decision = LICK_TOOLS[block.name ?? ''];
    const lick = block.arguments?.lick_id;
    if (block.type === 'toolCall' && decision && typeof lick === 'string' && block.id)
      calls.set(block.id, { lick, decision });
  }
}

function toolResult(
  message: ModelMessage | undefined,
  calls: Calls,
  decisions: Map<string, LickDecision>
): void {
  if (!message || message.isError) return;
  const call = calls.get(message.toolCallId ?? '');
  if (call) decisions.set(call.lick, call.decision);
}

export function lickDecisions(entries: readonly EntryLike[]): Map<string, LickDecision> {
  const decisions = new Map<string, LickDecision>();
  const calls: Calls = new Map();
  for (const entry of entries) {
    const message = entry.model?.[0] as ModelMessage | undefined;
    if (entry.kind === LICK_STATE_KIND) stateEntry(entry, decisions);
    else if (entry.kind === 'pi.assistant') toolCalls(message, calls);
    else if (entry.kind === 'pi.tool-result') toolResult(message, calls, decisions);
  }
  return decisions;
}
