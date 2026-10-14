import type { ConversationView } from '@earendil-works/pi-durable';
import type { ModelChoice } from './services.ts';

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface Measured {
  role?: string;
  usage?: Usage;
}

function tokensOf(usage: Usage | undefined): number {
  if (!usage) return 0;
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  return usage.totalTokens || parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

export function contextTokens(view: ConversationView | undefined): number | null {
  const entries = view?.entries ?? [];
  const first = entries[0];
  const head = first?.head === undefined ? Number.NEGATIVE_INFINITY : first.id;
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at] as (typeof entries)[number];
    if (entry.id <= head) continue;
    const messages = (entry.model ?? []) as readonly Measured[];
    const measured = messages.findLast(
      (message) => message.role === 'assistant' && tokensOf(message.usage) > 0
    );
    if (measured) return tokensOf(measured.usage);
  }
  return null;
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
