import type { Budget } from './adobe.ts';

export const XAI = 'xai';
export const XAI_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
export const USAGE_TIMEOUT_MS = 8_000;
export const MAX_USAGE_BYTES = 64 * 1024;

const WEEKLY = 'USAGE_PERIOD_TYPE_WEEKLY';

type Fetch = typeof fetch;

async function capped(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function grokBudget(text: string): Budget | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const config = record(record(parsed)?.config);
  const period = record(config?.currentPeriod);
  const percent = config?.creditUsagePercent;
  if (period?.type !== WEEKLY || typeof percent !== 'number' || !Number.isFinite(percent))
    return null;
  const end = typeof period.end === 'string' ? new Date(period.end) : undefined;
  if (!end || Number.isNaN(end.getTime())) return null;
  return {
    percent: Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10,
    window: 'weekly',
    resets: end.toISOString(),
  };
}

export async function xaiUsage(
  token: string,
  {
    fetch: fetcher = (input, init) => globalThis.fetch(input, init),
    timeout = USAGE_TIMEOUT_MS,
  }: { fetch?: Fetch; timeout?: number } = {}
): Promise<Budget | null> {
  const response = await fetcher(XAI_USAGE_URL, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await capped(response, MAX_USAGE_BYTES);
  return text === null ? null : grokBudget(text);
}
