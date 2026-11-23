import type { Attachment } from './attachment.ts';
import type { WebhookDelivery } from './sources.ts';

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

function objectOf(text: string): Json | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isOccurrence = (json: Json) => isText(json.eventId) && isText(json.name) && 'data' in json;

export function headerOf(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1] || undefined;
}

function headersOf(value: unknown): { headers?: Record<string, string> } {
  const kept = Object.entries(asObject(value) ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return kept.length ? { headers: Object.fromEntries(kept) } : {};
}

function attachmentOf(value: unknown): { attachment?: Attachment } {
  if (typeof value !== 'object' || value === null) return {};
  const { name, size, url } = value as Json;
  if (!isText(url)) return {};
  return {
    attachment: {
      url,
      ...(isText(name) ? { name } : {}),
      ...(typeof size === 'number' && Number.isFinite(size) ? { size } : {}),
    },
  };
}

function ntfy(json: Json): WebhookDelivery {
  const message = typeof json.message === 'string' ? json.message : '';
  const rest = {
    ...attachmentOf(json.attachment),
    ...(json.verified === false ? { verified: false } : {}),
  };
  const event = objectOf(message);
  if (event && isOccurrence(event))
    return { id: `mcp:${event.eventId}`, body: event.data, ...rest };
  const headers = headersOf(json.headers);
  const delivered = headerOf(headers.headers, 'webhook-id');
  return {
    id: delivered ? `webhook:${delivered}` : `ntfy:${json.topic}/${json.id}`,
    ...headers,
    body: message,
    ...rest,
  };
}

export function webhookDelivery(text: string): WebhookDelivery {
  const json = objectOf(text);
  if (json && isText(json.id) && isText(json.topic)) return ntfy(json);
  if (json && isOccurrence(json)) return { id: `mcp:${json.eventId}`, body: json.data };
  return { body: text };
}

const CONTROL = new Set(['gap', 'terminated', 'verification']);

export function envelopeOf(delivery: WebhookDelivery): Json | undefined {
  const body =
    typeof delivery.body === 'string' ? objectOf(delivery.body) : asObject(delivery.body);
  if (typeof body?.type !== 'string' || !CONTROL.has(body.type)) return undefined;
  const { headers } = delivery;
  const mcp =
    headerOf(headers, 'x-mcp-subscription-id') ||
    headerOf(headers, 'webhook-id')?.startsWith(`msg_${body.type}_`);
  return mcp ? body : undefined;
}
