import type { ConversationView } from '@earendil-works/pi-durable';
import type { ModelChoice } from './services.ts';

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

interface Measured {
  role?: string;
  stopReason?: string;
  usage?: Usage;
  content?: string | readonly Block[];
  sections?: Record<string, string | null>;
}

const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

function tokensOf(usage: Usage | undefined): number {
  if (!usage) return 0;
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  return usage.totalTokens || parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

function valid(message: Measured): boolean {
  return (
    message.role === 'assistant' &&
    message.stopReason !== 'aborted' &&
    message.stopReason !== 'error' &&
    tokensOf(message.usage) > 0
  );
}

function blockChars(block: Block): number {
  if (block.type === 'text') return block.text?.length ?? 0;
  if (block.type === 'thinking') return block.thinking?.length ?? 0;
  if (block.type === 'image') return IMAGE_CHARS;
  return (block.name?.length ?? 0) + (JSON.stringify(block.arguments) ?? '').length;
}

function estimate(message: Measured): number {
  const content = message.content ?? '';
  const sections = Object.values(message.sections ?? {}).filter((text) => text !== null);
  const chars =
    typeof content === 'string'
      ? content.length
      : content.reduce((sum, block) => sum + blockChars(block), 0);
  const extra = sections.reduce((sum, text) => sum + text.length, 0);
  return Math.ceil((chars + extra) / CHARS_PER_TOKEN);
}

export function contextTokens(view: ConversationView | undefined): number | null {
  const entries = view?.entries ?? [];
  const first = entries[0];
  const head = first?.head === undefined ? undefined : first.id;
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at] as (typeof entries)[number];
    if (head !== undefined && entry.id <= head) continue;
    const measured = ((entry.model ?? []) as readonly Measured[]).findLast(valid);
    if (measured) return tokensOf(measured.usage);
  }
  if (head === undefined) return null;
  const messages = entries.flatMap((entry) => (entry.model ?? []) as readonly Measured[]);
  return messages.reduce((sum, message) => sum + estimate(message), 0) || null;
}

export function contextRatio(
  tokens: number | null | undefined,
  model: string | null | undefined,
  models: readonly ModelChoice[]
): number | null {
  const window = models.find((choice) => choice.id === model)?.contextWindow;
  if (!tokens || !window) return null;
  return Math.min(1, tokens / window);
}
