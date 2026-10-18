import type { WebhookDelivery } from './sources.ts';

type Json = Record<string, unknown>;

function objectOf(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : undefined;
  } catch {
    return undefined;
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function headersOf(value: unknown): { headers?: Record<string, string> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const kept = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return kept.length ? { headers: Object.fromEntries(kept) } : {};
}

export function attachmentLine(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const { name, size, url } = value as Json;
  if (!isText(url)) return '';
  const bytes = typeof size === 'number' && Number.isFinite(size) ? `, ${size} bytes` : '';
  return `attachment ${isText(name) ? name : 'file'}${bytes}, not fetched: ${url}`;
}

function ntfy(json: Json): WebhookDelivery {
  const message = typeof json.message === 'string' ? json.message : '';
  return {
    id: `ntfy:${json.topic}/${json.id}`,
    ...headersOf(json.headers),
    body: [message, attachmentLine(json.attachment)].filter(Boolean).join('\n\n'),
    ...(json.verified === false ? { verified: false } : {}),
  };
}

export function webhookDelivery(text: string): WebhookDelivery {
  const json = objectOf(text);
  if (json && isText(json.id) && isText(json.topic)) return ntfy(json);
  if (json && isText(json.eventId) && isText(json.name) && 'data' in json)
    return { id: `mcp:${json.eventId}`, body: json.data };
  return { body: text };
}
